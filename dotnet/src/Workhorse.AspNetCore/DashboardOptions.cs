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
    /// <summary>The database. Each procedure call uses one connection from it and opens no transaction.</summary>
    /// <remarks>
    /// A refused <c>setQueueTier</c> answers <c>live_tasks</c>, <c>concurrency_policy</c>, or
    /// <c>rate_limit_policy</c> only when the connection string sets <c>Include Error Detail=true</c>,
    /// because Npgsql otherwise removes the PostgreSQL detail that names the cause. Without it, a
    /// refused switch answers 500, and the log names the cause and the setting.
    /// <see cref="DashboardEndpointRouteBuilderExtensions.MapWorkhorseDashboard"/> logs a warning
    /// when the setting is off.
    /// </remarks>
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

    /// <summary>Procedures that the host adds or replaces, by name.</summary>
    public IReadOnlyDictionary<string, DashboardProcedure> Procedures { get; init; } = new Dictionary<string, DashboardProcedure>();

    /// <summary>
    /// The serializer options for the result of each procedure that the host supplies. The default
    /// is <see cref="JsonSerializerDefaults.Web"/>.
    /// </summary>
    public JsonSerializerOptions? Json { get; init; }
}
