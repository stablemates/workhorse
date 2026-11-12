using Workhorse.AspNetCore.Internal;

namespace Workhorse.AspNetCore.Tests;

/// <summary>
/// A built-in procedure keeps the message of an <see cref="ArgumentException"/> only when Workhorse
/// code threw it. The message of a driver or a library can carry a stored value or an address.
/// </summary>
public sealed class ErrorOriginTests
{
    [Fact]
    public void KnowsAnArgumentExceptionOfAWorkhorseThrowHelperCall()
    {
        var error = Assert.ThrowsAny<ArgumentException>(() => DashboardAuthorization.Principal(" ", null));
        Assert.True(DashboardHost.RaisedByWorkhorse(error));
    }

    [Fact]
    public void KnowsAnArgumentExceptionOfALibrary()
    {
        var error = Assert.Throws<ArgumentException>(() => Enum.Parse<DayOfWeek>("driver-marker"));
        Assert.False(DashboardHost.RaisedByWorkhorse(error));
    }

    [Fact]
    public void KnowsAnArgumentExceptionOfApplicationCode()
    {
        var error = Assert.Throws<ArgumentException>(Fail);
        Assert.False(DashboardHost.RaisedByWorkhorse(error));

        static void Fail() => throw new ArgumentException("application-marker");
    }
}
