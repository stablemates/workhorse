using System.Collections.Immutable;
using System.Globalization;
using System.Reflection;
using System.Reflection.Metadata;
using System.Text;

namespace Workhorse.ApiSnapshot;

/// <summary>The member names of every enum in the packages, so a default value can name its member.</summary>
internal sealed class EnumNames
{
    private readonly Dictionary<string, Dictionary<string, string>> _members = new(StringComparer.Ordinal);

    public void Add(string type, string value, string member)
    {
        if (!_members.TryGetValue(type, out var members))
        {
            members = [];
            _members[type] = members;
        }
        members.TryAdd(value, member);
    }

    public string? Name(string type, string value) =>
        _members.TryGetValue(type, out var members) && members.TryGetValue(value, out var member)
            ? type + "." + member
            : null;
}

/// <summary>
/// One type block of a package section: the header line, then one line for each visible member.
/// </summary>
internal sealed record TypeBlock(string Namespace, string Name, string Header, IReadOnlyList<string> Members);

/// <summary>Reads the public and protected surface of one package assembly.</summary>
internal sealed class AssemblyApi
{
    private readonly MetadataReader _reader;
    private readonly SignatureTypeProvider _provider;
    private readonly EnumNames _enums;

    public AssemblyApi(MetadataReader reader, EnumNames enums)
    {
        _reader = reader;
        _provider = new SignatureTypeProvider(reader);
        _enums = enums;
    }

    /// <summary>Adds the members of every visible enum of the assembly to <paramref name="enums"/>.</summary>
    public static void CollectEnums(MetadataReader reader, EnumNames enums)
    {
        var api = new AssemblyApi(reader, enums);
        foreach (var handle in reader.TypeDefinitions)
        {
            var type = reader.GetTypeDefinition(handle);
            if (!api.IsVisible(type) || api.Kind(type) != "enum")
            {
                continue;
            }
            var name = api.TypeName(handle);
            foreach (var fieldHandle in type.GetFields())
            {
                var field = reader.GetFieldDefinition(fieldHandle);
                if ((field.Attributes & FieldAttributes.Literal) != 0)
                {
                    var value = MetadataValues.Constant(reader, field.GetDefaultValue());
                    enums.Add(name, Number(value), reader.GetString(field.Name));
                }
            }
        }
    }

    public IReadOnlyList<TypeBlock> Types()
    {
        var blocks = new List<TypeBlock>();
        foreach (var handle in _reader.TypeDefinitions)
        {
            var type = _reader.GetTypeDefinition(handle);
            if (IsVisible(type))
            {
                blocks.Add(Block(handle, type));
            }
        }
        blocks.Sort((left, right) => string.CompareOrdinal(left.Name, right.Name));
        return blocks;
    }

    public string Namespace(TypeDefinitionHandle handle)
    {
        var type = _reader.GetTypeDefinition(handle);
        while (!type.GetDeclaringType().IsNil)
        {
            type = _reader.GetTypeDefinition(type.GetDeclaringType());
        }
        return _reader.GetString(type.Namespace);
    }

    private TypeBlock Block(TypeDefinitionHandle handle, TypeDefinition type)
    {
        var name = TypeName(handle);
        var kind = Kind(type);
        var context = TypeContext(type);
        var members = new List<string>();
        if (kind == "delegate")
        {
            return new TypeBlock(Namespace(handle), name, DelegateHeader(type, name, context), members);
        }
        var isRecord = kind is "record" or "record struct";
        foreach (var interfaceHandle in type.GetInterfaceImplementations())
        {
            var implementation = _reader.GetInterfaceImplementation(interfaceHandle);
            var flags = NullableOf(implementation.GetCustomAttributes(), TypeNullableContext(type));
            var rendered = TypeNames.Render(_provider.Decode(implementation.Interface, context), flags);
            // Every record implements IEquatable of itself, and the record header already says so.
            if (!(isRecord && rendered == $"System.IEquatable<{name}>"))
            {
                members.Add($"{name}: implements {rendered}");
            }
        }
        foreach (var fieldHandle in type.GetFields())
        {
            if (Field(type, kind, _reader.GetFieldDefinition(fieldHandle), context) is { } line)
            {
                members.Add($"{name}: {line}");
            }
        }
        var accessors = new HashSet<MethodDefinitionHandle>();
        foreach (var propertyHandle in type.GetProperties())
        {
            var property = _reader.GetPropertyDefinition(propertyHandle);
            var propertyAccessors = property.GetAccessors();
            AddAccessors(accessors, propertyAccessors.Getter, propertyAccessors.Setter, propertyAccessors.Others);
            if (Property(type, kind, property, context) is { } line)
            {
                members.Add($"{name}: {line}");
            }
        }
        foreach (var eventHandle in type.GetEvents())
        {
            var @event = _reader.GetEventDefinition(eventHandle);
            var eventAccessors = @event.GetAccessors();
            AddAccessors(accessors, eventAccessors.Adder, eventAccessors.Remover, eventAccessors.Others);
            accessors.Add(eventAccessors.Raiser);
            if (Event(type, kind, @event, context) is { } line)
            {
                members.Add($"{name}: {line}");
            }
        }
        foreach (var methodHandle in type.GetMethods())
        {
            if (accessors.Contains(methodHandle))
            {
                continue;
            }
            if (Method(type, kind, isRecord, _reader.GetMethodDefinition(methodHandle), context) is { } line)
            {
                members.Add($"{name}: {line}");
            }
        }
        members.Sort(string.CompareOrdinal);
        return new TypeBlock(Namespace(handle), name, Header(type, kind, name, context), members);
    }

    private static void AddAccessors(
        HashSet<MethodDefinitionHandle> accessors,
        MethodDefinitionHandle first,
        MethodDefinitionHandle second,
        ImmutableArray<MethodDefinitionHandle> others)
    {
        accessors.Add(first);
        accessors.Add(second);
        foreach (var other in others)
        {
            accessors.Add(other);
        }
    }

    // Types

    private bool IsVisible(TypeDefinition type)
    {
        if (_reader.GetString(type.Name).StartsWith('<'))
        {
            return false;
        }
        var visibility = type.Attributes & TypeAttributes.VisibilityMask;
        var declaringHandle = type.GetDeclaringType();
        if (declaringHandle.IsNil)
        {
            return visibility == TypeAttributes.Public;
        }
        var declaring = _reader.GetTypeDefinition(declaringHandle);
        return visibility switch
        {
            TypeAttributes.NestedPublic => IsVisible(declaring),
            TypeAttributes.NestedFamily or TypeAttributes.NestedFamORAssem =>
                IsVisible(declaring) && (declaring.Attributes & TypeAttributes.Sealed) == 0,
            _ => false,
        };
    }

    private string Kind(TypeDefinition type)
    {
        if ((type.Attributes & TypeAttributes.Interface) != 0)
        {
            return "interface";
        }
        var baseName = type.BaseType.IsNil ? "" : TypeNames.Plain(_provider.Decode(type.BaseType, TypeContext(type)));
        switch (baseName)
        {
            case "System.Enum":
                return "enum";
            case "System.MulticastDelegate":
                return "delegate";
            case "System.ValueType":
                // The compiler writes the == operator of every record struct, and a record cannot
                // declare its own. A record struct can declare its own PrintMembers.
                return HasCompilerGenerated(type, "op_Equality") ? "record struct" : "struct";
            default:
                break;
        }
        foreach (var handle in type.GetMethods())
        {
            if (_reader.GetString(_reader.GetMethodDefinition(handle).Name) == "<Clone>$")
            {
                return "record";
            }
        }
        return "class";
    }

    private bool HasCompilerGenerated(TypeDefinition type, string name) => type.GetMethods()
        .Select(_reader.GetMethodDefinition)
        .Any(method => _reader.GetString(method.Name) == name
            && MetadataValues.Has(_reader, method.GetCustomAttributes(), MetadataValues.CompilerServices, "CompilerGeneratedAttribute"));

    /// <summary>The C# name of a type, with its declaring types and type parameter names.</summary>
    public string TypeName(TypeDefinitionHandle handle)
    {
        var names = ImmutableArray.CreateBuilder<string>();
        var type = _reader.GetTypeDefinition(handle);
        var parameters = TypeParameterNames(type);
        while (true)
        {
            names.Insert(0, _reader.GetString(type.Name));
            if (type.GetDeclaringType().IsNil)
            {
                break;
            }
            type = _reader.GetTypeDefinition(type.GetDeclaringType());
        }
        return TypeNames.Qualified(_reader.GetString(type.Namespace), names.ToImmutable(), parameters);
    }

    private ImmutableArray<string> TypeParameterNames(TypeDefinition type) =>
        [.. type.GetGenericParameters().Select(handle => _reader.GetString(_reader.GetGenericParameter(handle).Name))];

    private GenericContext TypeContext(TypeDefinition type) => new(TypeParameterNames(type), []);

    private string Header(TypeDefinition type, string kind, string name, GenericContext context)
    {
        var attributes = type.Attributes;
        var builder = new StringBuilder(TypeAccess(type)).Append(' ');
        var isAbstract = (attributes & TypeAttributes.Abstract) != 0;
        var isSealed = (attributes & TypeAttributes.Sealed) != 0;
        switch (kind)
        {
            case "class" when isAbstract && isSealed:
                builder.Append("static ");
                break;
            case "class" or "record" when isAbstract:
                builder.Append("abstract ");
                break;
            case "class" or "record" when isSealed:
                builder.Append("sealed ");
                break;
            case "struct" or "record struct":
                if (MetadataValues.Has(_reader, type.GetCustomAttributes(), MetadataValues.CompilerServices, "IsReadOnlyAttribute"))
                {
                    builder.Append("readonly ");
                }
                if (MetadataValues.Has(_reader, type.GetCustomAttributes(), MetadataValues.CompilerServices, "IsByRefLikeAttribute"))
                {
                    builder.Append("ref ");
                }
                break;
            default:
                break;
        }
        builder.Append(kind).Append(' ').Append(WithVariance(type, name));
        if (kind == "enum")
        {
            var underlying = EnumUnderlyingType(type, context);
            if (underlying != "int")
            {
                builder.Append(" : ").Append(underlying);
            }
        }
        else if (kind is "class" or "record" && !type.BaseType.IsNil)
        {
            var flags = NullableOf(type.GetCustomAttributes(), TypeNullableContext(type));
            var baseType = TypeNames.Render(_provider.Decode(type.BaseType, context), flags);
            if (baseType != "object")
            {
                builder.Append(" : ").Append(baseType);
            }
        }
        builder.Append(Constraints(type.GetGenericParameters(), TypeNullableContext(type), context, OwnTypeParameters(type)));
        return builder.ToString();
    }

    // A nested type keeps its own access, so a nested type that becomes protected changes its line.
    private static string TypeAccess(TypeDefinition type) => (type.Attributes & TypeAttributes.VisibilityMask) switch
    {
        TypeAttributes.NestedFamily => "protected",
        TypeAttributes.NestedFamORAssem => "protected internal",
        _ => "public",
    };

    private string DelegateHeader(TypeDefinition type, string name, GenericContext context)
    {
        foreach (var handle in type.GetMethods())
        {
            var invoke = _reader.GetMethodDefinition(handle);
            if (_reader.GetString(invoke.Name) != "Invoke")
            {
                continue;
            }
            var signature = invoke.DecodeSignature(_provider, context);
            var methodContext = MethodNullableContext(type, invoke);
            var parameters = Parameters(invoke, signature, methodContext);
            var returnType = ReturnType(invoke, signature, methodContext);
            var constraints = Constraints(type.GetGenericParameters(), TypeNullableContext(type), context, OwnTypeParameters(type));
            var annotations = ParameterRows(invoke).TryGetValue(0, out var returnRow) ? Annotations(returnRow.GetCustomAttributes(), "return: ") : "";
            return $"{annotations}{TypeAccess(type)} delegate {returnType} {WithVariance(type, name)}({parameters}){constraints}";
        }
        throw new InvalidOperationException($"The delegate {name} has no Invoke method.");
    }

    private string WithVariance(TypeDefinition type, string name)
    {
        var parameters = type.GetGenericParameters();
        if (parameters.Count == 0)
        {
            return name;
        }
        foreach (var handle in parameters)
        {
            var parameter = _reader.GetGenericParameter(handle);
            var variance = (parameter.Attributes & GenericParameterAttributes.VarianceMask) switch
            {
                GenericParameterAttributes.Covariant => "out ",
                GenericParameterAttributes.Contravariant => "in ",
                _ => "",
            };
            if (variance.Length > 0)
            {
                var parameterName = _reader.GetString(parameter.Name);
                name = name.Replace($"<{parameterName}", $"<{variance}{parameterName}", StringComparison.Ordinal)
                    .Replace($", {parameterName}", $", {variance}{parameterName}", StringComparison.Ordinal);
            }
        }
        return name;
    }

    // A nested type repeats the type parameters of its declaring types. Only its own get constraints.
    private int OwnTypeParameters(TypeDefinition type)
    {
        var declaring = type.GetDeclaringType();
        var inherited = declaring.IsNil ? 0 : _reader.GetTypeDefinition(declaring).GetGenericParameters().Count;
        return type.GetGenericParameters().Count - inherited;
    }

    private string EnumUnderlyingType(TypeDefinition type, GenericContext context)
    {
        foreach (var handle in type.GetFields())
        {
            var field = _reader.GetFieldDefinition(handle);
            if ((field.Attributes & FieldAttributes.Static) == 0)
            {
                return TypeNames.Plain(field.DecodeSignature(_provider, context));
            }
        }
        return "int";
    }

    private string Constraints(
        GenericParameterHandleCollection parameters, byte context, GenericContext genericContext, int own)
    {
        var builder = new StringBuilder();
        foreach (var handle in parameters.Skip(parameters.Count - own))
        {
            var parameter = _reader.GetGenericParameter(handle);
            var flag = MetadataValues.Nullable(_reader, parameter.GetCustomAttributes())?.Next() ?? context;
            var attributes = parameter.Attributes & GenericParameterAttributes.SpecialConstraintMask;
            var clauses = new List<string>();
            var isStruct = (attributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0;
            if ((attributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
            {
                clauses.Add(flag == 2 ? "class?" : "class");
            }
            else if (isStruct)
            {
                clauses.Add(MetadataValues.Has(_reader, parameter.GetCustomAttributes(), MetadataValues.CompilerServices, "IsUnmanagedAttribute")
                    ? "unmanaged"
                    : "struct");
            }
            var types = new List<string>();
            foreach (var constraintHandle in parameter.GetConstraints())
            {
                var constraint = _reader.GetGenericParameterConstraint(constraintHandle);
                var rendered = TypeNames.Render(
                    _provider.Decode(constraint.Type, genericContext),
                    NullableOf(constraint.GetCustomAttributes(), flag));
                // A struct constraint also writes System.ValueType as a type constraint.
                if (!(isStruct && rendered == "System.ValueType"))
                {
                    types.Add(rendered);
                }
            }
            if (clauses.Count == 0 && types.Count == 0 && flag == 1)
            {
                clauses.Add("notnull");
            }
            clauses.AddRange(types);
            if ((attributes & GenericParameterAttributes.DefaultConstructorConstraint) != 0 && !isStruct)
            {
                clauses.Add("new()");
            }
            if ((parameter.Attributes & (GenericParameterAttributes)0x0020) != 0)
            {
                clauses.Add("allows ref struct");
            }
            if (clauses.Count > 0)
            {
                builder.Append(" where ").Append(_reader.GetString(parameter.Name)).Append(" : ").AppendJoin(", ", clauses);
            }
        }
        return builder.ToString();
    }

    // Nullable context

    private byte TypeNullableContext(TypeDefinition type)
    {
        while (true)
        {
            if (MetadataValues.NullableContext(_reader, type.GetCustomAttributes()) is { } flag)
            {
                return flag;
            }
            if (type.GetDeclaringType().IsNil)
            {
                return 0;
            }
            type = _reader.GetTypeDefinition(type.GetDeclaringType());
        }
    }

    private byte MethodNullableContext(TypeDefinition type, MethodDefinition method) =>
        MetadataValues.NullableContext(_reader, method.GetCustomAttributes()) ?? TypeNullableContext(type);

    private NullableFlags NullableOf(CustomAttributeHandleCollection attributes, byte context) =>
        (MetadataValues.Nullable(_reader, attributes) ?? NullableFlags.All(context))
            .WithTupleNames(MetadataValues.TupleNames(_reader, attributes));

    // Members

    private static string? Access(MethodAttributes attributes) => (attributes & MethodAttributes.MemberAccessMask) switch
    {
        MethodAttributes.Public => "public",
        MethodAttributes.Family => "protected",
        MethodAttributes.FamORAssem => "protected internal",
        _ => null,
    };

    private static int Rank(string? access) => access switch
    {
        "public" => 3,
        "protected internal" => 2,
        "protected" => 1,
        _ => 0,
    };

    private static string Modifiers(string kind, MethodAttributes attributes)
    {
        var isStatic = (attributes & MethodAttributes.Static) != 0;
        var isAbstract = (attributes & MethodAttributes.Abstract) != 0;
        var isVirtual = (attributes & MethodAttributes.Virtual) != 0;
        var isFinal = (attributes & MethodAttributes.Final) != 0;
        var isNewSlot = (attributes & MethodAttributes.NewSlot) != 0;
        var builder = new StringBuilder();
        if (isStatic)
        {
            builder.Append("static ");
        }
        if (isAbstract)
        {
            builder.Append("abstract ");
        }
        else if (kind == "interface" && isVirtual)
        {
            // An interface member with a body: a default implementation.
            builder.Append("virtual ");
        }
        else if (isVirtual && !isNewSlot)
        {
            builder.Append(isFinal ? "sealed override " : "override ");
        }
        else if (isVirtual && !isFinal)
        {
            builder.Append("virtual ");
        }
        return builder.ToString();
    }

    private string? Field(TypeDefinition type, string kind, FieldDefinition field, GenericContext context)
    {
        var attributes = field.Attributes;
        var name = _reader.GetString(field.Name);
        if ((attributes & FieldAttributes.RTSpecialName) != 0)
        {
            return null;
        }
        var access = (attributes & FieldAttributes.FieldAccessMask) switch
        {
            FieldAttributes.Public => "public",
            FieldAttributes.Family => "protected",
            FieldAttributes.FamORAssem => "protected internal",
            _ => null,
        };
        if (access is null)
        {
            return null;
        }
        var fieldType = field.DecodeSignature(_provider, context);
        if (kind == "enum")
        {
            // The number, not the member name, because a changed value breaks a compiled caller.
            return $"{name} = {Number(MetadataValues.Constant(_reader, field.GetDefaultValue()))}";
        }
        var rendered = TypeNames.Render(fieldType, NullableOf(field.GetCustomAttributes(), TypeNullableContext(type)));
        var annotations = Annotations(field.GetCustomAttributes());
        if ((attributes & FieldAttributes.Literal) != 0)
        {
            var value = Literal(MetadataValues.Constant(_reader, field.GetDefaultValue()), fieldType);
            return $"{annotations}{access} const {rendered} {name} = {value}";
        }
        // C# writes a decimal constant as a static read-only field with a DecimalConstantAttribute.
        if (DecimalConstant(field.GetCustomAttributes()) is { } number)
        {
            return $"{annotations}{access} const {rendered} {name} = {DecimalLiteral(number)}";
        }
        var required = MetadataValues.Has(_reader, field.GetCustomAttributes(), MetadataValues.CompilerServices, "RequiredMemberAttribute");
        var modifiers = ((attributes & FieldAttributes.Static) != 0 ? "static " : "")
            + ((attributes & FieldAttributes.InitOnly) != 0 ? "readonly " : "")
            + (required ? "required " : "");
        return $"{annotations}{access} {modifiers}{rendered} {name}";
    }

    private string? Property(TypeDefinition type, string kind, PropertyDefinition property, GenericContext context)
    {
        var name = _reader.GetString(property.Name);
        var accessors = property.GetAccessors();
        var getter = accessors.Getter.IsNil ? (MethodDefinition?)null : _reader.GetMethodDefinition(accessors.Getter);
        var setter = accessors.Setter.IsNil ? (MethodDefinition?)null : _reader.GetMethodDefinition(accessors.Setter);
        var getAccess = getter is { } get ? Access(get.Attributes) : null;
        var setAccess = setter is { } set ? Access(set.Attributes) : null;
        if (getAccess is null && setAccess is null)
        {
            return null;
        }
        // The compiler writes EqualityContract for every record class, and the record header says so.
        if (kind == "record" && name == "EqualityContract")
        {
            return null;
        }
        var access = Rank(getAccess) >= Rank(setAccess) ? getAccess! : setAccess!;
        var modifierSource = getAccess is not null ? getter!.Value : setter!.Value;
        var signature = property.DecodeSignature(_provider, context);
        var flags = NullableOf(property.GetCustomAttributes(), TypeNullableContext(type));
        var reference = Reference(signature.ReturnType, isReadOnly: false);
        var propertyType = TypeNames.Render(signature.ReturnType, flags);
        var required = MetadataValues.Has(_reader, property.GetCustomAttributes(), MetadataValues.CompilerServices, "RequiredMemberAttribute")
            ? "required "
            : "";
        var parts = new List<string>();
        if (getAccess is not null)
        {
            parts.Add(AccessorAnnotations(getter!.Value, "return: ", 0) + (getAccess == access ? "" : getAccess + " ") + "get;");
        }
        if (setAccess is not null)
        {
            var setSignature = setter!.Value.DecodeSignature(_provider, context);
            var isInit = setSignature.ReturnType is ModifiedSignatureType { Modifier: NamedSignatureType modifier }
                && modifier.Is(MetadataValues.CompilerServices, "IsExternalInit");
            // The value parameter of a setter is its last parameter, after any indexer parameters.
            var value = setSignature.ParameterTypes.Length;
            parts.Add(AccessorAnnotations(setter!.Value, "param: ", value) + (setAccess == access ? "" : setAccess + " ") + (isInit ? "init;" : "set;"));
        }
        var memberName = name;
        if (signature.ParameterTypes.Length > 0)
        {
            var indexed = getter ?? setter!.Value;
            var indexedSignature = indexed.DecodeSignature(_provider, context);
            memberName = $"this[{Parameters(indexed, indexedSignature, MethodNullableContext(type, indexed), signature.ParameterTypes.Length)}]";
        }
        var modifiers = Modifiers(kind, modifierSource.Attributes);
        var annotations = Annotations(property.GetCustomAttributes());
        return $"{annotations}{access} {modifiers}{required}{reference}{propertyType} {memberName} {{ {string.Join(" ", parts)} }}";
    }

    private string? Event(TypeDefinition type, string kind, EventDefinition @event, GenericContext context)
    {
        var adder = _reader.GetMethodDefinition(@event.GetAccessors().Adder);
        if (Access(adder.Attributes) is not { } access)
        {
            return null;
        }
        var flags = NullableOf(@event.GetCustomAttributes(), TypeNullableContext(type));
        var eventType = TypeNames.Render(_provider.Decode(@event.Type, context), flags);
        return $"{access} {Modifiers(kind, adder.Attributes)}event {eventType} {_reader.GetString(@event.Name)}";
    }

    private string? Method(TypeDefinition type, string kind, bool isRecord, MethodDefinition method, GenericContext typeContext)
    {
        if (Access(method.Attributes) is not { } access)
        {
            return null;
        }
        var name = _reader.GetString(method.Name);
        if (name == ".cctor")
        {
            return null;
        }
        // A record's equality members, its ToString, and its clone method are compiler-generated, and
        // the record header implies them. Constructors stay: a protected copy constructor lets a
        // caller derive from a record that is not sealed. A Deconstruct method stays too: it comes
        // from a positional record, which ADR 0107 rules out.
        if (isRecord
            && name is not ".ctor" and not "Deconstruct"
            && MetadataValues.Has(_reader, method.GetCustomAttributes(), MetadataValues.CompilerServices, "CompilerGeneratedAttribute"))
        {
            return null;
        }
        var methodParameters = method.GetGenericParameters()
            .Select(handle => _reader.GetString(_reader.GetGenericParameter(handle).Name))
            .ToImmutableArray();
        var context = typeContext with { MethodParameters = methodParameters };
        var signature = method.DecodeSignature(_provider, context);
        var nullableContext = MethodNullableContext(type, method);
        var parameters = Parameters(method, signature, nullableContext);
        var modifiers = Modifiers(kind, method.Attributes);
        var generic = methodParameters.Length == 0 ? "" : "<" + string.Join(", ", methodParameters) + ">";
        var constraints = Constraints(method.GetGenericParameters(), nullableContext, context, methodParameters.Length);
        var annotations = Annotations(method.GetCustomAttributes())
            + (ParameterRows(method).TryGetValue(0, out var returnRow) ? Annotations(returnRow.GetCustomAttributes(), "return: ") : "");
        if (name == ".ctor")
        {
            var simple = TypeNames.WithoutArity(_reader.GetString(type.Name));
            return $"{annotations}{access} {simple}({parameters})";
        }
        var returnType = ReturnType(method, signature, nullableContext);
        if ((method.Attributes & MethodAttributes.SpecialName) != 0 && name is "op_Implicit" or "op_Explicit")
        {
            var conversion = name == "op_Implicit" ? "implicit" : "explicit";
            return $"{annotations}{access} {modifiers}{conversion} operator {returnType}({parameters})";
        }
        if ((method.Attributes & MethodAttributes.SpecialName) != 0 && Operator(name) is { } symbol)
        {
            return $"{annotations}{access} {modifiers}{returnType} operator {symbol}({parameters})";
        }
        return $"{annotations}{access} {modifiers}{returnType} {name}{generic}({parameters}){constraints}";
    }

    private static string? Operator(string name) => name switch
    {
        "op_Equality" => "==",
        "op_Inequality" => "!=",
        "op_LessThan" => "<",
        "op_LessThanOrEqual" => "<=",
        "op_GreaterThan" => ">",
        "op_GreaterThanOrEqual" => ">=",
        "op_Addition" => "+",
        "op_Subtraction" => "-",
        "op_Multiply" => "*",
        "op_Division" => "/",
        "op_Modulus" => "%",
        "op_UnaryNegation" => "-",
        "op_UnaryPlus" => "+",
        "op_LogicalNot" => "!",
        "op_True" => "true",
        "op_False" => "false",
        _ => null,
    };

    private Dictionary<int, Parameter> ParameterRows(MethodDefinition method)
    {
        var rows = new Dictionary<int, Parameter>();
        foreach (var handle in method.GetParameters())
        {
            var parameter = _reader.GetParameter(handle);
            rows[parameter.SequenceNumber] = parameter;
        }
        return rows;
    }

    private string ReturnType(MethodDefinition method, MethodSignature<SignatureType> signature, byte context)
    {
        var rows = ParameterRows(method);
        var attributes = rows.TryGetValue(0, out var row) ? row.GetCustomAttributes() : default;
        var flags = rows.ContainsKey(0) ? NullableOf(attributes, context) : NullableFlags.All(context);
        var rendered = TypeNames.Render(signature.ReturnType, flags);
        var isReadOnly = rows.ContainsKey(0)
            && MetadataValues.Has(_reader, attributes, MetadataValues.CompilerServices, "IsReadOnlyAttribute");
        return Reference(signature.ReturnType, isReadOnly) + rendered;
    }

    /// <summary>
    /// <c>ref </c> or <c>ref readonly </c> for a reference return, or nothing. C# writes a
    /// <c>ref readonly</c> return as a reference under a required <c>InAttribute</c> modifier.
    /// </summary>
    private static string Reference(SignatureType returnType, bool isReadOnly)
    {
        while (returnType is ModifiedSignatureType modified)
        {
            if (modified.IsRequired && modified.Modifier is NamedSignatureType modifier
                && modifier.Is("System.Runtime.InteropServices", "InAttribute"))
            {
                isReadOnly = true;
            }
            returnType = modified.Unmodified;
        }
        if (returnType is not ByReferenceSignatureType)
        {
            return "";
        }
        return isReadOnly ? "ref readonly " : "ref ";
    }

    private string Parameters(MethodDefinition method, MethodSignature<SignatureType> signature, byte context, int? count = null)
    {
        var rows = ParameterRows(method);
        var isExtension = MetadataValues.Has(_reader, method.GetCustomAttributes(), MetadataValues.CompilerServices, "ExtensionAttribute");
        var rendered = new List<string>();
        var total = count ?? signature.ParameterTypes.Length;
        for (var index = 0; index < total; index++)
        {
            var parameterType = signature.ParameterTypes[index];
            if (!rows.TryGetValue(index + 1, out var row))
            {
                rendered.Add(TypeNames.Render(parameterType, NullableFlags.All(context)));
                continue;
            }
            var attributes = row.GetCustomAttributes();
            var builder = new StringBuilder(Annotations(attributes));
            if (index == 0 && isExtension)
            {
                builder.Append("this ");
            }
            if (MetadataValues.Has(_reader, attributes, "System", "ParamArrayAttribute"))
            {
                builder.Append("params ");
            }
            if (MetadataValues.Has(_reader, attributes, MetadataValues.CompilerServices, "ScopedRefAttribute"))
            {
                builder.Append("scoped ");
            }
            // A virtual or interface `in` parameter is a reference under a required InAttribute modifier.
            var unmodified = parameterType;
            while (unmodified is ModifiedSignatureType modified)
            {
                unmodified = modified.Unmodified;
            }
            if (unmodified is ByReferenceSignatureType)
            {
                var flags = row.Attributes;
                if ((flags & ParameterAttributes.Out) != 0 && (flags & ParameterAttributes.In) == 0)
                {
                    builder.Append("out ");
                }
                else if (MetadataValues.Has(_reader, attributes, MetadataValues.CompilerServices, "RequiresLocationAttribute"))
                {
                    builder.Append("ref readonly ");
                }
                else if (MetadataValues.Has(_reader, attributes, MetadataValues.CompilerServices, "IsReadOnlyAttribute"))
                {
                    builder.Append("in ");
                }
                else
                {
                    builder.Append("ref ");
                }
            }
            builder.Append(TypeNames.Render(parameterType, NullableOf(attributes, context)));
            builder.Append(' ').Append(_reader.GetString(row.Name));
            if ((row.Attributes & ParameterAttributes.HasDefault) != 0)
            {
                builder.Append(" = ").Append(Literal(MetadataValues.Constant(_reader, row.GetDefaultValue()), parameterType));
            }
            else if ((row.Attributes & ParameterAttributes.Optional) != 0 && DecimalConstant(attributes) is { } number)
            {
                builder.Append(" = ").Append(DecimalLiteral(number));
            }
            else if ((row.Attributes & ParameterAttributes.Optional) != 0)
            {
                throw new NotSupportedException(
                    $"Parameter {_reader.GetString(row.Name)} of {_reader.GetString(method.Name)} is optional without a constant default.");
            }
            rendered.Add(builder.ToString());
        }
        return string.Join(", ", rendered);
    }

    // Attributes

    /// <summary>
    /// The attributes of System.Diagnostics.CodeAnalysis that change what a C# caller compiles: the
    /// nullable analysis attributes and <c>SetsRequiredMembers</c>. A caller that treats warnings as
    /// errors breaks when one of them changes.
    /// </summary>
    private static readonly HashSet<string> CallerAttributes = new(StringComparer.Ordinal)
    {
        "AllowNullAttribute",
        "DisallowNullAttribute",
        "DoesNotReturnAttribute",
        "DoesNotReturnIfAttribute",
        "MaybeNullAttribute",
        "MaybeNullWhenAttribute",
        "MemberNotNullAttribute",
        "MemberNotNullWhenAttribute",
        "NotNullAttribute",
        "NotNullIfNotNullAttribute",
        "NotNullWhenAttribute",
        "SetsRequiredMembersAttribute",
    };

    /// <summary>
    /// The attributes of an accessor and of its return value or value parameter, as C# writes them
    /// before <c>get;</c> or <c>set;</c>.
    /// </summary>
    private string AccessorAnnotations(MethodDefinition accessor, string target, int sequence) =>
        Annotations(accessor.GetCustomAttributes())
        + (ParameterRows(accessor).TryGetValue(sequence, out var row) ? Annotations(row.GetCustomAttributes(), target) : "");

    /// <summary>Each attribute of <see cref="CallerAttributes"/>, in C# syntax, with a trailing space.</summary>
    private string Annotations(CustomAttributeHandleCollection attributes, string target = "")
    {
        var rendered = new List<string>();
        foreach (var handle in attributes)
        {
            var attribute = _reader.GetCustomAttribute(handle);
            var (ns, name) = MetadataValues.AttributeType(_reader, attribute);
            if (ns != "System.Diagnostics.CodeAnalysis" || !CallerAttributes.Contains(name))
            {
                continue;
            }
            var value = attribute.DecodeValue(new AttributeTypeProvider());
            var arguments = value.FixedArguments.Select(argument => Argument(argument.Value))
                .Concat(value.NamedArguments.Select(argument => $"{argument.Name} = {Argument(argument.Value)}"))
                .ToList();
            var shortName = name[..^"Attribute".Length];
            rendered.Add(arguments.Count == 0 ? $"[{target}{shortName}]" : $"[{target}{shortName}({string.Join(", ", arguments)})]");
        }
        rendered.Sort(string.CompareOrdinal);
        return string.Concat(rendered.Select(annotation => annotation + " "));
    }

    private static string Argument(object? value) => value switch
    {
        null => "null",
        bool flag => flag ? "true" : "false",
        string text => Quote(text, '"'),
        ImmutableArray<CustomAttributeTypedArgument<string>> items => string.Join(", ", items.Select(item => Argument(item.Value))),
        IFormattable number => number.ToString(null, CultureInfo.InvariantCulture),
        _ => throw new NotSupportedException($"No snapshot form for an attribute argument of {value.GetType()}."),
    };

    /// <summary>The value of a <c>DecimalConstantAttribute</c>, or <c>null</c> when there is none.</summary>
    private decimal? DecimalConstant(CustomAttributeHandleCollection attributes)
    {
        if (MetadataValues.Find(_reader, attributes, MetadataValues.CompilerServices, "DecimalConstantAttribute") is not { } attribute)
        {
            return null;
        }
        var arguments = attribute.DecodeValue(new AttributeTypeProvider()).FixedArguments;
        // The attribute has a uint form and an int form of the three parts, with the same bits.
        int Part(int index) => unchecked((int)Convert.ToInt64(arguments[index].Value, CultureInfo.InvariantCulture));
        var scale = Convert.ToByte(arguments[0].Value, CultureInfo.InvariantCulture);
        var negative = Convert.ToByte(arguments[1].Value, CultureInfo.InvariantCulture) != 0;
        return new decimal(Part(4), Part(3), Part(2), negative, scale);
    }

    private static string DecimalLiteral(decimal value) => value.ToString(CultureInfo.InvariantCulture) + "M";

    // Values

    /// <summary>A constant as C# source writes it for a parameter or field of <paramref name="type"/>.</summary>
    private string Literal(object? value, SignatureType type)
    {
        while (type is ModifiedSignatureType modified)
        {
            type = modified.Unmodified;
        }
        if (type is GenericSignatureType { Definition: var definition } nullable && definition.Is("System", "Nullable`1"))
        {
            type = nullable.Arguments[0];
        }
        if (value is null)
        {
            return IsValueType(type) ? "default" : "null";
        }
        if (type is NamedSignatureType { IsValueType: true } named && value is not bool and not char and not string)
        {
            var typeName = TypeNames.Plain(named);
            var number = Number(value);
            return _enums.Name(typeName, number) ?? $"({typeName}){number}";
        }
        return value switch
        {
            bool flag => flag ? "true" : "false",
            string text => Quote(text, '"'),
            char character => Quote(character.ToString(), '\''),
            float single => single.ToString("R", CultureInfo.InvariantCulture) + "F",
            double number => number.ToString("R", CultureInfo.InvariantCulture),
            long number => number.ToString(CultureInfo.InvariantCulture) + "L",
            ulong number => number.ToString(CultureInfo.InvariantCulture) + "UL",
            uint number => number.ToString(CultureInfo.InvariantCulture) + "U",
            IFormattable number => number.ToString(null, CultureInfo.InvariantCulture),
            _ => throw new NotSupportedException($"No literal form for {value.GetType()}."),
        };
    }

    /// <summary>An integral constant in invariant digits. A <c>ulong</c> enum value can exceed <c>long</c>.</summary>
    private static string Number(object? value) =>
        Convert.ToString(value, CultureInfo.InvariantCulture)
            ?? throw new InvalidOperationException("An enum member has no value.");

    private static bool IsValueType(SignatureType type) => type switch
    {
        PrimitiveSignatureType primitive => primitive.Code is not (PrimitiveTypeCode.String or PrimitiveTypeCode.Object),
        NamedSignatureType named => named.IsValueType,
        GenericSignatureType generic => generic.Definition.IsValueType,
        _ => false,
    };

    private static string Quote(string text, char quote)
    {
        var builder = new StringBuilder().Append(quote);
        foreach (var character in text)
        {
            switch (character)
            {
                case '\\':
                    builder.Append(@"\\");
                    break;
                case '\n':
                    builder.Append(@"\n");
                    break;
                case '\r':
                    builder.Append(@"\r");
                    break;
                case '\t':
                    builder.Append(@"\t");
                    break;
                case '\0':
                    builder.Append(@"\0");
                    break;
                default:
                    if (character == quote)
                    {
                        builder.Append('\\').Append(character);
                    }
                    else if (char.IsControl(character) || char.IsSurrogate(character))
                    {
                        builder.Append(CultureInfo.InvariantCulture, $"\\u{(int)character:X4}");
                    }
                    else
                    {
                        builder.Append(character);
                    }
                    break;
            }
        }
        return builder.Append(quote).ToString();
    }
}
