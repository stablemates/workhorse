using System.Reflection;
using Workhorse.AspNetCore;
using Workhorse.EntityFrameworkCore;
using Workhorse.Hosting;

namespace Workhorse.Tests;

/// <summary>
/// Every public record of the four packages follows ADR 0107, "Public types grow only additively". A
/// new component of a constructor breaks callers, so a record has <c>init</c> properties and no
/// constructor parameter.
/// </summary>
public sealed class PublicRecordTests
{
    private const BindingFlags Constructors = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

    private static readonly Assembly[] Packages =
    [
        typeof(Queue).Assembly,
        typeof(WorkerHandlers).Assembly,
        typeof(WorkhorseDatabaseFacadeExtensions).Assembly,
        typeof(DashboardOptions).Assembly,
    ];

    public static TheoryData<Type> Records()
    {
        var records = new TheoryData<Type>();
        foreach (var type in Packages.SelectMany(assembly => assembly.GetExportedTypes()))
        {
            // The compiler writes the clone method behind `with` for every record class, and the ==
            // operator for every record struct. A record cannot declare its own == operator, and no
            // other type has a compiler-generated one.
            var isRecordClass = type.GetMethod("<Clone>$") is not null;
            var isRecordStruct = type.IsValueType
                && type.GetMethod("op_Equality", BindingFlags.Static | BindingFlags.Public) is { } equality
                && equality.IsDefined(typeof(System.Runtime.CompilerServices.CompilerGeneratedAttribute));
            if (isRecordClass || isRecordStruct)
            {
                records.Add(type);
            }
        }
        return records;
    }

    [Fact]
    public void ThePackagesHaveRecords() => Assert.True(Records().Count > 50);

    [Theory]
    [MemberData(nameof(Records))]
    public void ARecordHasNoConstructorParameterThatACallerCanPass(Type type)
    {
        // A positional record, an explicit constructor with parameters, and the protected copy
        // constructor of a record that is not sealed all fail here. A sealed record's copy
        // constructor is private, and a caller cannot call it.
        var visible = type.GetConstructors(Constructors)
            .Where(constructor => constructor.IsPublic || constructor.IsFamily || constructor.IsFamilyOrAssembly)
            .Where(constructor => constructor.GetParameters().Length > 0)
            .Select(constructor => constructor.ToString());
        Assert.Empty(visible);
        Assert.Null(type.GetMethod("Deconstruct"));
    }
}
