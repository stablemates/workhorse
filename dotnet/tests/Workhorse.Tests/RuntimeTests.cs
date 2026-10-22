namespace Workhorse.Tests;

/// <summary>Each CI lane names the .NET runtime that it tests, and the tests run on it.</summary>
public sealed class RuntimeTests
{
    [Fact]
    public void RunsOnTheRuntimeThatTheLaneNames()
    {
        var expected = Environment.GetEnvironmentVariable("WORKHORSE_DOTNET_RUNTIME");
        if (string.IsNullOrEmpty(expected))
        {
            Assert.Skip("WORKHORSE_DOTNET_RUNTIME is unset, so any runtime is the lane's runtime");
        }

        Assert.Equal(expected, Environment.Version.Major.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }
}
