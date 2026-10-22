using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using Workhorse.AspNetCore.Internal;
using Workhorse.AspNetCore.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.AspNetCore.Tests;

/// <summary>The dashboard in Kestrel: mounting, authorization, the 503 rule, and procedure errors.</summary>
public sealed class DashboardHostTests(ScratchDatabase database)
{
    /// <summary>A data source whose every connection fails, with an address in the driver error.</summary>
    internal static NpgsqlDataSource Unreachable() =>
        NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Database=unreachable;Username=nobody;Timeout=2;Pooling=false");

    private DashboardOptions Options(Func<HttpContext, ValueTask<DashboardAuthorization>>? authorize = null) => new()
    {
        DataSource = database.DataSource,
        Authorize = authorize ?? (_ => ValueTask.FromResult(DashboardAuthorization.Principal("operator", null))),
        Environment = "aspnetcore-test",
    };

    [Fact]
    public async Task MountsUnderAPathBaseAndPassesOtherRequestsThrough()
    {
        await using var server = await DashboardServer.StartAsync(
            app => app.MapWorkhorseDashboard("/ops/workhorse/", Options()), pathBase: "/app");

        var root = await server.GetAsync("/app/ops/workhorse");
        Assert.Equal(302, root.Status);
        Assert.Equal("/app/ops/workhorse/tasks", root.Header("Location"));
        Assert.Equal(302, (await server.GetAsync("/app/ops/workhorse/")).Status);

        var shell = await server.GetAsync("/app/ops/workhorse/tasks/abc");
        Assert.Equal(200, shell.Status);
        Assert.StartsWith("text/html", shell.Header("Content-Type"), StringComparison.Ordinal);
        Assert.Contains("\"basePath\":\"/app/ops/workhorse\"", shell.Text, StringComparison.Ordinal);
        Assert.Contains("\"rpcUrl\":\"/app/ops/workhorse/rpc\"", shell.Text, StringComparison.Ordinal);

        var meta = await server.PostAsync("/app/ops/workhorse/rpc/dashboard/meta", "{\"json\":null}");
        Assert.Equal(200, meta.Status);
        Assert.Equal("{\"json\":{\"environment\":\"aspnetcore-test\"}}", meta.Text);

        foreach (var outside in new[] { "/app/elsewhere", "/app/ops/workhorsex", "/app/workhorse", "/app/ops" })
        {
            var passed = await server.GetAsync(outside);
            Assert.Equal(200, passed.Status);
            Assert.Equal("host", passed.Text);
        }
    }

    [Fact]
    public async Task MountsAtTheRoot()
    {
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/", Options()));
        Assert.Equal("/tasks", (await server.GetAsync("/")).Header("Location"));
        Assert.Contains("\"rpcUrl\":\"/rpc\"", (await server.GetAsync("/tasks")).Text, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => DashboardHost.NormalizePath("/workhorse/{tenant}"));
    }

    [Fact]
    public async Task ServesABundledAssetWithAnImmutableCachePolicy()
    {
        var asset = Bundle.Files.Keys.First(name => name.StartsWith("app/assets/", StringComparison.Ordinal) && name.EndsWith(".js", StringComparison.Ordinal));
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options()));
        var response = await server.GetAsync("/workhorse/" + asset["app/".Length..]);
        Assert.Equal(200, response.Status);
        Assert.Equal("public, max-age=31536000, immutable", response.Header("Cache-Control"));
        Assert.StartsWith("text/javascript", response.Header("Content-Type"), StringComparison.Ordinal);
        Assert.Equal(404, (await server.GetAsync("/workhorse/assets/missing.js")).Status);
        Assert.Equal(404, (await server.GetAsync("/workhorse/assets/x/%2e%2e%2f..%2f..%2fbundle.json")).Status);
    }

    [Fact]
    public async Task RefusesAHostOutsideAllowedHostsBeforeAuthorizing()
    {
        var calls = 0;
        var options = new DashboardOptions
        {
            DataSource = database.DataSource,
            Authorize = _ =>
            {
                Interlocked.Increment(ref calls);
                return ValueTask.FromResult(DashboardAuthorization.Allow());
            },
            AllowedHosts = ["Dashboard.test"],
        };
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", options));
        var foreign = await server.RequestAsync("GET", "/workhorse/tasks", new Dictionary<string, string> { ["Host"] = "evil.test" }, null);
        Assert.Equal(421, foreign.Status);
        Assert.Equal("{\"error\":\"Misdirected Request\"}", foreign.Text);
        Assert.Equal(0, calls);

        var allowed = await server.RequestAsync("GET", "/workhorse/tasks", new Dictionary<string, string> { ["Host"] = "DASHBOARD.test:80" }, null);
        Assert.Equal(200, allowed.Status);
        Assert.Equal(1, calls);

        foreach (var entry in new[] { "user@dashboard.test", "dashboard.test/path", "dashboard.test:", "" })
        {
            var refused = new DashboardOptions { DataSource = options.DataSource, Authorize = options.Authorize, AllowedHosts = [entry] };
            Assert.Throws<ArgumentException>(() => new DashboardHost("/workhorse", refused, NullLogger.Instance));
        }
    }

    [Fact]
    public async Task UsesTheAuditActorOnlyForABareAllow()
    {
        var allowed = Options(_ => ValueTask.FromResult(DashboardAuthorization.Allow()));
        await using (var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", With(allowed, auditActor: "ops-bot"))))
        {
            Assert.Contains("\"auditActor\":\"ops-bot\"", (await server.GetAsync("/workhorse/tasks")).Text, StringComparison.Ordinal);
        }

        await using (var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", With(Options(), auditActor: "ops-bot"))))
        {
            Assert.Contains("\"auditActor\":\"operator\"", (await server.GetAsync("/workhorse/tasks")).Text, StringComparison.Ordinal);
        }

        Assert.Throws<ArgumentException>(() => DashboardAuthorization.Principal(" ", null));
    }

    // SM-1473: as in the other hosts, a driver error stays in the log and out of the 503 body.
    [Fact]
    public async Task Answers503WithAGenericBodyAndLogsTheDriverError()
    {
        await using var unreachable = Unreachable();
        var options = new DashboardOptions
        {
            DataSource = unreachable,
            Authorize = _ => ValueTask.FromResult(DashboardAuthorization.Principal("operator", null)),
        };
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", options));
        foreach (var path in new[] { "/workhorse/tasks", "/workhorse/rpc/dashboard/meta", "/workhorse/assets/index.js" })
        {
            var response = path.Contains("/rpc/", StringComparison.Ordinal) ? await server.PostAsync(path, "{\"json\":null}") : await server.GetAsync(path);
            Assert.Equal(503, response.Status);
            Assert.Equal(
                "{\"error\":\"Unable to verify Workhorse schema compatibility because the database query failed.\"}",
                response.Text);
            Assert.DoesNotContain("127.0.0.1", response.Text, StringComparison.Ordinal);
            Assert.DoesNotContain("unreachable", response.Text, StringComparison.Ordinal);
            Assert.DoesNotContain("nobody", response.Text, StringComparison.Ordinal);
        }

        Assert.Contains(server.Logs.Records, record => record.Error is not null && Describe(record.Error).Contains("127.0.0.1", StringComparison.Ordinal));
    }

    // Npgsql hides the PostgreSQL DETAIL by default. The core reads the cause of a refused switch
    // from the copy in the HINT, so the default data source names each guard (ADR 0107).
    [Fact]
    public async Task NamesEachRefusedTierSwitchWithTheDefaultDataSource()
    {
        var token = TestContext.Current.CancellationToken;
        var live = $"dashboard-tier-live-{Guid.NewGuid():N}";
        var concurrency = $"dashboard-tier-concurrency-{Guid.NewGuid():N}";
        var rate = $"dashboard-tier-rate-{Guid.NewGuid():N}";
        await using (var seed = database.DataSource.CreateBatch())
        {
            seed.BatchCommands.Add(new NpgsqlBatchCommand(
                "SELECT count(*) FROM workhorse.enqueue_many_v1(jsonb_build_array(jsonb_build_object('queue',$1::text,'type','t','payload','{}'::jsonb)))")
            {
                Parameters = { new NpgsqlParameter { Value = live } },
            });
            seed.BatchCommands.Add(new NpgsqlBatchCommand(
                "INSERT INTO workhorse.concurrency_policy(queue_name,namespace,max_active,max_active_per_key) VALUES ($1,'dashboard-test',7,2)")
            {
                Parameters = { new NpgsqlParameter { Value = concurrency } },
            });
            seed.BatchCommands.Add(new NpgsqlBatchCommand(
                """
                INSERT INTO workhorse.rate_limit_policy(queue_name,namespace,rate_limit,rate_interval_ms,rate_burst,per_key_limit,per_key_interval_ms,per_key_burst)
                  VALUES ($1,'dashboard-test',10,1000,12,3,2000,4)
                """)
            {
                Parameters = { new NpgsqlParameter { Value = rate } },
            });
            await seed.ExecuteNonQueryAsync(token);
        }

        Assert.False(new NpgsqlConnectionStringBuilder(database.DataSource.ConnectionString).IncludeErrorDetail);
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options()));
        foreach (var (queue, status) in new[] { (live, "live_tasks"), (concurrency, "concurrency_policy"), (rate, "rate_limit_policy") })
        {
            var response = await server.PostAsync(
                "/workhorse/rpc/dashboard/setQueueTier",
                $"{{\"json\":{{\"queue\":\"{queue}\",\"tier\":\"fast\",\"audit\":{{\"actor\":\"a\",\"reason\":\"r\",\"requestId\":\"q\"}}}}}}");
            Assert.Equal(200, response.Status);
            Assert.Equal($"{{\"json\":{{\"status\":\"{status}\",\"tier\":null}}}}", response.Text);
        }
    }

    [Fact]
    public async Task KeepsTheContentLengthOfTheAuthorizersResponse()
    {
        var head = Options(_ => ValueTask.FromResult(
            DashboardAuthorization.Response(401, new Dictionary<string, string> { ["content-length"] = "12" }, ReadOnlyMemory<byte>.Empty)));
        await using (var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", head)))
        {
            var response = await server.RequestAsync("HEAD", "/workhorse/tasks", new Dictionary<string, string>(), null);
            Assert.Equal(401, response.Status);
            Assert.Equal("12", response.Header("Content-Length"));
        }

        var plain = Options(_ => ValueTask.FromResult(DashboardAuthorization.Response(403, new Dictionary<string, string>(), "no"u8.ToArray())));
        await using (var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", plain)))
        {
            var response = await server.GetAsync("/workhorse/tasks");
            Assert.Equal("2", response.Header("Content-Length"));
            Assert.Equal("no", response.Text);
        }
    }

    [Fact]
    public void ValidatesAndCopiesAnAuthorizationResponse()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => DashboardAuthorization.Response(99, new Dictionary<string, string>(), ReadOnlyMemory<byte>.Empty));
        Assert.Throws<ArgumentOutOfRangeException>(() => DashboardAuthorization.Response(600, new Dictionary<string, string>(), ReadOnlyMemory<byte>.Empty));
        var body = new byte[] { 1, 2 };
        var response = (DashboardAuthorization.ResponseResult)DashboardAuthorization.Response(401, new Dictionary<string, string>(), body);
        body[0] = 9;
        Assert.Equal(1, response.Body.Span[0]);
    }

    [Fact]
    public async Task EscapesTheRuntimeConfigurationAndBrowserModules()
    {
        var options = With(
            Options(_ => ValueTask.FromResult(DashboardAuthorization.Principal("</script><b>&\u2028", null))),
            browserModules: ["/x.js?a=1&b=\"2\""],
            enqueueTest: (_, _, _) => ValueTask.FromResult<object?>(null));
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", options));
        var html = (await server.GetAsync("/workhorse/tasks")).Text;
        Assert.Contains("\\u003c/script\\u003e\\u003cb\\u003e\\u0026\\u2028", html, StringComparison.Ordinal);
        Assert.DoesNotContain("</script><b>", html, StringComparison.Ordinal);
        Assert.Contains("<script type=\"module\" src=\"/x.js?a=1&amp;b=&quot;2&quot;\"></script>", html, StringComparison.Ordinal);
        Assert.Contains("\"demoTools\":true", html, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnswersProcedureErrorsWithTheRpcEnvelopeAndNoDetail()
    {
        var options = With(Options(), procedures: new Dictionary<string, DashboardProcedure>
        {
            ["queues"] = (_, _, _) => throw new DashboardRpcException(409, "CONFLICT", "busy", new { retry = true }),
            ["taskCounts"] = (_, _, _) => throw new InvalidOperationException("secret detail"),
            ["workers"] = (input, actor, _) => ValueTask.FromResult<object?>(new { actor, input }),
            ["humanWaits"] = (_, _, _) => ValueTask.FromResult<object?>(typeof(string)),
            ["settings"] = (_, _, _) => throw new DashboardRpcException(409, "CONFLICT", "busy", typeof(string)),
            ["cron"] = (_, _, _) => throw new DashboardRpcException(409, "CONFLICT", "busy", double.NaN),
            ["taskFacets"] = (_, _, _) => throw new DashboardRpcException(409, "CONFLICT", "busy", new JsonObject { ["value"] = double.NaN }),
        });
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", options));
        const string Rpc = "/workhorse/rpc/dashboard/";
        Assert.Equal(
            "{\"json\":{\"defined\":false,\"code\":\"CONFLICT\",\"status\":409,\"message\":\"busy\",\"data\":{\"retry\":true}}}",
            (await server.PostAsync(Rpc + "queues", "{}")).Text);
        var failed = await server.PostAsync(Rpc + "taskCounts", "{}");
        Assert.Equal(500, failed.Status);
        Assert.DoesNotContain("secret", failed.Text, StringComparison.Ordinal);
        Assert.Equal("{\"json\":{\"actor\":\"operator\",\"input\":null}}", (await server.PostAsync(Rpc + "workers", "{}")).Text);

        foreach (var procedure in new[] { "humanWaits", "settings", "cron", "taskFacets" })
        {
            var unencodable = await server.PostAsync(Rpc + procedure, "{}");
            Assert.Equal(500, unencodable.Status);
            Assert.Equal("{\"json\":{\"defined\":false,\"code\":\"INTERNAL_SERVER_ERROR\",\"status\":500,\"message\":\"Internal server error\"}}", unencodable.Text);
        }

        foreach (var page in new[] { "0", "-9223372036854775809" })
        {
            var small = await server.PostAsync(Rpc + "tasks", $"{{\"json\":{{\"page\":{page}}}}}");
            Assert.Equal(400, small.Status);
            Assert.Contains("\"code\":\"too_small\"", small.Text, StringComparison.Ordinal);
        }

        Assert.Equal(405, (await server.GetAsync(Rpc + "meta")).Status);
        Assert.Equal(404, (await server.PostAsync(Rpc + "nothing", "{}")).Status);
        var optional = await server.PostAsync(Rpc + "enqueueTest", "{}");
        Assert.Equal(403, optional.Status);
        Assert.Contains("This procedure is not available", optional.Text, StringComparison.Ordinal);
        Assert.Equal(400, (await server.PostAsync(Rpc + "meta", "[1]")).Status);
        Assert.Equal(400, (await server.PostAsync(Rpc + "meta", "{")).Status);
        Assert.Equal(400, (await server.PostAsync(Rpc + "meta", "{\"json\":{}}")).Status);
        Assert.Equal(400, (await server.PostAsync(Rpc + "meta", "{\"json\":null,\"json\":null}")).Status);
        var invalidUtf8 = await server.RequestAsync(
            "POST", Rpc + "meta", new Dictionary<string, string> { ["Origin"] = $"http://{server.Authority}" }, [.. "{\"json\":\""u8, 0xff, .. "\"}"u8]);
        Assert.Equal(400, invalidUtf8.Status);

        var large = await server.PostAsync(Rpc + "meta", new string(' ', DashboardHost.MaxRequestBytes + 1));
        Assert.Equal(413, large.Status);
        Assert.Equal("PAYLOAD_TOO_LARGE", JsonNode.Parse(large.Text)!["json"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task RefusesAnEventRangeThatTheSchemaCannotState()
    {
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options()));
        const string Events = "/workhorse/rpc/dashboard/events";
        var half = await server.PostAsync(Events, "{\"json\":{\"rangeStart\":\"2026-10-22T10:00:00Z\"}}");
        Assert.Equal(400, half.Status);
        Assert.Equal(
            "{\"json\":{\"defined\":false,\"code\":\"BAD_REQUEST\",\"status\":400,\"message\":\"Input validation failed\",\"data\":{\"issues\":[{\"code\":\"custom\",\"path\":[\"rangeEnd\"],\"message\":\"rangeStart and rangeEnd must be supplied together\"}]}}}",
            half.Text);
        var reversed = await server.PostAsync(
            Events, "{\"json\":{\"rangeStart\":\"2026-10-22T10:00:00.0001Z\",\"rangeEnd\":\"2026-10-22T10:00:00Z\"}}");
        Assert.Equal(400, reversed.Status);
        Assert.Contains("rangeEnd must be later than rangeStart", reversed.Text, StringComparison.Ordinal);
        var ordered = await server.PostAsync(
            Events, "{\"json\":{\"rangeStart\":\"2026-10-22T10:00:00Z\",\"rangeEnd\":\"2026-10-22T11:00:00.123456789Z\"}}");
        Assert.Equal(200, ordered.Status);
    }

    [Theory]
    [InlineData("1")]
    [InlineData("1.0")]
    [InlineData("1e0")]
    [InlineData("10E-1")]
    [InlineData("1.0000000000000001")]
    public async Task AcceptsAnIntegerInEveryNumericForm(string page)
    {
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options()));
        var response = await server.PostAsync("/workhorse/rpc/dashboard/tasks", $"{{\"json\":{{\"page\":{page}}}}}");
        Assert.Equal(200, response.Status);
        Assert.Equal(400, (await server.PostAsync("/workhorse/rpc/dashboard/tasks", "{\"json\":{\"page\":1.5}}")).Status);
    }

    [Theory]
    [InlineData("1e-29", "1e-29")]
    [InlineData("0.5", "0.5")]
    [InlineData("-0.0", "0")]
    [InlineData("2E0", "2")]
    [InlineData("1e300", "1e300")]
    [InlineData("12345678901234567890", "12345678901234567890")]
    public void KeepsEveryNumberThatIsNotASafeInteger(string number, string written) =>
        Assert.Equal($"{{\"value\":{written}}}", DashboardHost.Parse(Encoding.UTF8.GetBytes($"{{\"value\":{number}}}"))!.ToJsonString());

    [Fact]
    public async Task RefusesALongNumberInTheRequestBodyQuickly()
    {
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options()));
        const string Tasks = "/workhorse/rpc/dashboard/tasks";
        var limit = new string('1', DashboardHost.MaxRequestNumberLength);
        var accepted = await server.PostAsync(Tasks, $"{{\"json\":{{\"page\":{limit}}}}}");
        Assert.DoesNotContain("a number longer than", accepted.Text, StringComparison.Ordinal);

        var refused = await server.PostAsync(Tasks, $"{{\"json\":{{\"page\":-{limit}1}}}}");
        Assert.Equal(400, refused.Status);
        Assert.Contains("a number longer than 1000 characters", refused.Text, StringComparison.Ordinal);

        var started = Stopwatch.StartNew();
        var large = await server.PostAsync(Tasks, $"{{\"json\":{{\"page\":{new string('9', 2_000_000)}}}}}");
        Assert.Equal(400, large.Status);
        Assert.True(started.ElapsedMilliseconds < 2000, $"the dashboard answered after {started.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task ReadsTheEmptyBodyAsAnEmptyEnvelope()
    {
        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options()));
        var response = await server.RequestAsync("POST", "/workhorse/rpc/dashboard/meta", new Dictionary<string, string>(), []);
        Assert.Equal(200, response.Status);
    }

    // SM-1531: a stored value without a payload contract can hold integers of 131,072 digits. The
    // dashboard writes the text of PostgreSQL into the response without a number parse.
    [Fact]
    public async Task WritesAStoredValueWithLongIntegersUnchanged()
    {
        var id = (await new Queue(database.DataSource).EnqueueAsync("dashboard.long-integers", new { }, TestContext.Current.CancellationToken)).TaskId;
        var digits = Enumerable.Range(0, 7).Select(index => (index % 2 == 0 ? "" : "-") + new string((char)('1' + index), 131_072));
        var payload = "[" + string.Join(',', digits) + "]";
        await using (var update = database.DataSource.CreateCommand("UPDATE workhorse.task SET payload = $1::jsonb WHERE id = $2"))
        {
            update.Parameters.Add(new NpgsqlParameter { Value = payload, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text });
            update.Parameters.Add(new NpgsqlParameter { Value = id });
            Assert.Equal(1, await update.ExecuteNonQueryAsync(TestContext.Current.CancellationToken));
        }

        await using var server = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard("/workhorse", Options()));
        var response = await server.PostAsync("/workhorse/rpc/dashboard/taskValue", $"{{\"json\":{{\"id\":\"{id}\",\"kind\":\"payload\"}}}}");
        Assert.Equal(200, response.Status);
        using var document = JsonDocument.Parse(response.Text);
        var value = document.RootElement.GetProperty("json").GetProperty("value");
        Assert.Equal(payload, JsonSerializer.Serialize(value).Replace(" ", "", StringComparison.Ordinal));
    }

    private static string Describe(Exception error)
    {
        var text = new StringBuilder();
        for (var current = error; current is not null; current = current.InnerException)
        {
            text.Append(current.Message).Append('\n');
        }

        return text.ToString();
    }

    private static DashboardOptions With(
        DashboardOptions options,
        string? auditActor = null,
        IReadOnlyList<string>? browserModules = null,
        DashboardProcedure? enqueueTest = null,
        IReadOnlyDictionary<string, DashboardProcedure>? procedures = null) => new()
        {
            DataSource = options.DataSource,
            Authorize = options.Authorize,
            Environment = options.Environment,
            AuditActor = auditActor ?? options.AuditActor,
            BrowserModules = browserModules ?? options.BrowserModules,
            EnqueueTest = enqueueTest ?? options.EnqueueTest,
            Procedures = procedures ?? options.Procedures,
            AllowedHosts = options.AllowedHosts,
        };
}
