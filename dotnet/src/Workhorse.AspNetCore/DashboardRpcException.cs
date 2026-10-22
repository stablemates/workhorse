namespace Workhorse.AspNetCore;

/// <summary>
/// A <c>dashboard/v1</c> procedure refused its request with an RPC status and code. The dashboard
/// answers with the status and an error envelope that holds the code, the message, and the data.
/// </summary>
public sealed class DashboardRpcException : Exception
{
    /// <summary>A refusal.</summary>
    /// <param name="status">The HTTP status, such as 409.</param>
    /// <param name="code">The RPC code, such as <c>CONFLICT</c>.</param>
    /// <param name="message">The message for the operator.</param>
    /// <param name="data">A value for the envelope's <c>data</c>, or <c>null</c> for none.</param>
    public DashboardRpcException(int status, string code, string message, object? data = null)
        : base(message)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(status, 400);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(status, 599);
        ArgumentException.ThrowIfNullOrWhiteSpace(code);
        Status = status;
        Code = code;
        Details = data;
    }

    /// <summary>A refusal with no status, which the analyzers require. It answers 500.</summary>
    public DashboardRpcException()
        : this(500, "INTERNAL_SERVER_ERROR", "Internal server error")
    {
    }

    /// <summary>A refusal with a message. It answers 500.</summary>
    public DashboardRpcException(string message)
        : this(500, "INTERNAL_SERVER_ERROR", message)
    {
    }

    /// <summary>A refusal with a message and a cause. It answers 500.</summary>
    public DashboardRpcException(string message, Exception innerException)
        : base(message, innerException)
    {
        Status = 500;
        Code = "INTERNAL_SERVER_ERROR";
    }

    /// <summary>The HTTP status.</summary>
    public int Status { get; }

    /// <summary>The RPC code.</summary>
    public string Code { get; }

    /// <summary>The envelope's <c>data</c>, or <c>null</c>.</summary>
    public object? Details { get; }

    /// <summary>A 404 <c>NOT_FOUND</c> refusal.</summary>
    public static DashboardRpcException NotFound(string message) => new(404, "NOT_FOUND", message);
}
