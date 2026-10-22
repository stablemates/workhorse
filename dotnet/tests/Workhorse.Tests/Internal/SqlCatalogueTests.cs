using System.Text.RegularExpressions;
using Workhorse.AspNetCore.Internal;
using Workhorse.Internal;

namespace Workhorse.Tests.Internal;

/// <summary>The generated catalogues keep each native <c>$n</c> placeholder.</summary>
public sealed partial class SqlCatalogueTests
{
    [Fact]
    public void EveryStatementHasItsArityOfNativePlaceholders()
    {
        Assert.NotEmpty(SqlCatalogue.All);
        foreach (var statement in SqlCatalogue.All)
        {
            var highest = Placeholder().Matches(statement.Sql)
                .Select(match => int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture))
                .DefaultIfEmpty(0)
                .Max();
            Assert.Equal(statement.Arity, highest);
        }
    }

    [Fact]
    public void StatementNamesAreUnique()
    {
        var names = SqlCatalogue.All.Select(statement => statement.Name).ToList();
        Assert.Equal(names.Count, names.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void TheDashboardCatalogueHoldsOnlyCoreStatements()
    {
        var core = SqlCatalogue.All.ToDictionary(statement => statement.Name, statement => statement.Sql, StringComparer.Ordinal);
        foreach (var statement in DashboardSqlCatalogue.All)
        {
            Assert.Equal(core[statement.Name], statement.Sql);
        }
    }

    [GeneratedRegex(@"\$(\d+)")]
    private static partial Regex Placeholder();
}
