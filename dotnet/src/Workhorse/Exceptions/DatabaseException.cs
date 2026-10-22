namespace Workhorse;

/// <summary>
/// Any other error from Npgsql. The original is the <see cref="Exception.InnerException"/>, and
/// <see cref="SqlState"/> is its SQLSTATE. This class keeps Npgsql types out of the
/// <c>catch</c> clauses of a caller (ADR 0107, "Errors").
/// </summary>
public class DatabaseException : WorkhorseException
{
    /// <summary>An exception with the message of the driver, its SQLSTATE, and the original exception.</summary>
    public DatabaseException(string message, string? sqlState, Exception? innerException)
        : base(message, innerException)
    {
        SqlState = sqlState;
    }

    /// <summary>The SQLSTATE, or <c>null</c> when the driver reported none.</summary>
    public string? SqlState { get; }
}

/// <summary>
/// SQLSTATE <c>0A000</c> on a claim: the connection runs at an isolation level above read
/// committed. Configure the data source at read committed.
/// </summary>
public sealed class IsolationLevelException : DatabaseException
{
    /// <summary>An exception for the isolation level that PostgreSQL reported.</summary>
    public IsolationLevelException(string isolationLevel, string message, Exception? innerException)
        : base(message, "0A000", innerException)
    {
        IsolationLevel = isolationLevel;
    }

    /// <summary>The isolation level that the connection reported, such as <c>repeatable read</c>.</summary>
    public string IsolationLevel { get; }
}
