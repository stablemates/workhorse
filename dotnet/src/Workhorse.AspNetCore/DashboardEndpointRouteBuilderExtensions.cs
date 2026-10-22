using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Workhorse.AspNetCore.Internal;

namespace Workhorse.AspNetCore;

/// <summary>Maps the embedded Workhorse dashboard into an ASP.NET Core application (ADR 0107).</summary>
public static class DashboardEndpointRouteBuilderExtensions
{
    /// <summary>
    /// Maps one route group under <paramref name="pattern"/> that serves the dashboard, its browser
    /// application, and its <c>dashboard/v1</c> RPC contract.
    /// </summary>
    /// <remarks>
    /// A request outside the group goes to the host's other endpoints. The dashboard reads
    /// <c>HttpRequest.PathBase</c>, so it also works under a path base. The returned builder lets the
    /// host add its own metadata, for example <c>RequireAuthorization("operators")</c> or a rate
    /// limiter. <see cref="DashboardOptions.Authorize"/> still runs for each request.
    ///
    /// The dashboard is same-origin only. It refuses each request whose <c>Origin</c> header names
    /// another origin, so a host CORS policy cannot let a foreign page read it. Do not apply a CORS
    /// policy to the group: the CORS middleware answers a preflight request before the dashboard sees
    /// it. A host behind a proxy that ends TLS must apply the forwarded headers middleware first.
    /// </remarks>
    /// <param name="endpoints">The application's endpoints.</param>
    /// <param name="pattern">The literal mount path, for example <c>/workhorse</c>. <c>/</c> mounts the dashboard at the root.</param>
    /// <param name="options">The dashboard options.</param>
    /// <exception cref="ArgumentException">The pattern has a route parameter, or an option is not valid.</exception>
    public static IEndpointConventionBuilder MapWorkhorseDashboard(this IEndpointRouteBuilder endpoints, string pattern, DashboardOptions options)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var logger = endpoints.ServiceProvider.GetService<ILoggerFactory>()?.CreateLogger("Workhorse.AspNetCore.Dashboard")
            ?? NullLogger.Instance;
        var host = new DashboardHost(pattern, options, logger);
        var group = endpoints.MapGroup(host.BasePath.Length == 0 ? "/" : host.BasePath);
        group.Map("{**path}", host.HandleAsync);
        return group;
    }
}
