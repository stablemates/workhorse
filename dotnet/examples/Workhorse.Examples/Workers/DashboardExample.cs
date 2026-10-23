using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Npgsql;
using Workhorse.AspNetCore;

namespace Workhorse.Examples.Workers;

/// <summary>The ASP.NET Core dashboard backend: guide 370 and the site page about the dashboard.</summary>
/// <param name="dataSource">The database that the dashboard serves.</param>
/// <param name="session">Reads the user name of the application session, or <c>null</c>.</param>
public sealed class DashboardExample(NpgsqlDataSource dataSource, Func<HttpContext, string?> session)
{
    private string? ApplicationAdminSession(HttpContext context) => session(context);

    /// <summary>Maps the dashboard under <c>/workhorse</c> on <paramref name="app"/>.</summary>
    public void Map(WebApplication app)
    {
        // docs:start csharp-dashboard-map
        app.MapWorkhorseDashboard("/workhorse", new DashboardOptions
        {
            DataSource = dataSource,
            Authorize = context =>
            {
                var username = ApplicationAdminSession(context);
                return ValueTask.FromResult(username is not null
                    ? DashboardAuthorization.Principal(username, null)
                    : DashboardAuthorization.Deny());
            },
            Environment = "production",
            AllowedHosts = ["ops.example.com"],
        });
        // docs:end
    }
}
