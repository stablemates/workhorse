using System.Collections.Immutable;
using System.Reflection.Metadata;

namespace Workhorse.ApiSnapshot;

/// <summary>A type as a signature states it, before the tool applies nullability.</summary>
internal abstract record SignatureType;

internal sealed record PrimitiveSignatureType(PrimitiveTypeCode Code) : SignatureType;

/// <summary>
/// A type definition or reference. <see cref="Names"/> holds the declaring types first, and each
/// name keeps its CLR arity suffix, such as <c>Dictionary`2</c>.
/// </summary>
internal sealed record NamedSignatureType(string Namespace, ImmutableArray<string> Names, bool IsValueType)
    : SignatureType
{
    public bool Is(string ns, string name) =>
        Names.Length == 1 && Namespace == ns && Names[0] == name;
}

internal sealed record GenericSignatureType(NamedSignatureType Definition, ImmutableArray<SignatureType> Arguments)
    : SignatureType;

internal sealed record ArraySignatureType(SignatureType Element, int Rank) : SignatureType;

internal sealed record ByReferenceSignatureType(SignatureType Element) : SignatureType;

internal sealed record PointerSignatureType(SignatureType Element) : SignatureType;

internal sealed record TypeParameterSignatureType(string Name) : SignatureType;

internal sealed record ModifiedSignatureType(SignatureType Modifier, SignatureType Unmodified, bool IsRequired)
    : SignatureType;

/// <summary>The names of the type parameters that a signature can refer to by index.</summary>
internal sealed record GenericContext(ImmutableArray<string> TypeParameters, ImmutableArray<string> MethodParameters)
{
    public static readonly GenericContext Empty = new([], []);
}

/// <summary>Decodes signatures into <see cref="SignatureType"/> trees.</summary>
internal sealed class SignatureTypeProvider(MetadataReader reader) : ISignatureTypeProvider<SignatureType, GenericContext>
{
    public SignatureType GetArrayType(SignatureType elementType, ArrayShape shape) =>
        new ArraySignatureType(elementType, shape.Rank);

    public SignatureType GetByReferenceType(SignatureType elementType) => new ByReferenceSignatureType(elementType);

    public SignatureType GetFunctionPointerType(MethodSignature<SignatureType> signature) =>
        throw new NotSupportedException("A function pointer type has no snapshot form.");

    public SignatureType GetGenericInstantiation(SignatureType genericType, ImmutableArray<SignatureType> typeArguments) =>
        new GenericSignatureType((NamedSignatureType)genericType, typeArguments);

    public SignatureType GetGenericMethodParameter(GenericContext genericContext, int index) =>
        new TypeParameterSignatureType(genericContext.MethodParameters[index]);

    public SignatureType GetGenericTypeParameter(GenericContext genericContext, int index) =>
        new TypeParameterSignatureType(genericContext.TypeParameters[index]);

    public SignatureType GetModifiedType(SignatureType modifier, SignatureType unmodifiedType, bool isRequired) =>
        new ModifiedSignatureType(modifier, unmodifiedType, isRequired);

    public SignatureType GetPinnedType(SignatureType elementType) => elementType;

    public SignatureType GetPointerType(SignatureType elementType) => new PointerSignatureType(elementType);

    public SignatureType GetPrimitiveType(PrimitiveTypeCode typeCode) => new PrimitiveSignatureType(typeCode);

    public SignatureType GetSZArrayType(SignatureType elementType) => new ArraySignatureType(elementType, 1);

    public SignatureType GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
    {
        var names = ImmutableArray.CreateBuilder<string>();
        var definition = reader.GetTypeDefinition(handle);
        while (true)
        {
            names.Insert(0, reader.GetString(definition.Name));
            var declaring = definition.GetDeclaringType();
            if (declaring.IsNil)
            {
                break;
            }
            definition = reader.GetTypeDefinition(declaring);
        }
        return new NamedSignatureType(reader.GetString(definition.Namespace), names.ToImmutable(), IsValueType(rawTypeKind));
    }

    public SignatureType GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
    {
        var names = ImmutableArray.CreateBuilder<string>();
        var reference = reader.GetTypeReference(handle);
        while (true)
        {
            names.Insert(0, reader.GetString(reference.Name));
            if (reference.ResolutionScope.Kind != HandleKind.TypeReference)
            {
                break;
            }
            reference = reader.GetTypeReference((TypeReferenceHandle)reference.ResolutionScope);
        }
        return new NamedSignatureType(reader.GetString(reference.Namespace), names.ToImmutable(), IsValueType(rawTypeKind));
    }

    public SignatureType GetTypeFromSpecification(
        MetadataReader reader, GenericContext genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
        reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

    /// <summary>Decodes a base type, an interface, a constraint, or an event type.</summary>
    public SignatureType Decode(EntityHandle handle, GenericContext context) => handle.Kind switch
    {
        HandleKind.TypeDefinition => GetTypeFromDefinition(reader, (TypeDefinitionHandle)handle, 0),
        HandleKind.TypeReference => GetTypeFromReference(reader, (TypeReferenceHandle)handle, 0),
        HandleKind.TypeSpecification => GetTypeFromSpecification(reader, context, (TypeSpecificationHandle)handle, 0),
        _ => throw new NotSupportedException($"A {handle.Kind} handle is not a type."),
    };

    // Outside a signature the raw kind is 0. Those positions hold a base type, an interface, a
    // constraint, or an event type, and the tool reads them as reference types.
    private static bool IsValueType(byte rawTypeKind) => rawTypeKind == (byte)SignatureTypeKind.ValueType;
}

/// <summary>
/// The nullability bytes of one type, from a <c>NullableAttribute</c> or the nullable context.
/// </summary>
/// <remarks>
/// Roslyn writes one byte for each type in a pre-order walk of the type: 0 is oblivious, 1 is not
/// annotated, and 2 is annotated. A value type that is not generic has no byte. A generic value
/// type has a byte, then the bytes of its type arguments. <c>Nullable&lt;T&gt;</c> has no byte, and
/// only <c>T</c> has its bytes. A type parameter always has a byte. One byte alone stands for every
/// position.
/// </remarks>
internal sealed class NullableFlags
{
    private readonly ImmutableArray<byte> _flags;
    private readonly byte _single;
    private int _index;

    private NullableFlags(ImmutableArray<byte> flags, byte single)
    {
        _flags = flags;
        _single = single;
    }

    public static NullableFlags All(byte flag) => new([], flag);

    public static NullableFlags Each(ImmutableArray<byte> flags) => new(flags, 0);

    private ImmutableArray<string?> _tupleNames;
    private int _tupleIndex;

    /// <summary>
    /// Adds the names of a <c>TupleElementNamesAttribute</c>. Roslyn writes the element names of each
    /// tuple in a pre-order walk of the type, and <c>null</c> for an element without a name.
    /// </summary>
    public NullableFlags WithTupleNames(ImmutableArray<string?> names)
    {
        _tupleNames = names;
        return this;
    }

    /// <summary>The names of the next tuple's <paramref name="count"/> elements, or <c>null</c> when the type has none.</summary>
    public IReadOnlyList<string?>? NextTupleNames(int count)
    {
        if (_tupleNames.IsDefault)
        {
            return null;
        }
        if (_tupleIndex + count > _tupleNames.Length)
        {
            throw new InvalidOperationException("A TupleElementNamesAttribute has fewer names than its type has elements.");
        }
        var names = _tupleNames.Skip(_tupleIndex).Take(count).ToList();
        _tupleIndex += count;
        return names;
    }

    public byte Next()
    {
        if (_flags.IsDefaultOrEmpty)
        {
            return _single;
        }
        if (_index >= _flags.Length)
        {
            throw new InvalidOperationException("A NullableAttribute has fewer bytes than its type has positions.");
        }
        return _flags[_index++];
    }
}

/// <summary>Writes a <see cref="SignatureType"/> in C# syntax, with <c>?</c> where it is nullable.</summary>
internal static class TypeNames
{
    private const byte Annotated = 2;

    private static readonly Dictionary<string, string> Keywords = new(StringComparer.Ordinal)
    {
        ["System.Boolean"] = "bool",
        ["System.Byte"] = "byte",
        ["System.SByte"] = "sbyte",
        ["System.Char"] = "char",
        ["System.Decimal"] = "decimal",
        ["System.Double"] = "double",
        ["System.Single"] = "float",
        ["System.Int16"] = "short",
        ["System.UInt16"] = "ushort",
        ["System.Int32"] = "int",
        ["System.UInt32"] = "uint",
        ["System.Int64"] = "long",
        ["System.UInt64"] = "ulong",
        ["System.IntPtr"] = "nint",
        ["System.UIntPtr"] = "nuint",
        ["System.Object"] = "object",
        ["System.String"] = "string",
        ["System.Void"] = "void",
    };

    public static string Render(SignatureType type, NullableFlags flags) => type switch
    {
        PrimitiveSignatureType primitive => RenderPrimitive(primitive.Code, flags),
        NamedSignatureType named => RenderNamed(named, [], flags),
        GenericSignatureType generic => RenderGeneric(generic, flags),
        ArraySignatureType array => RenderArray(array, flags),
        ByReferenceSignatureType reference => Render(reference.Element, flags),
        PointerSignatureType pointer => Render(pointer.Element, flags) + "*",
        TypeParameterSignatureType parameter => parameter.Name + Mark(flags.Next()),
        ModifiedSignatureType modified => Render(modified.Unmodified, flags),
        _ => throw new NotSupportedException($"No C# form for {type}."),
    };

    /// <summary>The name without nullability, as a member line and a lookup key use it.</summary>
    public static string Plain(SignatureType type) => Render(type, NullableFlags.All(0));

    /// <summary>A name without its CLR arity suffix: <c>Dictionary`2</c> becomes <c>Dictionary</c>.</summary>
    public static string WithoutArity(string name)
    {
        var tick = name.IndexOf('`', StringComparison.Ordinal);
        return tick < 0 ? name : name[..tick];
    }

    public static int Arity(string name)
    {
        var tick = name.IndexOf('`', StringComparison.Ordinal);
        return tick < 0 ? 0 : int.Parse(name.AsSpan(tick + 1), System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>Joins the declaring names and puts each type argument after the name that declares it.</summary>
    public static string Qualified(string ns, ImmutableArray<string> names, IReadOnlyList<string> arguments)
    {
        var parts = new List<string>();
        var next = 0;
        foreach (var name in names)
        {
            var arity = Arity(name);
            var part = WithoutArity(name);
            if (arity > 0)
            {
                part += "<" + string.Join(", ", arguments.Skip(next).Take(arity)) + ">";
                next += arity;
            }
            parts.Add(part);
        }
        var joined = string.Join(".", parts);
        return ns.Length == 0 ? joined : ns + "." + joined;
    }

    private static string Mark(byte flag) => flag == Annotated ? "?" : "";

    private static string RenderPrimitive(PrimitiveTypeCode code, NullableFlags flags) => code switch
    {
        PrimitiveTypeCode.String => "string" + Mark(flags.Next()),
        PrimitiveTypeCode.Object => "object" + Mark(flags.Next()),
        PrimitiveTypeCode.Boolean => "bool",
        PrimitiveTypeCode.Byte => "byte",
        PrimitiveTypeCode.SByte => "sbyte",
        PrimitiveTypeCode.Char => "char",
        PrimitiveTypeCode.Double => "double",
        PrimitiveTypeCode.Single => "float",
        PrimitiveTypeCode.Int16 => "short",
        PrimitiveTypeCode.UInt16 => "ushort",
        PrimitiveTypeCode.Int32 => "int",
        PrimitiveTypeCode.UInt32 => "uint",
        PrimitiveTypeCode.Int64 => "long",
        PrimitiveTypeCode.UInt64 => "ulong",
        PrimitiveTypeCode.IntPtr => "nint",
        PrimitiveTypeCode.UIntPtr => "nuint",
        PrimitiveTypeCode.Void => "void",
        PrimitiveTypeCode.TypedReference => "System.TypedReference",
        _ => throw new NotSupportedException($"No C# form for {code}."),
    };

    private static string RenderNamed(NamedSignatureType named, IReadOnlyList<string> arguments, NullableFlags flags)
    {
        var mark = named.IsValueType ? "" : Mark(flags.Next());
        var full = Qualified(named.Namespace, named.Names, arguments);
        return (arguments.Count == 0 && Keywords.TryGetValue(full, out var keyword) ? keyword : full) + mark;
    }

    private static string RenderGeneric(GenericSignatureType generic, NullableFlags flags)
    {
        var definition = generic.Definition;
        if (definition.Is("System", "Nullable`1"))
        {
            return Render(generic.Arguments[0], flags) + "?";
        }
        // The type's own byte comes before the bytes of its arguments. A generic value type has a
        // byte too, which is always 0, so it marks nothing.
        var own = flags.Next();
        var mark = definition.IsValueType ? "" : Mark(own);
        var arity = definition.Names.Length == 1 && definition.Namespace == "System" && definition.Names[0].StartsWith("ValueTuple`", StringComparison.Ordinal)
            ? Arity(definition.Names[0])
            : 0;
        if (arity == 8)
        {
            // A tuple of more than seven elements nests its rest in an eighth argument.
            throw new NotSupportedException("A tuple of more than seven elements has no snapshot form.");
        }
        var names = arity > 1 ? flags.NextTupleNames(arity) : null;
        var arguments = generic.Arguments.Select(argument => Render(argument, flags)).ToList();
        if (arity > 1)
        {
            // C# writes a tuple as (T1 name1, T2 name2). A renamed element breaks a caller that reads it by name.
            var elements = arguments.Select((argument, index) => names?[index] is { } name ? $"{argument} {name}" : argument);
            return "(" + string.Join(", ", elements) + ")";
        }
        return Qualified(definition.Namespace, definition.Names, arguments) + mark;
    }

    private static string RenderArray(ArraySignatureType array, NullableFlags flags)
    {
        var mark = Mark(flags.Next());
        var element = Render(array.Element, flags);
        return element + "[" + new string(',', array.Rank - 1) + "]" + mark;
    }
}

/// <summary>Reads the custom attributes and constants that change how a member reads.</summary>
internal static class MetadataValues
{
    public const string CompilerServices = "System.Runtime.CompilerServices";

    public static bool Has(MetadataReader reader, CustomAttributeHandleCollection attributes, string ns, string name) =>
        Find(reader, attributes, ns, name) is not null;

    public static CustomAttribute? Find(
        MetadataReader reader, CustomAttributeHandleCollection attributes, string ns, string name)
    {
        foreach (var handle in attributes)
        {
            var attribute = reader.GetCustomAttribute(handle);
            var (attributeNamespace, attributeName) = AttributeType(reader, attribute);
            if (attributeNamespace == ns && attributeName == name)
            {
                return attribute;
            }
        }
        return null;
    }

    /// <summary>The bytes of a <c>NullableAttribute</c>, or <c>null</c> when there is none.</summary>
    public static NullableFlags? Nullable(MetadataReader reader, CustomAttributeHandleCollection attributes)
    {
        if (Find(reader, attributes, CompilerServices, "NullableAttribute") is not { } attribute)
        {
            return null;
        }
        var blob = reader.GetBlobReader(attribute.Value);
        blob.ReadUInt16();
        // The prolog, one byte, and the named-argument count make five bytes. A byte[] argument has a
        // four-byte length before its elements.
        if (blob.Length == 5)
        {
            return NullableFlags.All(blob.ReadByte());
        }
        var count = blob.ReadInt32();
        var flags = ImmutableArray.CreateBuilder<byte>(count);
        for (var index = 0; index < count; index++)
        {
            flags.Add(blob.ReadByte());
        }
        return NullableFlags.Each(flags.MoveToImmutable());
    }

    /// <summary>The element names of a <c>TupleElementNamesAttribute</c>, or a default array when there is none.</summary>
    public static ImmutableArray<string?> TupleNames(MetadataReader reader, CustomAttributeHandleCollection attributes)
    {
        if (Find(reader, attributes, CompilerServices, "TupleElementNamesAttribute") is not { } attribute)
        {
            return default;
        }
        var value = attribute.DecodeValue(new AttributeTypeProvider());
        var names = (ImmutableArray<CustomAttributeTypedArgument<string>>)value.FixedArguments[0].Value!;
        return [.. names.Select(name => (string?)name.Value)];
    }

    /// <summary>The byte of a <c>NullableContextAttribute</c>, or <c>null</c> when there is none.</summary>
    public static byte? NullableContext(MetadataReader reader, CustomAttributeHandleCollection attributes)
    {
        if (Find(reader, attributes, CompilerServices, "NullableContextAttribute") is not { } attribute)
        {
            return null;
        }
        var blob = reader.GetBlobReader(attribute.Value);
        blob.ReadUInt16();
        return blob.ReadByte();
    }

    /// <summary>A constant from the Constant table: a field value or a parameter default.</summary>
    public static object? Constant(MetadataReader reader, ConstantHandle handle)
    {
        var constant = reader.GetConstant(handle);
        var blob = reader.GetBlobReader(constant.Value);
        return constant.TypeCode switch
        {
            ConstantTypeCode.Boolean => blob.ReadBoolean(),
            ConstantTypeCode.Char => blob.ReadChar(),
            ConstantTypeCode.SByte => blob.ReadSByte(),
            ConstantTypeCode.Byte => blob.ReadByte(),
            ConstantTypeCode.Int16 => blob.ReadInt16(),
            ConstantTypeCode.UInt16 => blob.ReadUInt16(),
            ConstantTypeCode.Int32 => blob.ReadInt32(),
            ConstantTypeCode.UInt32 => blob.ReadUInt32(),
            ConstantTypeCode.Int64 => blob.ReadInt64(),
            ConstantTypeCode.UInt64 => blob.ReadUInt64(),
            ConstantTypeCode.Single => blob.ReadSingle(),
            ConstantTypeCode.Double => blob.ReadDouble(),
            ConstantTypeCode.String => blob.ReadUTF16(blob.Length),
            ConstantTypeCode.NullReference => null,
            _ => throw new NotSupportedException($"A {constant.TypeCode} constant has no snapshot form."),
        };
    }

    public static (string Namespace, string Name) AttributeType(MetadataReader reader, CustomAttribute attribute)
    {
        EntityHandle type;
        if (attribute.Constructor.Kind == HandleKind.MemberReference)
        {
            type = reader.GetMemberReference((MemberReferenceHandle)attribute.Constructor).Parent;
        }
        else
        {
            type = reader.GetMethodDefinition((MethodDefinitionHandle)attribute.Constructor).GetDeclaringType();
        }
        if (type.Kind == HandleKind.TypeReference)
        {
            var reference = reader.GetTypeReference((TypeReferenceHandle)type);
            return (reader.GetString(reference.Namespace), reader.GetString(reference.Name));
        }
        if (type.Kind == HandleKind.TypeDefinition)
        {
            var definition = reader.GetTypeDefinition((TypeDefinitionHandle)type);
            return (reader.GetString(definition.Namespace), reader.GetString(definition.Name));
        }
        return ("", "");
    }
}

/// <summary>Names the types of custom attribute arguments, so the tool can decode their values.</summary>
internal sealed class AttributeTypeProvider : ICustomAttributeTypeProvider<string>
{
    public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

    public string GetSystemType() => "System.Type";

    public string GetSZArrayType(string elementType) => elementType + "[]";

    public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
    {
        var definition = reader.GetTypeDefinition(handle);
        return reader.GetString(definition.Namespace) + "." + reader.GetString(definition.Name);
    }

    public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
    {
        var reference = reader.GetTypeReference(handle);
        return reader.GetString(reference.Namespace) + "." + reader.GetString(reference.Name);
    }

    public string GetTypeFromSerializedName(string name) => name;

    public PrimitiveTypeCode GetUnderlyingEnumType(string type) =>
        throw new NotSupportedException($"An attribute argument of the enum {type} has no snapshot form.");

    public bool IsSystemType(string type) => type == "System.Type";
}
