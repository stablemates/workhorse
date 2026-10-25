using System.Transactions;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Workhorse.AspNetCore.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.AspNetCore.Tests;

/// <summary>
/// The boundary of the mount: CORS, the same-origin check, parent route groups, host procedure
/// errors, and recovery after a compatibility refusal.
/// </summary>
public sealed class DashboardBoundaryTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private int _authorizations;

    private DashboardOptions Options(Npgsql.NpgsqlDataSource? dataSource = null, IReadOnlyDictionary<string, DashboardProcedure>? procedures = null) => new()
    {
        DataSource = dataSource ?? database.DataSource,
        Authorize = _ =>
        {
            Interlocked.Increment(ref _authorizations);
            return ValueTask.FromResult(DashboardAuthorization.Principal("operator", null));
        },
        Procedures = procedures ?? new Dictionary<string, DashboardProcedure>(),
        EnqueueTest = (_, _, _) => ValueTask.FromResult<object?>(new { ok = true }),
    };

    [Fact]
    public async Task RefusesACrossOriginReadUnderAHostCorsPolicy()
    {
        await using var server = await DashboardServer.StartAsync(
            app =>
            {
                app.UseCors();
                app.MapWorkhorseDashboard("/workhorse", Options());
            },
            services: services => services.AddCors(cors => cors.AddDefaultPolicy(policy =>
                policy.WithOrigins("http://attacker.test").AllowCredentials().AllowAnyHeader().AllowAnyMethod())));

        var read = await server.RequestAsync(
            "POST", "/workhorse/rpc/dashboard/meta", new Dictionary<string, string> { ["Origin"] = "http://attacker.test" }, "{}"u8.ToArray());
        Assert.Equal(403, read.Status);
        Assert.Equal("{\"error\":\"A same-origin request is required\"}", read.Text);
        var page = await server.RequestAsync("GET", "/workhorse/tasks", new Dictionary<string, string> { ["Origin"] = "http://attacker.test" }, null);
        Assert.Equal(403, page.Status);
        Assert.DoesNotContain("auditActor", page.Text, StringComparison.Ordinal);

        // A same-origin read and a navigation without Origin still work.
        Assert.Equal(200, (await server.PostAsync("/workhorse/rpc/dashboard/meta", "{}")).Status);
        Assert.Equal(200, (await server.GetAsync("/workhorse/tasks")).Status);
    }

    [Theory]
    [InlineData("DASHBOARD.test", "http://dashboard.test", 200)]
    [InlineData("dashboard.test:80", "http://dashboard.test", 200)]
    [InlineData("dashboard.test", "http://dashboard.test:80", 200)]
    [InlineData("dashboard.test", "https://dashboard.test", 403)]
    [InlineData("dashboard.test", "http://dashboard.test:8080", 403)]
    [InlineData("dashboard.test", "http://dashboard.test/", 403)]
    [InlineData("dashboard.test", "http://user@dashboard.test", 403)]
    [InlineData("dashboard.test", "null", 403)]
    public async Task ComparesTheOriginByItsSchemeHostAndPort(string host, string origin, int status)
    {
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options()));
        var response = await server.RequestAsync(
            "POST",
            "/workhorse/rpc/dashboard/enqueueTest",
            new Dictionary<string, string> { ["Host"] = host, ["Origin"] = origin },
            "{\"json\":{\"kind\":\"success\",\"audit\":{\"actor\":\"a\",\"reason\":\"r\",\"requestId\":\"q\"}}}"u8.ToArray());
        Assert.Equal(status, response.Status);
    }

    [Fact]
    public async Task MountsInsideAParentRouteGroup()
    {
        await using var server = await DashboardServer.StartAsync(
            app => app.MapGroup("/ops").MapWorkhorseDashboard("/workhorse", Options()), pathBase: "/app");
        Assert.Equal("/app/ops/workhorse/tasks", (await server.GetAsync("/app/ops/workhorse")).Header("Location"));
        var meta = await server.PostAsync("/app/ops/workhorse/rpc/dashboard/meta", "{}");
        Assert.Equal(200, meta.Status);
        Assert.StartsWith("{\"json\":", meta.Text, StringComparison.Ordinal);
        var shell = await server.GetAsync("/app/ops/workhorse/tasks");
        Assert.Contains("\"basePath\":\"/app/ops/workhorse\"", shell.Text, StringComparison.Ordinal);
        Assert.Contains("\"rpcUrl\":\"/app/ops/workhorse/rpc\"", shell.Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ShowsOnlyARefusalMessageFromAHostProcedure()
    {
        var options = Options(procedures: new Dictionary<string, DashboardProcedure>
        {
            ["queues"] = (_, _, _) => throw new ArgumentException("Host=db.internal;Password=secret"),
        });
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", options));
        var response = await server.PostAsync("/workhorse/rpc/dashboard/queues", "{}");
        Assert.Equal(500, response.Status);
        Assert.DoesNotContain("secret", response.Text, StringComparison.Ordinal);
        Assert.DoesNotContain("db.internal", response.Text, StringComparison.Ordinal);
    }

    // ADR 0107: each statement runs in autocommit. A host that wraps each request in a
    // TransactionScope and rolls it back must not undo a dashboard control.
    [Fact]
    public async Task KeepsAControlWhenTheHostRollsBackItsAmbientTransaction()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var task = await new Queue(database.DataSource).EnqueueAsync(
            "dashboard.run-now", new { }, new EnqueueOptions { RunAt = DateTimeOffset.UtcNow.AddHours(1) }, cancellationToken);
        await using var server = await DashboardServer.StartAsync(app =>
        {
            app.Use(async (context, next) =>
            {
                using var scope = new TransactionScope(TransactionScopeOption.Required, TransactionScopeAsyncFlowOption.Enabled);
                await next(context);

                // The scope ends without Complete, so it rolls back each enlisted connection.
            });
            app.MapWorkhorseDashboard("/workhorse", Options());
        });
        var response = await server.PostAsync(
            "/workhorse/rpc/dashboard/runTaskNow",
            $"{{\"json\":{{\"id\":\"{task.TaskId}\",\"audit\":{{\"actor\":\"a\",\"reason\":\"r\",\"requestId\":\"q\"}}}}}}");
        Assert.Equal(200, response.Status);

        await using var command = database.DataSource.CreateCommand("SELECT state FROM workhorse.task_runtime WHERE task_id = $1");
        command.Parameters.Add(new Npgsql.NpgsqlParameter { Value = task.TaskId });
        Assert.Equal("ready", (string?)await command.ExecuteScalarAsync(cancellationToken));
    }

    [Fact]
    public async Task RecoversAfterTheOperatorInstallsTheSchema()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        await using var empty = await ExtraDatabase.CreateAsync(database, "dashboard_recovery", install: false, cancellationToken);
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options(empty.DataSource)));
        var refused = await server.PostAsync("/workhorse/rpc/dashboard/meta", "{}");
        Assert.Equal(503, refused.Status);
        Assert.Contains("schema-not-installed", refused.Text, StringComparison.Ordinal);

        await empty.InstallAsync(cancellationToken);
        Assert.Equal(200, (await server.PostAsync("/workhorse/rpc/dashboard/meta", "{}")).Status);
        Assert.Equal(200, (await server.PostAsync("/workhorse/rpc/dashboard/queues", "{}")).Status);
    }
}
