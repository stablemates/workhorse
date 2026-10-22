namespace Workhorse.AspNetCore;

/// <summary>
/// What <see cref="DashboardOptions.Authorize"/> decides for one request: a bare allow, a deny, a
/// principal, or a complete response. The four results are the same in every SDK (ADR 0107).
/// </summary>
public abstract class DashboardAuthorization
{
    private static readonly DashboardAuthorization AllowInstance = new AllowResult();
    private static readonly DashboardAuthorization DenyInstance = new DenyResult();

    private protected DashboardAuthorization()
    {
    }

    /// <summary>Accepts the request with <see cref="DashboardOptions.AuditActor"/> as the actor.</summary>
    public static DashboardAuthorization Allow() => AllowInstance;

    /// <summary>Refuses the request. The dashboard answers 401.</summary>
    public static DashboardAuthorization Deny() => DenyInstance;

    /// <summary>Accepts the request for a verified identity, which names the actor of each control.</summary>
    /// <param name="actor">The actor that PostgreSQL records for each control of the request.</param>
    /// <param name="claims">Other facts about the identity. The dashboard does not read them.</param>
    /// <exception cref="ArgumentException"><paramref name="actor"/> is empty or only whitespace.</exception>
    public static DashboardAuthorization Principal(string actor, IReadOnlyDictionary<string, object?>? claims)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(actor);
        return new PrincipalResult(actor, claims is null ? new Dictionary<string, object?>() : new Dictionary<string, object?>(claims));
    }

    /// <summary>
    /// Refuses the request with a complete response, such as a redirect to a login page or a 403. The
    /// dashboard sends it as it is and does no other work for the request.
    /// </summary>
    /// <param name="status">The HTTP status, 100 to 599.</param>
    /// <param name="headers">The response headers.</param>
    /// <param name="body">The response body. The dashboard keeps a copy.</param>
    /// <exception cref="ArgumentOutOfRangeException"><paramref name="status"/> is not 100 to 599.</exception>
    public static DashboardAuthorization Response(int status, IReadOnlyDictionary<string, string> headers, ReadOnlyMemory<byte> body)
    {
        ArgumentNullException.ThrowIfNull(headers);
        ArgumentOutOfRangeException.ThrowIfLessThan(status, 100);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(status, 599);
        return new ResponseResult(status, new Dictionary<string, string>(headers, StringComparer.OrdinalIgnoreCase), body.ToArray());
    }

    internal sealed class AllowResult : DashboardAuthorization;

    internal sealed class DenyResult : DashboardAuthorization;

    internal sealed class PrincipalResult(string actor, IReadOnlyDictionary<string, object?> claims) : DashboardAuthorization
    {
        internal string Actor { get; } = actor;

        internal IReadOnlyDictionary<string, object?> Claims { get; } = claims;
    }

    internal sealed class ResponseResult(int status, IReadOnlyDictionary<string, string> headers, byte[] body) : DashboardAuthorization
    {
        internal int Status { get; } = status;

        internal IReadOnlyDictionary<string, string> Headers { get; } = headers;

        internal ReadOnlyMemory<byte> Body { get; } = body;
    }
}
