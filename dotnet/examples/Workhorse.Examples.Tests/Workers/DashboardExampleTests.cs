using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Workhorse.Examples.Workers;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Workers;

/// <summary>Runs the ASP.NET Core dashboard snippet in Kestrel on a loopback port.</summary>
public sealed class DashboardExampleTests(ScratchDatabase scratch)
{
    /// <summary>The application session of the test: the <c>X-User</c> header.</summary>
    private static string? Session(HttpContext context) =>
        context.Request.Headers.TryGetValue("X-User", out var user) ? user.ToString() : null;

    [Fact(Timeout = 120_000)]
    public async Task TheDashboardServesItsPathAndPassesTheOthers()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        new DashboardExample(scratch.DataSource, Session).Map(app);
        app.MapFallback(() => "host");
        await app.StartAsync(TestContext.Current.CancellationToken);
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        using var client = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false }) { BaseAddress = new Uri(address) };

        Assert.Equal(401, await StatusAsync(client, "/workhorse", user: null));
        Assert.Equal(302, await StatusAsync(client, "/workhorse", user: "dana"));
        Assert.Equal(200, await StatusAsync(client, "/other", user: null));
        await app.StopAsync(TestContext.Current.CancellationToken);
    }

    private static async Task<int> StatusAsync(HttpClient client, string path, string? user)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Host = "ops.example.com";
        if (user is not null)
        {
            request.Headers.Add("X-User", user);
        }

        using var response = await client.SendAsync(request, TestContext.Current.CancellationToken);
        return (int)response.StatusCode;
    }
}
