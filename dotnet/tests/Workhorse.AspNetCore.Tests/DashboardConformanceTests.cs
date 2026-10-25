using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Npgsql;
using NpgsqlTypes;
using Workhorse.AspNetCore.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.AspNetCore.Tests;

/// <summary>
/// Replays the shared <c>dashboard/v1</c> HTTP fixtures against the dashboard in Kestrel. The
/// counterpart of the JVM <c>DashboardConformanceTest</c> and of Ruby's
/// <c>dashboard_conformance_spec.rb</c>. <c>scripts/verify-dashboard-conformance.ts</c> is the
/// authority on the semantics of the file.
/// </summary>
public sealed partial class DashboardConformanceTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    private readonly Dictionary<string, JsonNode?> _references = new(StringComparer.Ordinal);

    [Fact]
    public async Task AnswersEverySharedExchangeAndReportsThePoliciesBehindAQueue()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var fixture = JsonNode.Parse(await File.ReadAllTextAsync(Repository.Path("dashboard/v1/conformance.json"), cancellationToken))!.AsObject();
        var harness = fixture["harness"]!.AsObject();
        var origin = Text(harness["origin"]);
        var scenarios = fixture["scenarios"]!.AsArray();

        // The fixture counts rows database-wide, so the exchanges run on a database of their own.
        await using var conformance = await ExtraDatabase.CreateAsync(database, "dashboard_conformance", install: true, cancellationToken);
        var dataSource = conformance.DataSource;
        foreach (var step in scenarios[0]!["seed"]!.AsArray())
        {
            await SeedAsync(dataSource, step!.AsObject(), cancellationToken);
        }

        var demo = new Queue(dataSource, new QueueOptions { DefaultQueue = "conformance-demo" });
        DashboardOptions Options(bool readOnly) => new()
        {
            DataSource = dataSource,
            Authorize = _ => ValueTask.FromResult(DashboardAuthorization.Principal(Text(harness["authenticatedActor"]), null)),
            Environment = Text(harness["environment"]),
            ReadOnly = readOnly,
            ConfiguredWorkers = [.. harness["configuredWorkers"]!.AsArray().Select(Text)],
            MaintenanceLoops = harness["maintenanceLoops"]!.AsObject()
                .ToDictionary(loop => loop.Key, loop => JsonSerializer.SerializeToElement(loop.Value), StringComparer.Ordinal),
            AllowedHosts = [new Uri(origin).Authority],
            EnqueueTest = async (input, _, token) =>
            {
                var priority = input.TryGetProperty("priority", out var value) ? value.GetInt32() : 0;
                var result = await demo.EnqueueAsync(
                    $"conformance.demo-{input.GetProperty("kind").GetString()}", new { }, new EnqueueOptions { Priority = priority }, token);
                return new { taskId = result.TaskId.ToString() };
            },
            SetSchedulePaused = async (input, actor, token) =>
            {
                await using var command = dataSource.CreateCommand(
                    "SELECT workhorse.set_schedule_paused_v1($1, $2, $3::boolean, $4, $5) AS paused");
                command.Parameters.Add(new NpgsqlParameter { Value = input.GetProperty("namespace").GetString() });
                command.Parameters.Add(new NpgsqlParameter { Value = input.GetProperty("name").GetString() });
                command.Parameters.Add(new NpgsqlParameter { Value = input.GetProperty("paused").GetBoolean() });
                command.Parameters.Add(new NpgsqlParameter { Value = (string)actor! });
                command.Parameters.Add(new NpgsqlParameter { Value = "Dashboard operator request" });
                return new { paused = (bool)(await command.ExecuteScalarAsync(token))! };
            },
        };

        await using var writable = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard(Text(harness["basePath"]), Options(readOnly: false)));
        await using var readOnly = await DashboardServer.StartAsync(app => app.MapWorkhorseDashboard(Text(harness["basePath"]), Options(readOnly: true)));
        // Each exchange that fails is reported, so one run names every difference from the contract.
        var count = 0;
        var failures = new List<string>();
        foreach (var scenario in scenarios.Skip(1))
        {
            foreach (var item in scenario!["exchanges"]!.AsArray())
            {
                var exchange = item!.AsObject();
                try
                {
                    await ExchangeAsync(exchange["mode"]?.GetValue<string>() == "read-only" ? readOnly : writable, exchange, harness);
                }
                catch (Exception error) when (error is Xunit.Sdk.IAssertionException or KeyNotFoundException or InvalidOperationException)
                {
                    failures.Add($"{Text(exchange["id"])}: {error.Message}");
                }

                count++;
            }
        }

        Assert.True(failures.Count == 0, string.Join("\n", failures));
        Assert.True(count > 100, $"replayed {count} exchanges");
        await PoliciesAsync(dataSource, writable, harness, cancellationToken);
    }

    /// <summary>The checks after the fixture that Ruby and the JVM also run: policies, batches, and retry storms.</summary>
    private async Task PoliciesAsync(NpgsqlDataSource dataSource, DashboardServer server, JsonObject harness, CancellationToken cancellationToken)
    {
        await ExecuteAsync(dataSource, """
            INSERT INTO workhorse.concurrency_policy(queue_name,namespace,max_active,max_active_per_key)
              VALUES ('conformance-demo','dashboard-test',7,2)
              ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
                max_active=excluded.max_active,max_active_per_key=excluded.max_active_per_key;
            INSERT INTO workhorse.rate_limit_policy(queue_name,namespace,rate_limit,rate_interval_ms,rate_burst,
                per_key_limit,per_key_interval_ms,per_key_burst)
              VALUES ('conformance-demo','dashboard-test',10,1000,12,3,2000,4)
              ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
                rate_limit=excluded.rate_limit,rate_interval_ms=excluded.rate_interval_ms,
                rate_burst=excluded.rate_burst,per_key_limit=excluded.per_key_limit,
                per_key_interval_ms=excluded.per_key_interval_ms,per_key_burst=excluded.per_key_burst;
            INSERT INTO workhorse.admission_shard(queue_name,shard,tokens,refilled_at)
              VALUES ('conformance-demo',0,0.5,clock_timestamp()+interval '1 hour')
              ON CONFLICT(queue_name,shard) DO UPDATE SET tokens=excluded.tokens,refilled_at=excluded.refilled_at;
            """, cancellationToken);

        Guid taskId;
        int attempt;
        await using (var command = dataSource.CreateCommand("""
            SELECT task.id,runtime.current_attempt FROM workhorse.dashboard_task_v1 task
              JOIN workhorse.dashboard_task_runtime_v1 runtime ON runtime.task_id=task.id
             WHERE task.queue_name='conformance-demo' ORDER BY task.created_at LIMIT 1
            """))
        {
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            Assert.True(await reader.ReadAsync(cancellationToken));
            taskId = reader.GetGuid(0);
            attempt = reader.GetInt32(1);
        }

        await using (var command = dataSource.CreateCommand("""
            INSERT INTO workhorse.task_event(task_id,attempt,event_type,details)
              VALUES ($1,$2,'batch_dispatched',jsonb_build_object(
                'batch_id','dashboard-semantic-batch','members',jsonb_build_array(
                  jsonb_build_object('task_id',$1,'attempt',$2))))
            """))
        {
            command.Parameters.Add(new NpgsqlParameter { Value = taskId });
            command.Parameters.Add(new NpgsqlParameter { Value = attempt });
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        // Outlast the queue health cache, so the next read sees the policies.
        await Task.Delay(3_100, cancellationToken);
        var queues = await RpcAsync(server, harness, "queues", null);
        var demo = queues["queues"]!.AsArray().Single(row => row!["queue"]!.GetValue<string>() == "conformance-demo")!;
        Assert.Equal(7, demo["concurrencyPolicy"]!["maxActive"]!.GetValue<long>());
        Assert.Equal(2, demo["concurrencyPolicy"]!["maxActivePerKey"]!.GetValue<long>());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("{\"limit\":10,\"intervalMs\":1000,\"burst\":12}"), demo["rateLimitPolicy"]!["rate"]));
        Assert.Equal(0.5, demo["rateLimitPolicy"]!["availableTokens"]!.GetValue<double>());

        var detail = await RpcAsync(server, harness, "taskDetail", new JsonObject { ["id"] = taskId.ToString() });
        Assert.Equal(7, detail["concurrencyPolicy"]!["maxActive"]!.GetValue<long>());
        Assert.Equal("dashboard-semantic-batch", detail["batchExecutions"]![0]!["id"]!.GetValue<string>());

        await ExecuteAsync(dataSource, """
            WITH task AS (
              INSERT INTO workhorse.task(queue_name,task_type,payload,max_attempts)
              VALUES ('conformance-demo','conformance.retry-summary','{}',3) RETURNING id
            ) INSERT INTO workhorse.task_runtime(task_id,queue_name,state,current_attempt,run_at)
              SELECT id,'conformance-demo','scheduled',2,clock_timestamp()+interval '30 seconds' FROM task
            """, cancellationToken);
        var system = await RpcAsync(server, harness, "system", new JsonObject { ["window"] = "1h" });
        Assert.True(system["retryStorm"]!["buckets"]![0]!["count"]!.GetValue<long>() >= 1);
        Assert.True(system["retryStorm"]!["topTypes"]![0]!["count"]!.GetValue<long>() >= 1);
    }

    private static async Task ExecuteAsync(NpgsqlDataSource dataSource, string sql, CancellationToken cancellationToken)
    {
        await using var command = dataSource.CreateCommand(sql);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<JsonNode> RpcAsync(DashboardServer server, JsonObject harness, string procedure, JsonNode? input)
    {
        var exchange = new JsonObject { ["procedure"] = procedure, ["request"] = new JsonObject { ["json"] = input } };
        var response = await SendAsync(server, exchange, harness);
        Assert.True(response.Status == 200, response.Text);
        return JsonNode.Parse(response.Text)!["json"]!;
    }

    private async Task ExchangeAsync(DashboardServer server, JsonObject exchange, JsonObject harness)
    {
        var id = Text(exchange["id"]);
        var response = await SendAsync(server, exchange, harness);
        Assert.True(
            string.Equals("application/json;charset=utf-8", response.Header("Content-Type").Replace(" ", "", StringComparison.Ordinal), StringComparison.OrdinalIgnoreCase),
            $"{id}: {response.Header("Content-Type")}");
        var expect = exchange["expect"]!.AsObject();
        Assert.True(expect["status"]!.GetValue<int>() == response.Status, $"{id}: status {response.Status}, {response.Text}");
        var body = JsonNode.Parse(response.Text);
        AssertValue(expect["body"], body, id);
        if (exchange["capture"] is JsonObject capture)
        {
            foreach (var (name, pointer) in capture)
            {
                _references[name] = Read(body, Text(pointer))?.DeepClone();
            }
        }
    }

    private Task<DashboardResponse> SendAsync(DashboardServer server, JsonObject exchange, JsonObject harness)
    {
        var origin = Text(harness["origin"]);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Host"] = exchange["host"]?.GetValue<string>() == "foreign" ? new Uri(Text(harness["crossOrigin"])).Authority : new Uri(origin).Authority,
            ["Content-Type"] = "application/json",
        };
        switch (exchange["origin"]?.GetValue<string>() ?? "same")
        {
            case "same":
                headers["Origin"] = origin;
                break;
            case "cross":
                headers["Origin"] = Text(harness["crossOrigin"]);
                break;
            default:
                break;
        }

        var body = Encoding.UTF8.GetBytes(Resolve(exchange["request"])?.ToJsonString() ?? "null");
        return server.RequestAsync(
            exchange["method"]?.GetValue<string>() ?? "POST",
            $"{Text(harness["basePath"])}/rpc/dashboard/{Text(exchange["procedure"])}",
            headers,
            body);
    }

    /// <summary>Runs one seed statement, checks its rows, and captures the values that it names.</summary>
    private async Task SeedAsync(NpgsqlDataSource dataSource, JsonObject step, CancellationToken cancellationToken)
    {
        var sql = Text(step["sql"]);
        var with = sql.TrimStart().StartsWith("WITH", StringComparison.OrdinalIgnoreCase);
        var statement = with ? sql : $"WITH step AS ({sql}) SELECT to_jsonb(step)::text AS row FROM step";
        await using var command = dataSource.CreateCommand(statement);
        foreach (var value in step["parameters"]?.AsArray() ?? [])
        {
            var resolved = Resolve(value);

            // An untyped parameter, as libpq sends text, so PostgreSQL infers its type.
            command.Parameters.Add(new NpgsqlParameter
            {
                NpgsqlDbType = NpgsqlDbType.Unknown,
                Value = resolved is null
                    ? DBNull.Value
                    : resolved is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : resolved.ToJsonString(),
            });
        }

        var rows = new JsonArray();
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                if (!with)
                {
                    rows.Add(JsonNode.Parse(reader.GetString(0)));
                    continue;
                }

                var row = new JsonObject();
                for (var column = 0; column < reader.FieldCount; column++)
                {
                    row[reader.GetName(column)] = reader.IsDBNull(column)
                        ? null
                        : reader.GetValue(column) switch
                        {
                            DateTime or DateTimeOffset => JsonValue.Create(reader.GetProviderSpecificValue(column).ToString()),
                            var value => JsonSerializer.SerializeToNode(value),
                        };
                }

                rows.Add(row);
            }
        }

        AssertValue(step["expect"]?["rows"] ?? new JsonArray(), rows, $"seed/{Text(step["id"])}");
        if (step["capture"] is JsonObject capture)
        {
            foreach (var (name, pointer) in capture)
            {
                _references[name] = Read(rows, Text(pointer))?.DeepClone();
            }
        }
    }

    private JsonNode? Resolve(JsonNode? value) => value switch
    {
        JsonArray items => new JsonArray([.. items.Select(Resolve)]),
        JsonObject { Count: 1 } reference when reference["$ref"] is JsonValue name && name.TryGetValue<string>(out var key) =>
            _references.TryGetValue(key, out var found) ? found?.DeepClone() : throw new InvalidOperationException($"unknown reference {key}"),
        JsonObject document => new JsonObject(document.Select(entry => KeyValuePair.Create(entry.Key, Resolve(entry.Value)))),
        _ => value?.DeepClone(),
    };

    private static JsonNode? Read(JsonNode? value, string pointer)
    {
        var current = value;
        foreach (var segment in pointer.Split('.'))
        {
            current = current is JsonArray items ? items[int.Parse(segment, CultureInfo.InvariantCulture)] : current![segment];
        }

        return current;
    }

    private void AssertValue(JsonNode? expected, JsonNode? actual, string location)
    {
        switch (expected)
        {
            case JsonObject document when document.ContainsKey("$ref"):
                var reference = _references[Text(document["$ref"])];
                Assert.True(Same(reference, actual), $"{location} expected {reference?.ToJsonString()}, received {actual?.ToJsonString()}");
                break;
            case JsonObject document when document["$type"] is JsonValue type && type.TryGetValue<string>(out var kind):
                Assert.True(Accepts(kind, actual), $"{location} expected {kind}, received {actual?.ToJsonString()}");
                break;
            case JsonObject document:
                var map = Assert.IsType<JsonObject>(actual, exactMatch: false);
                Assert.Equal(document.Select(entry => entry.Key).Order(StringComparer.Ordinal), map.Select(entry => entry.Key).Order(StringComparer.Ordinal));
                foreach (var (key, value) in document)
                {
                    AssertValue(value, map[key], $"{location}.{key}");
                }

                break;
            case JsonArray items:
                var list = Assert.IsType<JsonArray>(actual, exactMatch: false);
                Assert.True(items.Count == list.Count, $"{location} length; received {actual!.ToJsonString()}");
                for (var index = 0; index < items.Count; index++)
                {
                    AssertValue(items[index], list[index], $"{location}[{index}]");
                }

                break;
            default:
                Assert.True(Same(expected, actual), $"{location} expected {expected?.ToJsonString()}, received {actual?.ToJsonString()}");
                break;
        }
    }

    private static bool Accepts(string kind, JsonNode? actual)
    {
        var valueKind = actual?.GetValueKind() ?? JsonValueKind.Null;
        var text = valueKind == JsonValueKind.String ? actual!.GetValue<string>() : null;
        return kind switch
        {
            "any" => true,
            "uuid" => text is not null && UuidShape().IsMatch(text),
            "timestamp" => text is not null && TimestampShape().IsMatch(text)
                && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out _),
            "string" => text is not null,
            "integer" => valueKind == JsonValueKind.Number && actual!.ToJsonString().AsSpan().IndexOfAny(".eE") < 0,
            "number" => valueKind == JsonValueKind.Number,
            "boolean" => valueKind is JsonValueKind.True or JsonValueKind.False,
            _ => false,
        };
    }

    /// <summary>JSON equality, where two numbers are the same when their values are equal.</summary>
    private static bool Same(JsonNode? left, JsonNode? right)
    {
        var leftKind = left?.GetValueKind() ?? JsonValueKind.Null;
        var rightKind = right?.GetValueKind() ?? JsonValueKind.Null;
        if (leftKind == JsonValueKind.Number || rightKind == JsonValueKind.Number)
        {
            return leftKind == rightKind && Number(left!).Equals(Number(right!));
        }

        return JsonNode.DeepEquals(left, right);
    }

    private static (BigInteger Integer, double Real) Number(JsonNode node)
    {
        var text = node.ToJsonString();
        var real = double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
        return text.AsSpan().IndexOfAny(".eE") < 0
            ? (BigInteger.Parse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture), 0)
            : real == Math.Floor(real) && Math.Abs(real) < 1e15 ? (new BigInteger(real), 0) : (BigInteger.Zero, real);
    }

    private static string Text(JsonNode? node) => node?.GetValue<string>() ?? throw new InvalidOperationException("expected a string");

    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.IgnoreCase)]
    private static partial Regex UuidShape();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$")]
    private static partial Regex TimestampShape();
}
