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
            ["Workhorse:Worker:SharedHeartbeats"] = "true",
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
        Assert.True(worker.SharedHeartbeats);
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
