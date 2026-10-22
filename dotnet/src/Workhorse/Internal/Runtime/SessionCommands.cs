namespace Workhorse.Internal.Runtime;

/// <summary>
/// The session commands of the heartbeat and listener connections, and the only SQL text of the
/// worker outside <see cref="SqlCatalogue"/>. They are not protocol SQL: they call no Workhorse
/// function and read no Workhorse table, so the catalogue does not hold them. The JVM keeps the same
/// commands as constants beside its heartbeat and listener.
/// </summary>
internal static class SessionCommands
{
    /// <summary>Starts the transaction of one heartbeat round.</summary>
    internal const string Begin = "BEGIN";

    /// <summary>Ends a heartbeat round that renewed its leases.</summary>
    internal const string Commit = "COMMIT";

    /// <summary>Ends a heartbeat round that failed or expired before its heartbeat statement.</summary>
    internal const string Rollback = "ROLLBACK";

    /// <summary>
    /// Sets both server timeouts of a heartbeat round for its transaction only (SM-1442).
    /// <c>SET LOCAL</c> cannot take a bind parameter, and <c>set_config(..., true)</c> has the same
    /// scope, so the connection keeps no session state.
    /// </summary>
    internal const string RoundTimeouts =
        "SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)";

    /// <summary>The notification channel on which PostgreSQL announces claimable work.</summary>
    private const string Channel = "workhorse_tasks";

    /// <summary>Subscribes the listener connection to the channel.</summary>
    internal const string Listen = "LISTEN " + Channel;

    /// <summary>Ends the subscription before the listener connection goes back to the pool.</summary>
    internal const string Unlisten = "UNLISTEN " + Channel;

    /// <summary>The listener's keepalive after one quiet poll interval (ADR 0107).</summary>
    internal const string Keepalive = "SELECT 1";
}
