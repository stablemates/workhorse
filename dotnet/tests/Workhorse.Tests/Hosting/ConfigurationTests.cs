using System.Globalization;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Workhorse.Hosting;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Hosting;

/// <summary>
/// The <c>Workhorse:*</c> configuration keys. <c>ConfigurationKeys.json</c> lists each key with its
/// type and default, and the API snapshot reads it, so these tests hold it to the binder.
/// </summary>
public sealed class ConfigurationTests(ScratchDatabase database) : IClassFixture<ScratchDatabase>
{
    /// <summary>The option properties that configuration cannot express. Code sets them.</summary>
    private static readonly string[] CodeOnly = [nameof(WorkerOptions.Json), nameof(WorkerOptions.LoggerFactory), nameof(WorkerOptions.RetryDelay)];

    private sealed record Key(string Name, string Type, JsonElement Default);

    [Fact]
    public void EveryBindableOptionHasAKeyAndEveryKeyHasAnOption()
    {
        var keys = Keys().Select(key => key.Name).ToHashSet(StringComparer.Ordinal);
        var expected = new HashSet<string>(StringComparer.Ordinal) { "Workhorse:DataSourceKey" };
        expected.UnionWith(Bindable(typeof(WorkerOptions)).Select(property => $"Workhorse:Worker:{property.Name}"));
        expected.UnionWith(Bindable(typeof(QueueOptions)).Select(property => $"Workhorse:Queue:{property.Name}"));

        Assert.Equal(expected.Order(StringComparer.Ordinal), keys.Order(StringComparer.Ordinal));
        Assert.Empty(Bindable(typeof(AdminOptions)));
    }

    [Fact]
    public void EachDefaultIsTheDefaultOfTheCoreOptions()
    {
        var worker = new WorkerOptions();
        var queue = new QueueOptions();
        foreach (var key in Keys().Where(key => key.Name != "Workhorse:DataSourceKey"))
        {
            var (owner, property) = Property(key.Name);
            var actual = property.GetValue(owner == typeof(WorkerOptions) ? worker : queue);
            Assert.True(Text(key.Default) == Text(actual), $"{key.Name}: the file says {key.Default}, the options say {Text(actual)}");
            Assert.Equal(TypeName(property.PropertyType, property), key.Type);
        }
    }

    [Fact]
    public void EachKeyBindsToItsOption()
    {
        var settings = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["Workhorse:Queue:DefaultQueue"] = "mail",
            ["Workhorse:Worker:Cohorts"] = "2",
            ["Workhorse:Worker:Concurrency"] = "8",
            ["Workhorse:Worker:DisableRegistry"] = "true",
            ["Workhorse:Worker:Heartbeat"] = "00:00:02",
            ["Workhorse:Worker:Lease"] = "00:00:09",
            ["Workhorse:Worker:MaintenanceInterval"] = "00:00:03",
            ["Workhorse:Worker:MaintenanceRoutineInterval"] = "00:02:00",
            ["Workhorse:Worker:PollInterval"] = "00:00:00.100",
            ["Workhorse:Worker:PollingOnly"] = "true",
            ["Workhorse:Worker:Queues:0"] = "mail",
            ["Workhorse:Worker:Queues:1"] = "sms",
            ["Workhorse:Worker:RegistryInterval"] = "00:00:07",
            ["Workhorse:Worker:ScheduleCatchupLimit"] = "50",
            ["Workhorse:Worker:ScheduleNamespaces:0"] = "billing",
            ["Workhorse:Worker:ShutdownGrace"] = "00:00:10",
            ["Workhorse:Worker:WorkerId"] = "worker-a",
        };
        using var provider = Provider(settings);
        var worker = provider.GetRequiredService<IOptions<WorkerOptions>>().Value;
        var queue = provider.GetRequiredService<IOptions<QueueOptions>>().Value;

        Assert.Equal("mail", queue.DefaultQueue);
        Assert.Equal(2, worker.Cohorts);
        Assert.Equal(8, worker.Concurrency);
        Assert.True(worker.DisableRegistry);
        Assert.Equal(TimeSpan.FromSeconds(2), worker.Heartbeat);
        Assert.Equal(TimeSpan.FromSeconds(9), worker.Lease);
        Assert.Equal(TimeSpan.FromSeconds(3), worker.MaintenanceInterval);
        Assert.Equal(TimeSpan.FromMinutes(2), worker.MaintenanceRoutineInterval);
        Assert.Equal(TimeSpan.FromMilliseconds(100), worker.PollInterval);
        Assert.True(worker.PollingOnly);
        // A configured list replaces the default ["default"]; the binder alone would add to it.
        Assert.Equal(["mail", "sms"], worker.Queues);
        Assert.Equal(TimeSpan.FromSeconds(7), worker.RegistryInterval);
        Assert.Equal(50, worker.ScheduleCatchupLimit);
        Assert.Equal(["billing"], worker.ScheduleNamespaces);
        Assert.Equal(TimeSpan.FromSeconds(10), worker.ShutdownGrace);
        Assert.Equal("worker-a", worker.WorkerId);
        Assert.NotNull(worker.LoggerFactory);

        // The test sets every key of the file except the data source key, which the next test covers.
        Assert.Equal(
            Keys().Select(key => key.Name).Where(name => name != "Workhorse:DataSourceKey").Order(StringComparer.Ordinal),
            settings.Keys.Select(name => name.Split(':')[..3]).Select(parts => string.Join(':', parts)).Distinct().Order(StringComparer.Ordinal));
    }

    [Fact]
    public void WithoutConfigurationTheOptionsKeepTheirDefaults()
    {
        using var provider = Provider(new Dictionary<string, string?>());
        var worker = provider.GetRequiredService<IOptions<WorkerOptions>>().Value;
        Assert.Equal(["default"], worker.Queues);
        Assert.Equal(TimeSpan.FromSeconds(25), worker.ShutdownGrace);
        Assert.Equal("default", provider.GetRequiredService<IOptions<QueueOptions>>().Value.DefaultQueue);
    }

    /// <summary>
    /// SM-1902: <c>Workhorse:Worker:SharedHeartbeats</c> is removed. With each value, also
    /// <c>null</c>, and in each letter case, <c>AddWorkhorse</c> throws, also in a process that
    /// registers no worker. The error names the removal and the next step.
    /// </summary>
    [Theory]
    [InlineData("Workhorse:Worker:SharedHeartbeats", "true")]
    [InlineData("Workhorse:Worker:SharedHeartbeats", "false")]
    [InlineData("Workhorse:Worker:SharedHeartbeats", null)]
    [InlineData("workhorse:worker:sharedheartbeats", "true")]
    public void TheRemovedSharedHeartbeatsKeyStopsTheRegistration(string key, string? value)
    {
        var services = new ServiceCollection();
        var configuration = Configuration(new Dictionary<string, string?> { [key] = value });
        var refusal = Assert.Throws<InvalidOperationException>(() => services.AddWorkhorse(configuration));
        Assert.Contains("SharedHeartbeats was removed in 0.11.0", refusal.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("removed", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("a known maximum size of at least 3", refusal.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// SM-2041: on 0.12 the binder created a <see cref="JsonSerializerOptions"/> with the general
    /// defaults for a <c>Json</c> section, and that object replaced the Web defaults. Now a
    /// <c>Json</c> section stops the registration with an error that names it.
    /// </summary>
    [Theory]
    [InlineData("Workhorse:Worker:Json:WriteIndented", "true", "services.Configure<WorkerOptions>")]
    [InlineData("Workhorse:Queue:Json:WriteIndented", "true", "register a Queue with new QueueOptions")]
    [InlineData("workhorse:worker:json:propertynamecaseinsensitive", "false", "services.Configure<WorkerOptions>")]
    [InlineData("Workhorse:Worker:Json", "", "services.Configure<WorkerOptions>")]
    [InlineData("Workhorse:Queue:Json", null, "register a Queue with new QueueOptions")]
    public void AJsonSectionStopsTheRegistration(string key, string? value, string code)
    {
        var services = new ServiceCollection();
        var configuration = Configuration(new Dictionary<string, string?> { [key] = value });
        var refusal = Assert.Throws<InvalidOperationException>(() => services.AddWorkhorse(configuration));
        var section = string.Join(':', key.Split(':')[..3]);
        var owner = key.Split(':')[1].Equals("Queue", StringComparison.OrdinalIgnoreCase) ? "QueueOptions" : "WorkerOptions";
        Assert.StartsWith($"{section} is not a Workhorse configuration key.", refusal.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains($"cannot set {owner}.Json", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("set the JSON options in code", refusal.Message, StringComparison.Ordinal);
        Assert.Contains(code, refusal.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// SM-2041: the binder cannot fill a delegate or an interface, so on 0.12 a <c>RetryDelay</c> or
    /// <c>LoggerFactory</c> section failed with an error of the binder when the worker options were
    /// read. The registration still accepts it, so a host that never reads the worker options keeps
    /// working. The first read now fails with an error that names the section.
    /// </summary>
    [Theory]
    [InlineData("Workhorse:Worker:RetryDelay:Method", "RetryDelay")]
    [InlineData("Workhorse:Worker:LoggerFactory:Name", "LoggerFactory")]
    public void ASectionThatTheBinderCannotFillStopsTheFirstRead(string key, string property)
    {
        using var provider = Provider(new Dictionary<string, string?> { [key] = "x" });
        Assert.Equal("default", provider.GetRequiredService<IOptions<QueueOptions>>().Value.DefaultQueue);
        var refusal = Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<IOptions<WorkerOptions>>().Value);
        Assert.StartsWith($"Workhorse:Worker:{property} is not a Workhorse configuration key.", refusal.Message, StringComparison.Ordinal);
        Assert.Contains($"cannot set WorkerOptions.{property}", refusal.Message, StringComparison.Ordinal);
        Assert.Contains($"services.Configure<WorkerOptions>(options => options.{property} = ...)", refusal.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// SM-2041: the binder fills each public settable property that it can create. So each property
    /// of the bound options either has a key in <c>ConfigurationKeys.json</c> or is refused by the
    /// first read of its options. A new property without a key fails here until code alone can set it.
    /// </summary>
    [Fact]
    public void EveryPropertyWithoutAKeyIsRefused()
    {
        var keys = Keys().Select(key => key.Name).ToHashSet(StringComparer.Ordinal);
        var unlisted = new[] { (Section: "Workhorse:Worker", Type: typeof(WorkerOptions)), (Section: "Workhorse:Queue", Type: typeof(QueueOptions)) }
            .SelectMany(owner => owner.Type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(property => property.SetMethod is { IsPublic: true })
                .Select(property => $"{owner.Section}:{property.Name}"))
            .Where(key => !keys.Contains(key))
            .ToList();
        Assert.Equal(
            ["Workhorse:Queue:Json", "Workhorse:Worker:Json", "Workhorse:Worker:LoggerFactory", "Workhorse:Worker:RetryDelay"],
            unlisted.Order(StringComparer.Ordinal));
        foreach (var key in unlisted)
        {
            var refusal = Assert.Throws<InvalidOperationException>(() =>
            {
                using var provider = Provider(new Dictionary<string, string?> { [$"{key}:Anything"] = "1" });
                _ = provider.GetRequiredService<IOptions<QueueOptions>>().Value;
                _ = provider.GetRequiredService<IOptions<WorkerOptions>>().Value;
            });
            Assert.StartsWith($"{key} is not a Workhorse configuration key.", refusal.Message, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// SM-2041: on 0.12 the binder accepted a <c>RetryDelay</c> or <c>LoggerFactory</c> key with no
    /// value and no child key, and filled nothing. That configuration keeps working.
    /// </summary>
    [Theory]
    [InlineData("RetryDelay", null)]
    [InlineData("RetryDelay", "")]
    [InlineData("LoggerFactory", null)]
    [InlineData("LoggerFactory", "")]
    public void AnEmptySectionThatTheBinderCannotFillStaysAccepted(string property, string? value)
    {
        using var provider = Provider(new Dictionary<string, string?> { [$"Workhorse:Worker:{property}"] = value });
        var options = provider.GetRequiredService<IOptions<WorkerOptions>>().Value;
        Assert.Null(options.RetryDelay);
        Assert.NotNull(options.LoggerFactory);
    }

    /// <summary>
    /// SM-2041: a configuration source can add a <c>Json</c> section after the registration. The
    /// first read of the worker options refuses it. The queue options bind only the listed keys, so
    /// the section never reaches them.
    /// </summary>
    [Fact]
    public void AJsonSectionThatAppearsAfterTheRegistrationNeverReachesTheOptions()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>()).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddWorkhorse(configuration);
        using var provider = services.BuildServiceProvider();
        configuration["Workhorse:Worker:Json:WriteIndented"] = "true";
        configuration["Workhorse:Queue:Json:WriteIndented"] = "true";
        configuration["Workhorse:Queue:DefaultQueue"] = "mail";

        var worker = Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<IOptions<WorkerOptions>>().Value);
        Assert.StartsWith("Workhorse:Worker:Json is not a Workhorse configuration key.", worker.Message, StringComparison.Ordinal);
        var queue = provider.GetRequiredService<IOptions<QueueOptions>>().Value;
        Assert.Null(queue.Json);
        Assert.Equal("mail", queue.DefaultQueue);
    }

    /// <summary>
    /// SM-2041: the queue options follow a reload of a listed key, as on 0.12. A reload that adds a
    /// <c>Json</c> section notifies the listeners, runs no refusal in the change callback, and keeps
    /// the Web defaults. The worker options do not follow a reload, as on 0.12.
    /// </summary>
    [Fact]
    public void AReloadChangesTheListedQueueKeysAndNeverTheJsonOptions()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["Workhorse:Queue:DefaultQueue"] = "before" }).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddWorkhorse(configuration);
        using var provider = services.BuildServiceProvider();
        var queueMonitor = provider.GetRequiredService<IOptionsMonitor<QueueOptions>>();
        var workerMonitor = provider.GetRequiredService<IOptionsMonitor<WorkerOptions>>();
        Assert.Equal("before", queueMonitor.CurrentValue.DefaultQueue);
        Assert.Null(workerMonitor.CurrentValue.Json);
        var notifications = 0;
        using var listener = queueMonitor.OnChange(_ => notifications++);

        configuration["Workhorse:Queue:DefaultQueue"] = "after";
        configuration["Workhorse:Queue:Json:WriteIndented"] = "true";
        configuration["Workhorse:Worker:Json:WriteIndented"] = "true";
        configuration.Reload();

        Assert.Equal(1, notifications);
        Assert.Equal("after", queueMonitor.CurrentValue.DefaultQueue);
        Assert.Null(queueMonitor.CurrentValue.Json);
        Assert.Null(workerMonitor.CurrentValue.Json);
        using var scope = provider.CreateScope();
        Assert.Null(scope.ServiceProvider.GetRequiredService<IOptionsSnapshot<QueueOptions>>().Value.Json);
    }

    /// <summary>
    /// SM-2041: the options bind the listed keys through a view of their sections. For each
    /// configuration with no code-only key, the result is the result of the plain binder on the
    /// section, as on 0.12: also for lists, empty and null values, letter case, a listed key with a
    /// child key, and a value that the binder cannot convert.
    /// </summary>
    [Theory]
    [MemberData(nameof(PlainConfigurations))]
    public void TheListedKeysBindAsThePlainBinderBindsThem(string name, Dictionary<string, string?> settings)
    {
        Assert.True(Outcome(PlainProvider(settings)) == Outcome(Provider(settings)), name);
    }

    /// <summary>
    /// SM-2041: on 0.12 the binder ignored a value on a <c>RetryDelay</c> or <c>LoggerFactory</c> key
    /// with no child key. That configuration keeps working.
    /// </summary>
    [Theory]
    [InlineData("RetryDelay", "x")]
    [InlineData("LoggerFactory", " ")]
    public void AValueThatTheBinderIgnoredStaysAccepted(string property, string value)
    {
        using var provider = Provider(new Dictionary<string, string?> { [$"Workhorse:Worker:{property}"] = value });
        var options = provider.GetRequiredService<IOptions<WorkerOptions>>().Value;
        Assert.Null(options.RetryDelay);
        Assert.NotNull(options.LoggerFactory);
    }

    /// <summary>SM-2041: an error of the binder names the full key, as on 0.12.</summary>
    [Fact]
    public void AnInvalidValueNamesTheFullKey()
    {
        using var provider = Provider(new Dictionary<string, string?> { ["Workhorse:Worker:Concurrency"] = "many" });
        var error = Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<IOptions<WorkerOptions>>().Value);
        Assert.Contains("'Workhorse:Worker:Concurrency'", error.Message, StringComparison.Ordinal);
    }

    public static TheoryData<string, Dictionary<string, string?>> PlainConfigurations() => new()
    {
        { "nothing", new() },
        { "queues", new() { ["Workhorse:Worker:Queues:0"] = "mail", ["Workhorse:Worker:Queues:1"] = "sms" } },
        { "queues-gap", new() { ["Workhorse:Worker:Queues:1"] = "mail" } },
        { "queues-named", new() { ["Workhorse:Worker:Queues:mail"] = "mail" } },
        { "queues-scalar", new() { ["Workhorse:Worker:Queues"] = "mail" } },
        { "queues-empty", new() { ["Workhorse:Worker:Queues"] = "" } },
        { "queues-item-empty", new() { ["Workhorse:Worker:Queues:0"] = "" } },
        { "queues-item-child", new() { ["Workhorse:Worker:Queues:0:Sub"] = "x" } },
        { "namespaces-item-empty", new() { ["Workhorse:Worker:ScheduleNamespaces:0"] = "" } },
        { "heartbeat-empty", new() { ["Workhorse:Worker:Heartbeat"] = "" } },
        { "heartbeat-zero", new() { ["Workhorse:Worker:Heartbeat"] = "00:00:00" } },
        { "heartbeat-child", new() { ["Workhorse:Worker:Heartbeat:Sub"] = "x" } },
        { "lease", new() { ["Workhorse:Worker:Lease"] = "00:00:09" } },
        { "workerid-empty", new() { ["Workhorse:Worker:WorkerId"] = "" } },
        { "concurrency-empty", new() { ["Workhorse:Worker:Concurrency"] = "" } },
        { "concurrency-padded", new() { ["Workhorse:Worker:Concurrency"] = " 8 " } },
        { "concurrency-child", new() { ["Workhorse:Worker:Concurrency:Sub"] = "8" } },
        { "concurrency-lowercase", new() { ["workhorse:worker:concurrency"] = "8" } },
        { "pollingonly-upper", new() { ["Workhorse:Worker:PollingOnly"] = "TRUE" } },
        { "defaultqueue-lowercase", new() { ["workhorse:queue:defaultqueue"] = "mail" } },
        { "defaultqueue-empty", new() { ["Workhorse:Queue:DefaultQueue"] = "" } },
        { "defaultqueue-child", new() { ["Workhorse:Queue:DefaultQueue:Sub"] = "x" } },
        { "unknown", new() { ["Workhorse:Worker:Unknown:Sub"] = "x", ["Workhorse:Queue:Unknown"] = "x" } },
    };

    /// <summary>The 0.12 binding: the plain binder on each section, and the two list replacements.</summary>
    private static ServiceProvider PlainProvider(Dictionary<string, string?> settings)
    {
        var section = Configuration(settings).GetSection("Workhorse");
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddOptions<QueueOptions>().Bind(section.GetSection("Queue"));
        services.AddOptions<WorkerOptions>().Configure(options =>
        {
            var worker = section.GetSection("Worker");
            worker.Bind(options);
            if (worker.GetSection("Queues") is { } queues && queues.Exists())
            {
                options.Queues = queues.Get<List<string>>() ?? [];
            }

            if (worker.GetSection("ScheduleNamespaces") is { } namespaces && namespaces.Exists())
            {
                options.ScheduleNamespaces = namespaces.Get<List<string>>() ?? [];
            }
        });
        return services.BuildServiceProvider();
    }

    private static string Outcome(ServiceProvider provider)
    {
        using var owned = provider;
        string Read(Func<string> read)
        {
            try
            {
                return read();
            }
            catch (InvalidOperationException error)
            {
                return $"throws {error.Message}";
            }
        }

        var worker = Read(() =>
        {
            var options = provider.GetRequiredService<IOptions<WorkerOptions>>().Value;
            return string.Join(';', typeof(WorkerOptions).GetProperties()
                .Where(property => property.Name != nameof(WorkerOptions.LoggerFactory))
                .Select(property => $"{property.Name}={Text(property.GetValue(options))}"));
        });
        var queue = Read(() =>
        {
            var options = provider.GetRequiredService<IOptions<QueueOptions>>().Value;
            return $"DefaultQueue={Text(options.DefaultQueue)};Json={Text(options.Json)}";
        });
        return $"{worker} | {queue}";
    }

    /// <summary>A key that names no option stays ignored, as on 0.12, so no working configuration starts to fail.</summary>
    [Fact]
    public void AKeyThatNamesNoOptionStaysIgnored()
    {
        using var provider = Provider(new Dictionary<string, string?>
        {
            ["Workhorse:Worker:Unknown"] = "1",
            ["Workhorse:Queue:Unknown:Child"] = "1",
            ["Workhorse:Other:Json:WriteIndented"] = "true",
        });
        Assert.Null(provider.GetRequiredService<IOptions<WorkerOptions>>().Value.Json);
        Assert.Null(provider.GetRequiredService<IOptions<QueueOptions>>().Value.Json);
    }

    [Fact]
    public async Task DataSourceKeySelectsAKeyedDataSource()
    {
        await using var other = database.CreateDataSource(_ => { });
        var services = new ServiceCollection();
        services.AddSingleton(other);
        services.AddKeyedSingleton("jobs", database.DataSource);
        services.AddWorkhorse(Configuration(new Dictionary<string, string?> { ["Workhorse:DataSourceKey"] = "jobs" }));
        await using var provider = services.BuildServiceProvider();

        Assert.Same(database.DataSource, provider.GetRequiredService<Workhorse.Hosting.Internal.WorkhorseDataSource>().Value);
        await provider.GetRequiredService<Queue>().AssertCompatibleAsync(TestContext.Current.CancellationToken);
        Assert.NotNull(provider.GetRequiredService<Admin>());
    }

    [Fact]
    public void AMissingDataSourceNamesTheFix()
    {
        var services = new ServiceCollection();
        services.AddWorkhorse(Configuration(new Dictionary<string, string?> { ["Workhorse:DataSourceKey"] = "jobs" }));
        using var provider = services.BuildServiceProvider();
        var keyed = Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<Queue>());
        Assert.Contains("'jobs'", keyed.Message, StringComparison.Ordinal);

        var plain = new ServiceCollection();
        plain.AddWorkhorse(Configuration(new Dictionary<string, string?>()));
        using var plainProvider = plain.BuildServiceProvider();
        var missing = Assert.Throws<InvalidOperationException>(() => plainProvider.GetRequiredService<Admin>());
        Assert.Contains("AddNpgsqlDataSource", missing.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AQueueThatTheApplicationRegistersFirstStays()
    {
        var mine = new Queue(database.DataSource, new QueueOptions { DefaultQueue = "mine" });
        var services = new ServiceCollection();
        services.AddSingleton(database.DataSource);
        services.AddSingleton(mine);
        services.AddWorkhorse(Configuration(new Dictionary<string, string?>()));
        using var provider = services.BuildServiceProvider();
        Assert.Same(mine, provider.GetRequiredService<Queue>());
    }

    private static ServiceProvider Provider(Dictionary<string, string?> settings)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddWorkhorse(Configuration(settings));
        return services.BuildServiceProvider();
    }

    private static IConfiguration Configuration(Dictionary<string, string?> settings) =>
        new ConfigurationBuilder().AddInMemoryCollection(settings).Build();

    private static IEnumerable<PropertyInfo> Bindable(Type options) =>
        options.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => property.SetMethod is { IsPublic: true } && !CodeOnly.Contains(property.Name, StringComparer.Ordinal));

    private static (Type Owner, PropertyInfo Property) Property(string key)
    {
        var parts = key.Split(':');
        var owner = parts[1] == "Worker" ? typeof(WorkerOptions) : typeof(QueueOptions);
        return (owner, owner.GetProperty(parts[2])!);
    }

    private static string TypeName(Type type, PropertyInfo property)
    {
        var nullable = new NullabilityInfoContext().Create(property).WriteState == NullabilityState.Nullable;
        if (Nullable.GetUnderlyingType(type) is { } underlying)
        {
            return $"{TypeName(underlying, property)}?";
        }

        var name = type == typeof(string) ? "string"
            : type == typeof(int) ? "int"
            : type == typeof(bool) ? "bool"
            : type == typeof(TimeSpan) ? "TimeSpan"
            : type == typeof(IList<string>) ? "string[]"
            : type.Name;
        return nullable && !type.IsValueType ? $"{name}?" : name;
    }

    /// <summary>One text form for a file default and an option value, so the test compares them.</summary>
    private static string Text(object? value) => value switch
    {
        null => "null",
        JsonElement { ValueKind: JsonValueKind.Null } => "null",
        JsonElement { ValueKind: JsonValueKind.Array } array => $"[{string.Join(',', array.EnumerateArray().Select(item => item.GetString()))}]",
        JsonElement { ValueKind: JsonValueKind.String } text => text.GetString()!,
        JsonElement element => element.GetRawText(),
        TimeSpan span => span.ToString("c", CultureInfo.InvariantCulture),
        bool flag => flag ? "true" : "false",
        IEnumerable<string> list => $"[{string.Join(',', list)}]",
        IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString()!,
    };

    private static List<Key> Keys()
    {
        using var stream = typeof(WorkhorseServiceCollectionExtensions).Assembly
            .GetManifestResourceStream("Workhorse.Hosting.ConfigurationKeys.json")!;
        using var document = JsonDocument.Parse(stream);
        return [.. document.RootElement.GetProperty("keys").EnumerateArray().Select(key => new Key(
            key.GetProperty("key").GetString()!,
            key.GetProperty("type").GetString()!,
            key.GetProperty("default").Clone()))];
    }
}
