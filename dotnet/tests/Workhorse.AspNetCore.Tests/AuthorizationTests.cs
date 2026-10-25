using Microsoft.AspNetCore.Http;
using Workhorse.AspNetCore.Internal;
using Workhorse.AspNetCore.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.AspNetCore.Tests;

/// <summary>
/// Authorization on every <c>dashboard/v1</c> procedure (ADR 0029). The dashboard calls
/// <see cref="DashboardOptions.Authorize"/> before any other work, so a refused request reaches no
/// procedure and no database.
/// </summary>
public sealed class AuthorizationTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private static readonly string[] Pages = ["/workhorse", "/workhorse/tasks", "/workhorse/assets/missing.js"];

    /// <summary>
    /// Every procedure is a host procedure that records its call, so a call that passes
    /// authorization is visible. The data source fails every connection, so a request that passes
    /// authorization gets 503, not 401.
    /// </summary>
    private static DashboardOptions Refusing(Func<HttpContext, ValueTask<DashboardAuthorization>> authorize, List<string> calls, Npgsql.NpgsqlDataSource dataSource) => new()
    {
        DataSource = dataSource,
        Authorize = authorize,
        Procedures = V1.Procedures.ToDictionary(
            name => name,
            name => (DashboardProcedure)((_, _, _) =>
            {
                lock (calls)
                {
                    calls.Add(name);
                }

                return ValueTask.FromResult<object?>(null);
            }),
            StringComparer.Ordinal),
    };

    [Fact]
    public async Task RefusesEveryProcedureAndPageOnADeny()
    {
        var calls = new List<string>();
        await using var unreachable = DashboardHostTests.Unreachable();
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard(
            "/workhorse", Refusing(_ => ValueTask.FromResult(DashboardAuthorization.Deny()), calls, unreachable)));

        Assert.Equal(38, V1.Procedures.Count);
        foreach (var procedure in V1.Procedures)
        {
            var response = await server.PostAsync($"/workhorse/rpc/dashboard/{procedure}", "{\"json\":{}}");
            Assert.Equal(401, response.Status);
            Assert.Equal("{\"error\":\"Unauthorized\"}", response.Text);
        }

        foreach (var page in Pages)
        {
            Assert.Equal(401, (await server.GetAsync(page)).Status);
        }

        Assert.Empty(calls);
        Assert.DoesNotContain(server.Logs.Records, record => record.Error is not null);
    }

    // SM-1458: as in the other SDKs, the authorizer can give a complete response.
    [Fact]
    public async Task SendsTheAuthorizersResponseForEveryProcedureAndDoesNoOtherWork()
    {
        var calls = new List<string>();
        await using var unreachable = DashboardHostTests.Unreachable();
        var redirect = DashboardAuthorization.Response(302, new Dictionary<string, string> { ["Location"] = "/login?next=/workhorse" }, ReadOnlyMemory<byte>.Empty);
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard(
            "/workhorse", Refusing(_ => ValueTask.FromResult(redirect), calls, unreachable)));

        foreach (var path in Pages.Concat(V1.Procedures.Select(procedure => $"/workhorse/rpc/dashboard/{procedure}")))
        {
            var response = path.Contains("/rpc/", StringComparison.Ordinal) ? await server.PostAsync(path, "{}") : await server.GetAsync(path);
            Assert.Equal(302, response.Status);
            Assert.Equal("/login?next=/workhorse", response.Header("Location"));
        }

        Assert.Empty(calls);
    }

    [Fact]
    public async Task AnswersAFailedAuthorizerWith500AndNoDetail()
    {
        var calls = new List<string>();
        await using var unreachable = DashboardHostTests.Unreachable();
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard(
            "/workhorse", Refusing(_ => throw new InvalidOperationException("session store secret"), calls, unreachable)));
        var response = await server.PostAsync("/workhorse/rpc/dashboard/meta", "{}");
        Assert.Equal(500, response.Status);
        Assert.DoesNotContain("secret", response.Text, StringComparison.Ordinal);
        Assert.Empty(calls);
    }

    [Fact]
    public async Task AssignsTheAuditActorFromThePrincipal()
    {
        string? received = null;
        var principal = new DashboardOptions
        {
            DataSource = database.DataSource,
            Authorize = _ => ValueTask.FromResult(DashboardAuthorization.Principal("verified-operator", null)),
            EnqueueTest = (input, actor, _) =>
            {
                received = input.GetProperty("audit").GetProperty("actor").GetString();
                return ValueTask.FromResult<object?>(new { actor });
            },
        };
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", principal));
        var response = await server.PostAsync(
            "/workhorse/rpc/dashboard/enqueueTest",
            "{\"json\":{\"kind\":\"success\",\"audit\":{\"actor\":\"forged\",\"reason\":\"r\",\"requestId\":\"q\"}}}");
        Assert.Equal(200, response.Status);
        Assert.Equal("{\"json\":{\"actor\":\"verified-operator\"}}", response.Text);
        Assert.Equal("verified-operator", received);
    }
}
