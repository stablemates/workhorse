using System.Diagnostics;
using Npgsql;
using Workhorse.Internal;

namespace Workhorse.Tests.Conformance;

/// <summary>
/// A data source that shows each worker statement to a <see cref="Hook"/>. The counterpart of the
/// JVM <c>Intercept</c>: the runner injects faults around the worker's statements, never into the
/// worker itself.
/// </summary>
/// <remarks>
/// <para>
/// Npgsql calls the command filter of its tracing options before it sends a command, and it stops
/// the command's activity after the reader closes or the command fails. The filter calls
/// <see cref="Hook.Before"/>, and the listener's stop callback calls <see cref="Hook.After"/>. Both
/// run on the thread of the worker's statement, so a hook can hold the statement on either side.
/// </para>
/// <para>
/// One process-wide <see cref="ActivityListener"/> samples only the commands of these data sources:
/// the filter marks its thread just before Npgsql starts the activity, and the sampler reads the
/// mark. The commands of the other test classes create no activity.
/// </para>
/// </remarks>
internal sealed class Intercept : IAsyncDisposable
{
    private const string CallProperty = "workhorse.conformance.call";

    [ThreadStatic]
    private static Call? _pending;

    private static readonly ActivityListener Listener = Listen();

    private Intercept(NpgsqlDataSource dataSource) => DataSource = dataSource;

    /// <summary>The data source to give to the worker.</summary>
    internal NpgsqlDataSource DataSource { get; }

    /// <summary>A data source for <paramref name="database"/> whose statements <paramref name="hook"/> sees.</summary>
    internal static Intercept Create(ConformanceDatabase database, Hook hook)
    {
        _ = Listener;
        var builder = database.Builder();
        builder.ConfigureTracing(tracing => tracing
            .ConfigureCommandFilter(command =>
            {
                var call = new Call(command);
                hook.Before(call);
                _pending = call;
                return true;
            })
            .ConfigureCommandEnrichmentCallback((activity, _) =>
            {
                activity.SetCustomProperty(CallProperty, (_pending, hook));
                _pending = null;
            }));
        return new Intercept(builder.Build());
    }

    public ValueTask DisposeAsync() => DataSource.DisposeAsync();

    private static ActivityListener Listen()
    {
        var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == "Npgsql",
            Sample = (ref ActivityCreationOptions<ActivityContext> _) =>
                _pending is null ? ActivitySamplingResult.None : ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = activity =>
            {
                if (activity.GetCustomProperty(CallProperty) is (Call call, Hook hook))
                {
                    call.Finish(activity.Status == ActivityStatusCode.Error);
                    hook.After(call);
                }
            },
        };
        ActivitySource.AddActivityListener(listener);
        return listener;
    }

    /// <summary>One worker statement, as the hook sees it.</summary>
    internal sealed class Call(NpgsqlCommand command)
    {
        private readonly NpgsqlCommand _command = command;

        /// <summary>The SQL text of the statement.</summary>
        internal string Sql { get; } = command.CommandText;

        /// <summary>The rows that the statement returned. Valid in <see cref="Hook.After"/>.</summary>
        internal long Rows { get; private set; }

        /// <summary>Whether the statement failed. Valid in <see cref="Hook.After"/>.</summary>
        internal bool Failed { get; private set; }

        /// <summary>Whether this call runs <paramref name="statement"/>.</summary>
        internal bool Is(SqlCatalogue.Statement statement) => Sql == statement.Sql;

        /// <summary>The value bound to protocol parameter <c>$n</c>.</summary>
        internal object? Parameter(int protocol) => _command.Parameters[protocol - 1].Value;

        internal void Finish(bool failed)
        {
            Failed = failed;
            // The worker sends each statement as one NpgsqlCommand, and only Statements reports its row count.
#pragma warning disable CS0618
            Rows = _command.Statements.Sum(statement => (long)statement.Rows);
#pragma warning restore CS0618
        }
    }

    /// <summary>What the runner does around each worker statement.</summary>
    internal class Hook
    {
        /// <summary>A hook that does nothing.</summary>
        internal static readonly Hook None = new();

        /// <summary>Runs before PostgreSQL sees the statement.</summary>
        internal virtual void Before(Call call)
        {
        }

        /// <summary>Runs after the worker read the result, or after an error.</summary>
        internal virtual void After(Call call)
        {
        }
    }

    /// <summary>A hook made of two callbacks.</summary>
    internal sealed class Callbacks(Action<Call>? before = null, Action<Call>? after = null) : Hook
    {
        internal override void Before(Call call) => before?.Invoke(call);

        internal override void After(Call call) => after?.Invoke(call);
    }
}
