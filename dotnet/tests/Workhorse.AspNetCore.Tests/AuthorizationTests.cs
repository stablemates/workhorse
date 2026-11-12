using Microsoft.AspNetCore.Builder;
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

    // SM-2042: a cancellation that the request did not cause is a failure of the authorizer. The
    // dashboard answers it, so error middleware that shows exception detail never receives it.
    [Theory]
    [InlineData(false, "GET", "/workhorse/tasks")]
    [InlineData(false, "POST", "/workhorse/rpc/dashboard/meta")]
    [InlineData(true, "GET", "/workhorse/tasks")]
    [InlineData(true, "POST", "/workhorse/rpc/dashboard/meta")]
    public async Task AnswersAnAuthorizerCancellationThatTheRequestDidNotCauseWith500AndNoDetail(bool task, string method, string path)
    {
        const string marker = "authorizer-marker-7f3a";
        var calls = new List<string>();
        await using var unreachable = DashboardHostTests.Unreachable();
        await using var server = await DashboardServer.StartAsync(app =>
        {
            app.UseDeveloperExceptionPage();
            app.MapWorkhorseDashboard("/workhorse", Refusing(
                _ => throw (task ? new TaskCanceledException(marker) : new OperationCanceledException(marker)),
                calls,
                unreachable));
        });

        var response = method == "GET" ? await server.GetAsync(path) : await server.PostAsync(path, "{}");

        Assert.Equal(500, response.Status);
        Assert.Equal("{\"error\":\"Internal Server Error\"}", response.Text);
        Assert.DoesNotContain(marker, response.Text, StringComparison.Ordinal);
        Assert.DoesNotContain("DashboardHost", response.Text, StringComparison.Ordinal);
        Assert.Empty(calls);
        Assert.Contains(server.Logs.Records, record =>
            record.Message == "workhorse dashboard: the authorizer failed" && record.Error?.Message == marker);
    }

    // A cancellation that the request caused ends the request with no answer and no error log.
    [Fact]
    public async Task EndsARequestThatTheClientCanceledDuringAuthorizationWithNoAnswer()
    {
        var calls = new List<string>();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var ended = new TaskCompletionSource<Exception?>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var unreachable = DashboardHostTests.Unreachable();
        await using var server = await DashboardServer.StartAsync(app =>
        {
            // This middleware runs around the dashboard endpoint, so it sees each exception that
            // leaves the dashboard.
            app.Use(async (context, next) =>
            {
                try
                {
                    await next(context);
                    ended.TrySetResult(null);
                }
                catch (Exception error)
                {
                    ended.TrySetResult(error);
                    throw;
                }
            });
            app.MapWorkhorseDashboard("/workhorse", Refusing(
                async context =>
                {
                    entered.TrySetResult();
                    await Task.Delay(Timeout.Infinite, context.RequestAborted);
                    return DashboardAuthorization.Allow();
                },
                calls,
                unreachable));
        });

        using var client = new HttpClient { BaseAddress = server.Address };
        using var cancel = new CancellationTokenSource();
        var request = client.GetAsync("workhorse/tasks", cancel.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        await cancel.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);

        Assert.Null(await ended.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));
        Assert.Empty(calls);
        Assert.DoesNotContain(server.Logs.Records, record => record.Error is not null);
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
