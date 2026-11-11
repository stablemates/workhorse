using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Npgsql;

namespace Workhorse.AspNetCore;

/// <summary>
/// The options of one embedded dashboard. They are the options of Ruby's <c>Dashboard</c>, with C#
/// types (ADR 0107, "Embedded dashboard backend").
/// </summary>
public sealed class DashboardOptions
{
    /// <summary>
    /// The database. Each procedure call uses one connection from it. A control runs in autocommit,
    /// and a read runs in its own read-only transaction (see <see cref="StatementTimeout"/>).
    /// </summary>
    public required NpgsqlDataSource DataSource { get; init; }

    /// <summary>
    /// Decides each request under the mount path, after the host check and before any other work.
    /// It runs for every request, also when the host adds an ASP.NET Core authorization policy.
    /// </summary>
    public required Func<HttpContext, ValueTask<DashboardAuthorization>> Authorize { get; init; }

    /// <summary>The environment name that the <c>meta</c> procedure reports. The default is <c>development</c>.</summary>
    public string Environment { get; init; } = "development";

    /// <summary>
    /// The actor of a request that <see cref="Authorize"/> accepts with a bare allow. The default is
    /// <c>dashboard</c>. A principal names its own actor.
    /// </summary>
    public string AuditActor { get; init; } = "dashboard";

    /// <summary>Refuses every control, and tells the browser to offer none.</summary>
    public bool ReadOnly { get; init; }

    /// <summary>Extra browser module URLs that the application shell loads.</summary>
    public IReadOnlyList<string> BrowserModules { get; init; } = [];

    /// <summary>The worker IDs that the host expects, so the dashboard can show a missing one.</summary>
    public IReadOnlyList<string> ConfiguredWorkers { get; init; } = [];

    /// <summary>
    /// The maintenance loops that the <c>cron</c> procedure reports, as a JSON object. The default is
    /// <c>{"tickIntervalMs": 1000}</c>.
    /// </summary>
    public IReadOnlyDictionary<string, JsonElement> MaintenanceLoops { get; init; } =
        new Dictionary<string, JsonElement> { ["tickIntervalMs"] = JsonSerializer.SerializeToElement(1000) };

    /// <summary>The demo tools' <c>enqueueTest</c> procedure. The demo tools are off when it is unset.</summary>
    public DashboardProcedure? EnqueueTest { get; init; }

    /// <summary>The <c>setSchedulePaused</c> procedure. The dashboard refuses the control when it is unset.</summary>
    public DashboardProcedure? SetSchedulePaused { get; init; }

    /// <summary>
    /// The <c>host[:port]</c> values that the dashboard answers to. When it is not empty, a request
    /// whose <c>Host</c> is not in the list gets 421 Misdirected Request before <see cref="Authorize"/>
    /// runs. Letter case and a default port do not matter. Leave it empty when the host application
    /// already checks <c>Host</c>, for example with the host filtering middleware.
    /// </summary>
    public IReadOnlyList<string> AllowedHosts { get; init; } = [];

    /// <summary>
    /// How long one dashboard read can run. The default is 15 seconds, the
    /// <c>DASHBOARD_STATEMENT_TIMEOUT_MS</c> default of the TypeScript host.
    /// </summary>
    /// <remarks>
    /// Each read runs in its own read-only transaction, and PostgreSQL cancels a read that runs
    /// longer. The procedure then answers the <c>TIMEOUT</c> RPC error with status 408. The
    /// <c>CommandTimeout</c> of the data source still applies to each statement, and Npgsql stops a
    /// read when that client limit ends first; the procedure then answers 500. Keep the command
    /// timeout of <see cref="DataSource"/> above this value, or at 0 for no client limit.
    /// <c>MapWorkhorseDashboard</c> throws <see cref="ArgumentOutOfRangeException"/> for a value
    /// under 1 millisecond.
    /// </remarks>
    public TimeSpan StatementTimeout { get; init; } = TimeSpan.FromSeconds(15);

    /// <summary>Procedures that the host adds or replaces, by name.</summary>
    public IReadOnlyDictionary<string, DashboardProcedure> Procedures { get; init; } = new Dictionary<string, DashboardProcedure>();

    /// <summary>
    /// The serializer options for the result of each procedure that the host supplies. The default
    /// is <see cref="JsonSerializerDefaults.Web"/>.
    /// </summary>
    public JsonSerializerOptions? Json { get; init; }
}
