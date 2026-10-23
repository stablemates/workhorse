using System.Globalization;
using System.Text;
using System.Text.Json;
using Npgsql;
using Workhorse.Internal;
using Workhorse.Internal.Contracts;
using Workhorse.Internal.Database;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// Executes every <c>protocol/v1</c> fixture through the C# SDK, and reconciles the outcomes with
/// the expected-unsupported list. The counterpart of the JVM <c>Runner</c>.
/// </summary>
internal sealed class Runner(Catalogue catalogue, IReadOnlyList<Ledger.Entry> entries, string protocol, ConformanceDatabases databases)
{
    private const string Cron =
        "SELECT occurrence_at::text AS occurrence_at FROM workhorse.cron_occurrences_v1($1::text, $2::timestamptz, $3::timestamptz, $4::integer, $5::text) occurrence_at";

    private readonly Dictionary<string, Outcome> _outcomes = new(StringComparer.Ordinal);

    internal IReadOnlyDictionary<string, Outcome> Outcomes => _outcomes;

    /// <summary>The disagreements between the fixtures and the list. An empty result is a clean run.</summary>
    internal async Task<IReadOnlyList<string>> RunAsync()
    {
        EachFixture("interpreter", RunInterpreter);
        EachFixture("contracts", RunContract);
        var problems = new List<string>();

        // The scenarios compare DETAIL as well as HINT, so their session shows DETAIL.
        await using (var scenarios = await databases.CreateAsync("protocol_conformance_scenarios", builder => builder.IncludeErrorDetail = true))
        await using (var connection = await scenarios.DataSource.OpenConnectionAsync())
        {
            problems.AddRange(RunScenarios(connection));
        }

        await using (var adapters = await databases.CreateAsync("protocol_conformance_adapters"))
        await using (var setup = await adapters.DataSource.OpenConnectionAsync())
        {
            RunCron(setup);
            await RunRequestsAsync(adapters.DataSource, setup);
            await RunSchedulesAsync(adapters.DataSource, setup);

            // Compatibility rewrites the version tables, so it runs after every other adapter.
            await RunCompatibilityAsync(adapters.DataSource, setup);
        }

        await using (var runtime = await databases.CreateAsync("protocol_conformance_runtime"))
        {
            var adapter = new RuntimeFixtures(runtime, protocol);
            await using (adapter.ConfigureAwait(false))
            {
                await EachFixtureAsync("failures", adapter.FailureAsync);
                foreach (var fixture in catalogue.Category("runtime"))
                {
                    Record("runtime", fixture, RuntimeFixtures.Gap(fixture) is { } gap
                        ? Outcome.Unsupported(gap)
                        : await AttemptAsync(() => adapter.RunAsync(fixture)));
                }
            }
        }

        problems.AddRange(Ledger.Reconcile(catalogue.Declared(), _outcomes, entries));
        return problems;
    }

    /// <summary>The count for each status, and every fixture that did not pass.</summary>
    internal string Report()
    {
        var counts = _outcomes.Values.GroupBy(outcome => outcome.Status).OrderBy(group => group.Key).Select(group => $"{group.Key}={group.Count()}");
        var report = new StringBuilder($".NET protocol conformance: {{{string.Join(", ", counts)}}}");
        foreach (var (fixture, outcome) in _outcomes.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (outcome.Status != OutcomeStatus.Passed)
            {
                report.Append(CultureInfo.InvariantCulture, $"\n  {outcome.Status.ToString().ToLowerInvariant(),-11} {fixture}: {outcome.Reason}");
            }
        }

        return report.ToString();
    }

    // ----- contracts -----------------------------------------------------------------------------

    /// <summary>
    /// A contract fixture compiles its schema the way <c>Queue.SyncContractsAsync</c> does, then
    /// checks the verdict of each instance. <see cref="JsonTree"/> holds every number exactly, so the
    /// runner runs the <c>exactFraction</c>, <c>exactInteger</c>, and <c>exactBigInteger</c> instances too.
    /// </summary>
    internal static void RunContract(OrderedDictionary<string, object?> fixture)
    {
        var schemaError = fixture.GetValueOrDefault("schemaError") is true;
        ContractSchema schema;
        try
        {
            // A schema in JSON text reads the way a schema that PostgreSQL stores does.
            schema = new ContractSchema(fixture.GetValueOrDefault("schemaJson") is string text
                ? JsonTree.Parse(text)
                : JsonTree.From(Json.Element(fixture.GetValueOrDefault("schema"))));
        }
        catch (ArgumentException error)
        {
            if (schemaError)
            {
                return;
            }

            throw new Failure($"rejected a valid schema: {error.Message}");
        }

        Failure.Check(!schemaError, "compiled a schema the protocol rejects");
        if (fixture.GetValueOrDefault("instances") is not List<object?> instances)
        {
            throw new Failure("fixture lists no instances");
        }

        for (var index = 0; index < instances.Count; index++)
        {
            var instance = Object(instances[index], "instance");
            if (instance.GetValueOrDefault("valid") is not bool expected)
            {
                throw new Failure("instance states no verdict");
            }

            var value = instance.GetValueOrDefault("json") is string json
                ? JsonTree.Parse(json)
                : JsonTree.From(Json.Element(instance.GetValueOrDefault("value")));
            Failure.Check(schema.Valid(value) == expected, $"instance {index}: expected valid = {expected.ToString().ToLowerInvariant()}");
        }
    }

    // ----- interpreter ---------------------------------------------------------------------------

    internal static void RunInterpreter(OrderedDictionary<string, object?> fixture)
    {
        var id = Text(fixture.GetValueOrDefault("id"));
        var references = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (fixture.GetValueOrDefault("steps") is not List<object?> steps)
        {
            throw new Failure("interpreter fixture has no steps");
        }

        foreach (var item in steps)
        {
            var step = Object(item, "step");
            var location = $"{id}/{Text(step.GetValueOrDefault("id"))}";
            var actual = Materialize(step.GetValueOrDefault("actual"));
            if (step.GetValueOrDefault("rejects") is true)
            {
                bool accepted;
                try
                {
                    Matcher.AssertValue(step.GetValueOrDefault("expect"), actual, references, location);
                    accepted = true;
                }
                catch (Failure)
                {
                    accepted = false;
                }

                Failure.Check(!accepted, $"{location} accepted a value the fixture rejects");
            }
            else
            {
                Matcher.AssertValue(step.GetValueOrDefault("expect"), actual, references, location);
            }

            Capture(step, actual, references);
        }

        if (fixture.GetValueOrDefault("errors") is not List<object?> errors)
        {
            throw new Failure("interpreter fixture has no errors");
        }

        foreach (var item in errors)
        {
            var error = Object(item, "error");
            AssertErrorValue(Object(error.GetValueOrDefault("expect"), "expect"), Object(error.GetValueOrDefault("actual"), "actual"), references, $"{id}/{Text(error.GetValueOrDefault("id"))}");
        }
    }

    /// <summary>
    /// Turns <c>{"$native": kind, "value": text}</c> into the value a driver produces, then
    /// normalizes it the way the scenario decoder does.
    /// </summary>
    internal static object? Materialize(object? value)
    {
        if (value is List<object?> list)
        {
            return list.Select(Materialize).ToList();
        }

        if (Json.Object(value) is not { } members)
        {
            return value;
        }

        if (members.Count != 2 || !members.TryGetValue("$native", out var native) || !members.TryGetValue("value", out var raw))
        {
            var items = new OrderedDictionary<string, object?>(StringComparer.Ordinal);
            foreach (var (key, item) in members)
            {
                items[key] = Materialize(item);
            }

            return items;
        }

        return NativeValue(native, raw);
    }

    private static object? NativeValue(object? kind, object? raw)
    {
        if (kind is "json")
        {
            return raw;
        }

        if (kind is not ("integer" or "number" or "timestamp" or "uuid"))
        {
            throw new Failure($"unknown interpreter native value {Matcher.Render(kind)}");
        }

        if (raw is not string text)
        {
            throw new Failure($"native value {Matcher.Render(raw)} is not text");
        }

        switch (kind)
        {
            // PostgreSQL numeric: integral values become integers, as the decoder does.
            case "integer":
                var trimmed = text.TrimStart('+');
                return trimmed.Length > 0 && trimmed.TrimStart('-').Length > 0 && trimmed.TrimStart('-').All(char.IsAsciiDigit)
                    ? Json.Number(trimmed)
                    : double.Parse(text, CultureInfo.InvariantCulture);

            // A non-finite float has no JSON form, so the number matcher rejects it.
            case "number":
                var number = double.Parse(text, CultureInfo.InvariantCulture);
                return double.IsFinite(number) ? number : null;
            case "timestamp":
                Failure.Check(Matcher.Timestamp(text), $"{text} is not an RFC 3339 timestamp");
                return Matcher.NormalizeTimestamp(DateTimeOffset.Parse(text, CultureInfo.InvariantCulture));
            default:
                var compact = text.Replace("-", "", StringComparison.Ordinal);
                Failure.Check(compact.Length == 32 && compact.All(char.IsAsciiHexDigit), $"{text} is not a UUID");
                return Guid.ParseExact(compact, "N").ToString();
        }
    }

    internal static void Capture(OrderedDictionary<string, object?> step, object? actual, IDictionary<string, object?> references)
    {
        if (Json.Object(step.GetValueOrDefault("capture")) is not { } captures)
        {
            return;
        }

        foreach (var (name, pointer) in captures)
        {
            references[name] = Matcher.ReadPointer(actual, pointer as string ?? throw new Failure($"capture {name} has no pointer"));
        }
    }

    internal static void AssertErrorValue(
        OrderedDictionary<string, object?> expected, OrderedDictionary<string, object?> actual, IDictionary<string, object?> references, string location)
    {
        foreach (var field in new[] { "code", "message" })
        {
            if (!Matcher.Same(expected.GetValueOrDefault(field), actual.GetValueOrDefault(field)))
            {
                throw new Failure($"{location} expected error {field} {Matcher.Render(expected.GetValueOrDefault(field))}, received {Matcher.Render(actual.GetValueOrDefault(field))}");
            }
        }

        if (expected.TryGetValue("detail", out var detail))
        {
            Failure.Check(actual.ContainsKey("detail"), $"{location} expected error detail, received none");
            Matcher.AssertValue(detail, actual["detail"], references, $"{location}.detail");
        }

        // P1001 to P1010 copy their DETAIL JSON into HINT, for drivers that hide DETAIL.
        if (!expected.TryGetValue("hint", out var expectedHint))
        {
            return;
        }

        Failure.Check(actual.ContainsKey("hint"), $"{location} expected error hint, received none");
        var hint = actual["hint"];
        if (hint is string text)
        {
            try
            {
                hint = Json.Parse(text);
            }
            catch (JsonException parse)
            {
                throw new Failure($"{location} error hint is not JSON ({parse.Message}): {text}");
            }
        }

        Matcher.AssertValue(expectedHint, hint, references, $"{location}.hint");
    }

    // ----- scenarios -----------------------------------------------------------------------------

    /// <summary>
    /// Runs every SQL scenario, and returns the coverage problems. A scenario that fails stops at its
    /// first failing step; the next scenario still runs.
    /// </summary>
    private List<string> RunScenarios(NpgsqlConnection connection)
    {
        var listed = entries.Select(entry => entry.Fixture).ToHashSet(StringComparer.Ordinal);
        var coverage = new HashSet<string>(StringComparer.Ordinal);
        foreach (var scenario in catalogue.Category("scenarios"))
        {
            var outcome = Attempt(() => RunScenario(connection, scenario));

            // A listed scenario keeps the capabilities it declares, so the list reports its gap once.
            if (outcome.Status == OutcomeStatus.Passed || listed.Contains(Catalogue.Key("scenarios", scenario)))
            {
                coverage.UnionWith(Covers(scenario));
            }

            Record("scenarios", scenario, outcome);
        }

        return ManifestCoverage(catalogue.Manifest, coverage) is { } problem ? [problem] : [];
    }

    internal static IEnumerable<string> Covers(OrderedDictionary<string, object?> scenario) =>
        scenario.GetValueOrDefault("steps") is List<object?> steps
            ? steps.SelectMany(item => Json.Object(item)?.GetValueOrDefault("covers") is List<object?> covers ? covers.OfType<string>() : [])
            : [];

    /// <summary>The coverage problem, or <c>null</c> when the scenarios cover every manifest capability.</summary>
    internal static string? ManifestCoverage(OrderedDictionary<string, object?> manifest, IReadOnlySet<string> coverage)
    {
        var runtime = Strings(manifest.GetValueOrDefault("runtimeCoverage")).ToHashSet(StringComparer.Ordinal);
        var missing = Strings(manifest.GetValueOrDefault("coverage")).Where(capability => !runtime.Contains(capability) && !coverage.Contains(capability)).ToList();
        return missing.Count == 0 ? null : $"SQL protocol fixtures lack coverage: {string.Join(", ", missing)}";
    }

    private static void RunScenario(NpgsqlConnection connection, OrderedDictionary<string, object?> scenario)
    {
        var references = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (scenario.GetValueOrDefault("steps") is not List<object?> steps)
        {
            throw new Failure("scenario has no steps");
        }

        foreach (var item in steps)
        {
            var step = Object(item, "step");
            RunStep(connection, step, references, $"{Text(scenario.GetValueOrDefault("id"))}/{Text(step.GetValueOrDefault("id"))}");
        }
    }

    private static void RunStep(NpgsqlConnection connection, OrderedDictionary<string, object?> step, Dictionary<string, object?> references, string location)
    {
        if (step.GetValueOrDefault("sql") is not string sql)
        {
            throw new Failure($"{location} has no SQL");
        }

        var values = step.TryGetValue("parameters", out var declared) ? Matcher.Resolve(declared, references) : new List<object?>();
        if (values is not List<object?> parameters)
        {
            throw new Failure($"{location} parameters are not a list: {Matcher.Render(values)}");
        }

        var result = Database.Execute(connection, sql, parameters, location);
        var expectedError = Json.Object(step.GetValueOrDefault("error"));
        if (result.Error is { } error && expectedError is not null)
        {
            OrderedDictionary<string, object?> actual;
            try
            {
                actual = Database.DatabaseError(error);
            }
            catch (Failure failure)
            {
                throw new Failure($"{location}: {failure.Message}");
            }

            AssertErrorValue(expectedError, actual, references, location);
        }
        else if (expectedError is not null)
        {
            throw new Failure($"{location} expected error {Matcher.Render(expectedError)}, received {result.Rows?.Count ?? 0} rows");
        }
        else if (result.Error is { } unexpected)
        {
            throw new Failure($"{location} failed: {Database.Describe(unexpected)}");
        }
        else
        {
            var expect = Json.Object(step.GetValueOrDefault("expect"));
            var expected = expect is not null && expect.TryGetValue("rows", out var rows) ? rows : new List<object?>();
            Matcher.AssertValue(expected, result.Rows, references, location);
            Capture(step, result.Rows, references);
        }
    }

    // ----- adapters ------------------------------------------------------------------------------

    private void RunCron(NpgsqlConnection connection) =>
        EachFixture("cron-occurrences", fixture =>
        {
            if (fixture.GetValueOrDefault("limit") is not long limit)
            {
                throw new Failure("limit is not an integer");
            }

            var actual = new List<long>();
            try
            {
                using var command = new NpgsqlCommand(Cron, connection);

                // A new definition has no previous occurrence, which the fixture writes as null.
                foreach (var value in new object?[] { fixture["expression"], fixture["lastOccurrenceAt"], fixture["now"], limit.ToString(CultureInfo.InvariantCulture), fixture["timezone"] })
                {
                    command.Parameters.Add(new NpgsqlParameter { Value = value ?? DBNull.Value, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text });
                }

                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    actual.Add(Database.Microseconds(Database.Instant(reader.GetString(0))));
                }
            }
            catch (NpgsqlException error)
            {
                throw new Failure(Database.Describe(error));
            }

            if (fixture.GetValueOrDefault("expected") is not List<object?> list)
            {
                throw new Failure("expected is not a list");
            }

            var expected = list.Select(instant => Database.Microseconds(DateTimeOffset.Parse(Text(instant), CultureInfo.InvariantCulture))).ToList();
            Failure.Check(
                actual.SequenceEqual(expected),
                $"expected occurrences [{string.Join(", ", expected)}], received [{string.Join(", ", actual)}] (microseconds since the epoch)");
        });

    /// <summary>
    /// Routes calls to one SQL function through a wrapper that records its arguments first.
    /// </summary>
    /// <remarks>
    /// The runner interposes in the database, as the Rust, Ruby, and JVM lanes do. The real function
    /// keeps running, and the runner reads the recorded arguments back.
    /// </remarks>
    internal static void RecordCalls(NpgsqlConnection connection, string function)
    {
        var overloads = Database.Rows(
            connection,
            $"""
            SELECT p.oid::regprocedure::text AS signature, pg_get_function_arguments(p.oid) AS arguments,
                   pg_get_function_result(p.oid) AS result, p.proretset AS returns_set, p.pronargs::integer AS arity
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'workhorse' AND p.proname = '{function}'
            """);
        Failure.Check(overloads.Count > 0, $"workhorse.{function} does not exist");
        Database.Run(
            connection,
            "CREATE TABLE IF NOT EXISTS public.conformance_calls (sequence bigserial PRIMARY KEY, function_name text NOT NULL, arguments jsonb NOT NULL)");
        for (var index = 0; index < overloads.Count; index++)
        {
            var overload = Json.Object(overloads[index])!;
            var inner = $"{function}__recorded_{index}";
            var arguments = string.Join(", ", Enumerable.Range(1, (int)(long)overload["arity"]!).Select(position => $"${position}"));
            var call = overload["returns_set"] is true
                ? $"SELECT * FROM workhorse.{inner}({arguments})"
                : $"SELECT workhorse.{inner}({arguments})";
            try
            {
                Database.Run(connection, $"ALTER FUNCTION {overload["signature"]} RENAME TO {inner}");
                Database.Run(
                    connection,
                    $"CREATE FUNCTION workhorse.{function}({overload["arguments"]}) RETURNS {overload["result"]} LANGUAGE sql AS $recorded$ INSERT INTO public.conformance_calls (function_name, arguments) VALUES ('{function}', jsonb_build_array({arguments})); {call}; $recorded$");
            }
            catch (PostgresException error)
            {
                throw new Failure($"interpose {overload["signature"]}: {Database.Describe(error)}");
            }
        }
    }

    /// <summary>The arguments of every recorded call to <paramref name="function"/> since the last read.</summary>
    internal static List<object?> Recorded(NpgsqlConnection connection, string function) =>
        [.. Database.Rows(
                connection,
                $"WITH taken AS (DELETE FROM public.conformance_calls WHERE function_name = '{function}' RETURNING sequence, arguments) SELECT arguments FROM taken ORDER BY sequence")
            .Select(row => Json.Object(row)!["arguments"])];

    /// <summary>
    /// Translates the application options of a fixture into <see cref="EnqueueOptions"/>. It refuses
    /// an option that the adapter does not know, so a new fixture option cannot pass by being ignored.
    /// </summary>
    internal static EnqueueOptions EnqueueOptions(OrderedDictionary<string, object?> options)
    {
        var translated = new EnqueueOptions();
        foreach (var (name, value) in options)
        {
            translated = name switch
            {
                "queue" => translated with { Queue = (string?)value },
                "priority" => translated with { Priority = Int(value) },
                "concurrencyKey" => translated with { ConcurrencyKey = (string?)value },
                "budget" => translated with { Budget = (string?)value },
                "maxAttempts" => translated with { MaxAttempts = Int(value) },
                "retryPolicy" => translated with { RetryPolicy = RetryPolicy(value) },
                "executionTimeoutMs" => translated with { ExecutionTimeout = TimeSpan.FromMilliseconds((long)value!) },
                "tags" => translated with { Tags = [.. Strings(value)] },
                "idempotency" => translated with { Idempotency = Idempotency(Object(value, "idempotency")) },
                _ => throw new Failure($"the adapter does not translate option {name}"),
            };
        }

        return translated;
    }

    private static Idempotency Idempotency(OrderedDictionary<string, object?> fields) =>
        new()
        {
            Key = (string)fields["key"]!,
            Scope = fields.GetValueOrDefault("scope") as string ?? "default",
            Ttl = fields.GetValueOrDefault("ttlMs") is long ttl ? TimeSpan.FromMilliseconds(ttl) : TimeSpan.FromDays(1),
        };

    /// <summary>The retry policy of a fixture, or <c>null</c>.</summary>
    internal static RetryPolicy? RetryPolicy(object? value)
    {
        if (value is null)
        {
            return null;
        }

        var policy = Json.Object(value) ?? throw new Failure("retryPolicy is neither null nor an object");
        TimeSpan Milliseconds(string key) => TimeSpan.FromMilliseconds((long)policy[key]!);
        return policy.GetValueOrDefault("type") switch
        {
            "fixed" => Workhorse.RetryPolicy.Fixed(Milliseconds("delayMs")),
            "exponential" => Workhorse.RetryPolicy.Exponential(Milliseconds("initialDelayMs"), (int)(long)policy["multiplier"]!, Milliseconds("maxDelayMs")),
            "decorrelatedJitter" => Workhorse.RetryPolicy.DecorrelatedJitter(Milliseconds("baseDelayMs"), Milliseconds("maxDelayMs")),
            var type => throw new Failure($"the adapter does not translate retry policy type {Matcher.Render(type)}"),
        };
    }

    internal static int? Int(object? value) => value is null ? null : checked((int)(long)value);

    /// <summary>
    /// A request fixture records the JSON request that every client sends to
    /// <c>enqueue_many_v1</c>, so <c>Queue.EnqueueAsync</c> passes only when it sends that call with
    /// that request.
    /// </summary>
    private async Task RunRequestsAsync(NpgsqlDataSource dataSource, NpgsqlConnection setup)
    {
        var interposed = Attempt(() => RecordCalls(setup, "enqueue_many_v1"));
        await EachFixtureAsync("requests", async fixture =>
        {
            try
            {
                Failure.Check(interposed.Status == OutcomeStatus.Passed, interposed.Reason ?? "");
                var application = Object(fixture.GetValueOrDefault("application"), "application");
                var options = EnqueueOptions(Json.Object(application.GetValueOrDefault("options")) ?? []);
                await ClientCallAsync(() => new Queue(dataSource).EnqueueAsync((string)application["type"]!, Json.Element(application.GetValueOrDefault("payload")), options));
                var calls = Recorded(setup, "enqueue_many_v1");
                Failure.Check(calls.Count == 1, $"expected one enqueue_many_v1 call, recorded {calls.Count}");
                Matcher.AssertValue(
                    new List<object?> { fixture.GetValueOrDefault("postgres") },
                    ((List<object?>)calls[0]!)[0],
                    new Dictionary<string, object?>(StringComparer.Ordinal),
                    "enqueue_many_v1.p_requests");
            }
            finally
            {
                // A failed attempt may have recorded a call; the next fixture must start clean.
                Attempt(() => Recorded(setup, "enqueue_many_v1"));
            }
        });
    }

    internal static ScheduleDefinition ScheduleDefinition(OrderedDictionary<string, object?> definition)
    {
        var task = Object(definition.GetValueOrDefault("task"), "task");
        return new ScheduleDefinition
        {
            Name = (string)definition["name"]!,
            Schedule = (string)definition["schedule"]!,
            Task = new ScheduledTask
            {
                TaskType = (string)task["type"]!,
                Payload = Json.Element(task.GetValueOrDefault("payload")),
                Queue = task.GetValueOrDefault("queue") as string,
                Priority = Int(task.GetValueOrDefault("priority")) ?? 0,
                ConcurrencyKey = task.GetValueOrDefault("concurrencyKey") as string,
                MaxAttempts = Int(task.GetValueOrDefault("maxAttempts")),
                RetryPolicy = RetryPolicy(task.GetValueOrDefault("retryPolicy")),
            },
            Timezone = (string)definition["timezone"]!,
            CatchupPolicy = definition.GetValueOrDefault("catchupPolicy") switch
            {
                "skip" => CatchupPolicy.Skip,
                "latest" => CatchupPolicy.Latest,
                "all" => CatchupPolicy.All,
                var policy => throw new Failure($"unknown catchup policy {Matcher.Render(policy)}"),
            },
            Enabled = definition.GetValueOrDefault("enabled") is true,
        };
    }

    /// <summary>The contracts that a schedule fixture syncs before its schedules.</summary>
    internal static Dictionary<string, TaskTypeContracts> TaskContracts(OrderedDictionary<string, object?> contracts)
    {
        var translated = new Dictionary<string, TaskTypeContracts>(StringComparer.Ordinal);
        foreach (var (taskType, item) in contracts)
        {
            var contract = Object(item, "contract");
            var versions = new Dictionary<string, TaskContractVersion>(StringComparer.Ordinal);
            foreach (var (name, entry) in Object(contract.GetValueOrDefault("versions"), "versions"))
            {
                var version = Object(entry, "version");
                versions[name] = new TaskContractVersion
                {
                    PayloadSchema = Json.Element(version.GetValueOrDefault("payloadSchema") ?? throw new Failure("a contract schema is null")),
                    ResultSchema = Json.Element(version.GetValueOrDefault("resultSchema") ?? throw new Failure("a contract schema is null")),
                    MaxPayloadBytes = version.GetValueOrDefault("maxPayloadBytes") as long?,
                    MaxResultBytes = version.GetValueOrDefault("maxResultBytes") as long?,
                    SensitivePayloadKeys = [.. Strings(version.GetValueOrDefault("sensitivePayloadKeys"))],
                    SensitiveResultKeys = [.. Strings(version.GetValueOrDefault("sensitiveResultKeys"))],
                };
            }

            translated[taskType] = new TaskTypeContracts { CurrentVersion = (string)contract["currentVersion"]!, Versions = versions };
        }

        return translated;
    }

    private async Task RunSchedulesAsync(NpgsqlDataSource dataSource, NpgsqlConnection setup)
    {
        var interposed = Attempt(() => RecordCalls(setup, "sync_schedule_definitions_v2"));
        await EachFixtureAsync("schedules", async fixture =>
        {
            try
            {
                Failure.Check(interposed.Status == OutcomeStatus.Passed, interposed.Reason ?? "");
                var @namespace = (string)fixture["namespace"]!;
                if (fixture.GetValueOrDefault("prune") is not bool prune)
                {
                    throw new Failure("fixture sets no prune flag");
                }

                var definitions = fixture.GetValueOrDefault("application") is List<object?> application
                    ? application.Select(item => ScheduleDefinition(Object(item, "definition"))).ToList()
                    : [];
                var queue = new Queue(dataSource, new QueueOptions { DefaultQueue = (string)fixture["defaultQueue"]! });
                if (Json.Object(fixture.GetValueOrDefault("contracts")) is { } contracts)
                {
                    await queue.SyncContractsAsync(TaskContracts(contracts));
                }

                await ClientCallAsync(() => queue.SyncSchedulesAsync(@namespace, definitions, prune));
                var calls = Recorded(setup, "sync_schedule_definitions_v2");
                Failure.Check(calls.Count == 1, $"expected one sync_schedule_definitions_v2 call, recorded {calls.Count}");
                Matcher.AssertValue(
                    new List<object?> { @namespace, fixture.GetValueOrDefault("postgres"), prune },
                    calls[0],
                    new Dictionary<string, object?>(StringComparer.Ordinal),
                    "sync_schedule_definitions_v2");
            }
            finally
            {
                Attempt(() => Recorded(setup, "sync_schedule_definitions_v2"));
            }
        });
    }

    // ----- compatibility -------------------------------------------------------------------------

    /// <summary>
    /// Installs the versions that a compatibility fixture describes, reads them back the way the
    /// client does, and compares the verdict and the refusal code. A fixture that presents the
    /// protocol of this client runs through <c>Queue.AssertCompatibleAsync</c>; another protocol runs
    /// the same decision directly.
    /// </summary>
    private async Task RunCompatibilityAsync(NpgsqlDataSource dataSource, NpgsqlConnection setup) =>
        await EachFixtureAsync("compatibility", async fixture =>
        {
            var installed = fixture.GetValueOrDefault("installedSchemaVersion");
            if (fixture.GetValueOrDefault("servedProtocolVersions") is not List<object?> served)
            {
                throw new Failure("fixture lists no served protocols");
            }

            InstallVersions(setup, installed, served);
            string? code;
            try
            {
                code = await RefusalAsync(dataSource, (long)fixture["clientProtocolVersion"]!);
            }
            finally
            {
                if (installed is null)
                {
                    Database.Run(setup, "ALTER SCHEMA workhorse_hidden RENAME TO workhorse");
                }
            }

            CompareRefusal(fixture, code);
        });

    /// <summary>The refusal code as the fixture spells it, or <c>null</c> when the client can continue.</summary>
    private static async Task<string?> RefusalAsync(NpgsqlDataSource dataSource, long clientProtocol)
    {
        CompatibilityCode? code;
        if (clientProtocol == SqlCatalogue.ClientProtocolVersion)
        {
            try
            {
                // A new queue has an empty compatibility cache.
                await new Queue(dataSource).AssertCompatibleAsync();
                return null;
            }
            catch (CompatibilityException error)
            {
                code = error.Code;
            }
        }
        else
        {
            int? schema = null;
            var missing = false;
            var served = new List<int>();
            await using var connection = await dataSource.OpenConnectionAsync();
            try
            {
                foreach (var row in await Sql.RowsAsync(connection, SqlCatalogue.CompatibilityState, [], CancellationToken.None))
                {
                    var version = row.RequiredInteger("version");
                    if (row.RequiredText("kind") == "schema")
                    {
                        schema = version;
                    }
                    else
                    {
                        served.Add(version);
                    }
                }
            }
            catch (DatabaseException error) when (error.SqlState is SqlStates.UndefinedTable or SqlStates.InvalidSchemaName)
            {
                missing = true;
            }

            code = Compatibility.Check(missing ? null : schema, checked((int)clientProtocol), served);
        }

        return code is { } refusal ? new CompatibilityException(refusal).Message.Split(": ")[1] : null;
    }

    private static void CompareRefusal(OrderedDictionary<string, object?> fixture, string? code)
    {
        if (fixture.GetValueOrDefault("compatible") is not bool expected)
        {
            throw new Failure("fixture states no verdict");
        }

        var refusal = Matcher.Render(fixture.GetValueOrDefault("refusalCode"));
        if (code is null)
        {
            Failure.Check(expected, $"accepted; expected refusal {refusal}");
        }
        else if (expected)
        {
            throw new Failure($"refused a compatible installation: {code}");
        }
        else
        {
            Failure.Check(code == fixture.GetValueOrDefault("refusalCode") as string, $"refused with {code}; expected {refusal}");
        }
    }

    private static void InstallVersions(NpgsqlConnection connection, object? installed, List<object?> served)
    {
        Database.Run(connection, "DELETE FROM workhorse.schema_version");
        Database.Run(connection, "DELETE FROM workhorse.protocol_version");
        foreach (var version in served)
        {
            Database.Run(connection, $"INSERT INTO workhorse.protocol_version (version) VALUES ({(long)version!})");
        }

        // No installed schema: the client must find no `workhorse` schema at all.
        Database.Run(
            connection,
            installed is null ? "ALTER SCHEMA workhorse RENAME TO workhorse_hidden" : $"INSERT INTO workhorse.schema_version (version) VALUES ({(long)installed})");
    }

    // ----- support -------------------------------------------------------------------------------

    /// <summary>A client call, with an SDK error reported the way the other lanes do.</summary>
    internal static async Task ClientCallAsync(Func<Task> call)
    {
        try
        {
            await call();
        }
        catch (DatabaseException error)
        {
            throw new Failure($"postgres: {error.Message.Trim()} ({error.SqlState})");
        }
        catch (Exception error) when (error is WorkhorseException or ArgumentException)
        {
            throw new Failure(error.Message);
        }
    }

    internal static OrderedDictionary<string, object?> Object(object? value, string name) =>
        Json.Object(value) ?? throw new Failure($"{name} is not an object: {Matcher.Render(value)}");

    internal static IEnumerable<string> Strings(object? value) => value is List<object?> list ? list.OfType<string>() : [];

    internal static string Text(object? value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "null";

    private void EachFixture(string category, Action<OrderedDictionary<string, object?>> body)
    {
        foreach (var fixture in catalogue.Category(category))
        {
            Record(category, fixture, Attempt(() => body(fixture)));
        }
    }

    private async Task EachFixtureAsync(string category, Func<OrderedDictionary<string, object?>, Task> body)
    {
        foreach (var fixture in catalogue.Category(category))
        {
            Record(category, fixture, await AttemptAsync(() => body(fixture)));
        }
    }

    /// <summary>The outcome of <paramref name="body"/>: a <see cref="Failure"/> or any other error fails the fixture.</summary>
    internal static Outcome Attempt(Action body)
    {
        try
        {
            body();
            return Outcome.Passed();
        }
        catch (Failure failure)
        {
            return Outcome.Failed(failure.Message);
        }
        catch (Exception error)
        {
            return Outcome.Failed($"{error.GetType().Name}: {error.Message}");
        }
    }

    internal static async Task<Outcome> AttemptAsync(Func<Task> body)
    {
        try
        {
            await body();
            return Outcome.Passed();
        }
        catch (Failure failure)
        {
            return Outcome.Failed(failure.Message);
        }
        catch (Exception error)
        {
            return Outcome.Failed($"{error.GetType().Name}: {error.Message}");
        }
    }

    private void Record(string category, OrderedDictionary<string, object?> fixture, Outcome outcome) =>
        _outcomes[Catalogue.Key(category, fixture)] = outcome;
}
