using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Npgsql;
using Workhorse.Hosting;

namespace Workhorse.DemoWorker;

/// <summary>
/// Serves the .NET queues of the dashboard demo, plus the queue every demo language shares. It is
/// the .NET counterpart of <c>ruby/examples/demo_worker.rb</c> and of the JVM
/// <c>DemoWorkerProgram</c>.
/// </summary>
/// <remarks>
/// Both demo launchers start this worker (SM-1680). A test runs the program against a scratch
/// database.
/// Documentation: https://workhorse.run/docs/dashboard
/// </remarks>
internal static partial class DemoWorkerProgram
{
    internal const string LanguageTaskType = "demo.language-worker";
    internal const string SharedTaskType = "demo.shared-worker";
    internal const string DotnetQueue = "demo-dotnet";
    internal const string DotnetFastQueue = "demo-dotnet-fast";
    internal const string SharedQueue = "demo-shared";
    internal const string ScheduleNamespace = "workhorse-demo";
    internal const string FastTierScheduleNamespace = "workhorse-demo-fast-tier";
    internal const string Language = "dotnet";
    internal const int WorkerConcurrency = 6;
    internal const long DefaultPollMs = 15_000;
    internal static readonly TimeSpan SchemaRetry = TimeSpan.FromMilliseconds(500);

    /// <summary>The grace of the other demo workers. It and the 250 ms unwind window fit the host's 30 s shutdown timeout.</summary>
    internal static readonly TimeSpan ShutdownGrace = TimeSpan.FromSeconds(25);

    /// <summary>Waits for the schema in development, then runs the host until it stops.</summary>
    /// <returns>The process exit code. The hosted worker sets 1 when it fails.</returns>
    internal static async Task<int> RunAsync(string[] args, Func<string, string?> environment)
    {
        var pollInterval = PollInterval(environment);
        var waits = WaitsForSchema(environment);
        await using var dataSource = NpgsqlDataSource.Create(ConnectionString(DatabaseUrl(environment)));
        if (waits)
        {
            await WaitForSchemaAsync(dataSource, SchemaRetry, CancellationToken.None).ConfigureAwait(false);
        }

        using var host = BuildHost(args, dataSource, pollInterval, WorkerId());
        await host.RunAsync().ConfigureAwait(false);
        return Environment.ExitCode;
    }

    /// <summary>Builds the Generic Host whose worker serves the .NET queue, the fast-tier .NET queue, and the shared queue.</summary>
    internal static IHost BuildHost(string[] args, NpgsqlDataSource dataSource, TimeSpan? pollInterval, string workerId)
    {
        var builder = Host.CreateApplicationBuilder(args);
        builder.Configuration.AddInMemoryCollection(WorkerSettings(pollInterval, workerId));
        builder.Services.AddSingleton(dataSource);
        builder.Services.AddWorkhorse(builder.Configuration);
        builder.Services.AddWorkhorseWorker(handlers => handlers
            .Handle<JsonElement, Dictionary<string, object>>(LanguageTaskType, LanguageTaskAsync)
            .Handle<JsonElement, Dictionary<string, object>>(SharedTaskType, SharedTaskAsync));
        return builder.Build();
    }

    /// <summary>The <c>Workhorse:Worker</c> keys of the demo worker.</summary>
    internal static Dictionary<string, string?> WorkerSettings(TimeSpan? pollInterval, string workerId)
    {
        var settings = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["Workhorse:Worker:Queues:0"] = DotnetQueue,
            ["Workhorse:Worker:Queues:1"] = SharedQueue,
            ["Workhorse:Worker:Queues:2"] = DotnetFastQueue,
            ["Workhorse:Worker:ScheduleNamespaces:0"] = ScheduleNamespace,
            ["Workhorse:Worker:ScheduleNamespaces:1"] = FastTierScheduleNamespace,
            ["Workhorse:Worker:WorkerId"] = workerId,
            ["Workhorse:Worker:Concurrency"] = WorkerConcurrency.ToString(CultureInfo.InvariantCulture),
            ["Workhorse:Worker:MaintenanceInterval"] = Duration(TimeSpan.FromSeconds(1)),
            ["Workhorse:Worker:RegistryInterval"] = Duration(TimeSpan.FromMilliseconds(250)),
            ["Workhorse:Worker:ShutdownGrace"] = Duration(ShutdownGrace),
        };
        if (pollInterval is { } poll)
        {
            settings["Workhorse:Worker:PollInterval"] = Duration(poll);
        }

        return settings;
    }

    internal static Task<Dictionary<string, object>> LanguageTaskAsync(HandlerContext context, JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("language", out var language)
            || language.ValueKind != JsonValueKind.String
            || language.GetString() != Language)
        {
            throw new ArgumentException(".NET worker received a task for another language");
        }

        return Task.FromResult(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["language"] = Language,
            ["runtime"] = Language,
            ["attempt"] = context.Task.Attempt,
        });
    }

    internal static Task<Dictionary<string, object>> SharedTaskAsync(HandlerContext context, JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("source", out var source)
            || source.ValueKind != JsonValueKind.String)
        {
            throw new ArgumentException("Shared worker requires a source");
        }

        return Task.FromResult(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["source"] = source.GetString()!,
            ["runtime"] = Language,
            ["attempt"] = context.Task.Attempt,
        });
    }

    /// <summary>Reads <c>DATABASE_URL_PRIMARY</c>.</summary>
    internal static string DatabaseUrl(Func<string, string?> environment)
    {
        var value = environment("DATABASE_URL_PRIMARY");
        return string.IsNullOrEmpty(value) ? throw new ArgumentException("DATABASE_URL_PRIMARY is required") : value;
    }

    /// <summary>Reads <c>WORKHORSE_WORKER_POLL_MS</c>. Zero leaves the SDK default in place, so the result is <c>null</c>.</summary>
    internal static TimeSpan? PollInterval(Func<string, string?> environment)
    {
        var value = environment("WORKHORSE_WORKER_POLL_MS");
        var milliseconds = DefaultPollMs;
        if (!string.IsNullOrEmpty(value)
            && (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out milliseconds)))
        {
            throw new ArgumentException("WORKHORSE_WORKER_POLL_MS must be a non-negative integer");
        }

        return milliseconds == 0 ? null : TimeSpan.FromMilliseconds(milliseconds);
    }

    /// <summary>Only the development demo waits for a missing schema. Production refuses at once.</summary>
    internal static bool WaitsForSchema(Func<string, string?> environment)
    {
        var mode = environment("WORKHORSE_DEMO_MODE");
        return string.IsNullOrEmpty(mode) ? false : mode switch
        {
            "development" => true,
            "production" => false,
            _ => throw new ArgumentException("WORKHORSE_DEMO_MODE must be either development or production"),
        };
    }

    /// <summary>Waits while the demo server has not installed the schema yet.</summary>
    /// <remarks>
    /// In development the server installs the schema on first start, so a worker that starts beside
    /// it can see an empty database. Every other compatibility refusal fails at once. A Queue caches
    /// its refusal, so each check builds a new one.
    /// </remarks>
    internal static async Task WaitForSchemaAsync(NpgsqlDataSource dataSource, TimeSpan retry, CancellationToken cancellationToken)
    {
        var logged = false;
        while (true)
        {
            try
            {
                await new Queue(dataSource).AssertCompatibleAsync(cancellationToken).ConfigureAwait(false);
                return;
            }
            catch (CompatibilityException error) when (error.Code == CompatibilityCode.SchemaNotInstalled)
            {
                if (!logged)
                {
                    Console.WriteLine("Waiting for the demo server to install the Workhorse schema");
                    logged = true;
                }

                await Task.Delay(retry, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    internal static string WorkerId()
    {
        var hostname = UnsafeHostCharacters().Replace(Environment.MachineName, "-");
        if (hostname.Length == 0)
        {
            hostname = "unknown-host";
        }

        return $"demo-dotnet-{hostname}-{Environment.ProcessId}-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4))}";
    }

    /// <summary>
    /// Npgsql reads no URL, so the program turns <c>DATABASE_URL_PRIMARY</c> into a connection
    /// string. Each value uses percent decoding only, as libpq decodes it, so a <c>+</c> stays a
    /// <c>+</c>. The pool holds a connection for each handler slot, the heartbeat, the notification
    /// listener, and the dispatch loop at once.
    /// </summary>
    /// <exception cref="ArgumentException">The URL is not a PostgreSQL URL, or it names a parameter the program does not map.</exception>
    internal static string ConnectionString(string url)
    {
        // libpq reads an empty host with a host parameter as a Unix socket URL, but Uri refuses an
        // empty host. A placeholder host lets Uri parse it, and the host parameter must replace it.
        var emptyHost = EmptyHost().Match(url);
        if (emptyHost.Success)
        {
            url = url.Insert(emptyHost.Length, "localhost");
        }

        var hostParameter = false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("postgres" or "postgresql"))
        {
            throw new ArgumentException("DATABASE_URL_PRIMARY must be a postgres:// or postgresql:// URL");
        }

        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = Uri.UnescapeDataString(uri.Host.Trim('[', ']')),
            Port = uri.IsDefaultPort || uri.Port < 0 ? 5432 : uri.Port,
            Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),
            MaxPoolSize = WorkerConcurrency + 4,
        };
        var userInfo = uri.UserInfo.Split(':', 2);
        if (userInfo[0].Length > 0)
        {
            builder.Username = Uri.UnescapeDataString(userInfo[0]);
        }

        if (userInfo.Length > 1)
        {
            builder.Password = Uri.UnescapeDataString(userInfo[1]);
        }

        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            var name = Uri.UnescapeDataString(parts[0]);
            var value = parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : "";
            switch (name)
            {
                case "host":
                    builder.Host = value;
                    hostParameter = true;
                    break;
                case "port":
                    builder.Port = int.Parse(value, NumberStyles.None, CultureInfo.InvariantCulture);
                    break;
                case "sslmode":
                    builder.SslMode = Enum.Parse<SslMode>(value.Replace("-", "", StringComparison.Ordinal), ignoreCase: true);
                    break;
                case "gssencmode":
                    builder.GssEncryptionMode = Enum.Parse<GssEncryptionMode>(value, ignoreCase: true);
                    break;
                case "application_name":
                    builder.ApplicationName = value;
                    break;
                case "connect_timeout":
                    builder.Timeout = int.Parse(value, NumberStyles.None, CultureInfo.InvariantCulture);
                    break;
                case "options":
                    builder.Options = value;
                    break;
                default:
                    throw new ArgumentException($"DATABASE_URL_PRIMARY names the parameter {name}, which the .NET demo worker does not map");
            }
        }

        if (emptyHost.Success && !hostParameter)
        {
            throw new ArgumentException("DATABASE_URL_PRIMARY without a host must name the socket directory in its host parameter");
        }

        return builder.ConnectionString;
    }

    private static string Duration(TimeSpan value) => value.ToString("c", CultureInfo.InvariantCulture);

    [GeneratedRegex("^postgres(?:ql)?://(?:[^@/?#]*@)?(?=[/?#]|$)")]
    private static partial Regex EmptyHost();

    [GeneratedRegex("[^A-Za-z0-9._-]")]
    private static partial Regex UnsafeHostCharacters();
}
