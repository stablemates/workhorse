using Npgsql;

namespace Workhorse.Examples.Programs;

/// <summary>The database connection that each program reads from its environment.</summary>
internal static class ProgramDatabase
{
    /// <summary>
    /// A data source for the PostgreSQL URL in <c>WORKHORSE_DATABASE_URL</c>. Npgsql reads no URL,
    /// so the method turns the URL into a connection string.
    /// </summary>
    public static NpgsqlDataSource DataSource()
    {
        var url = Environment.GetEnvironmentVariable("WORKHORSE_DATABASE_URL");
        if (string.IsNullOrEmpty(url))
        {
            throw new InvalidOperationException("WORKHORSE_DATABASE_URL is required");
        }

        return NpgsqlDataSource.Create(ConnectionString(new Uri(url)));
    }

    /// <summary>The connection string of a <c>postgres://</c> or <c>postgresql://</c> URL.</summary>
    private static NpgsqlConnectionStringBuilder ConnectionString(Uri url)
    {
        if (url.Scheme is not ("postgres" or "postgresql"))
        {
            throw new InvalidOperationException($"WORKHORSE_DATABASE_URL must be a PostgreSQL URL, not {url.Scheme}");
        }

        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = url.Host.Trim('[', ']'),
            Port = url.IsDefaultPort || url.Port < 0 ? 5432 : url.Port,
            Database = Uri.UnescapeDataString(url.AbsolutePath.TrimStart('/')),
        };
        var userInfo = url.UserInfo.Split(':', 2);
        if (userInfo[0].Length > 0)
        {
            builder.Username = Uri.UnescapeDataString(userInfo[0]);
        }

        if (userInfo.Length > 1)
        {
            builder.Password = Uri.UnescapeDataString(userInfo[1]);
        }

        foreach (var pair in url.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts[0] == "sslmode" && parts.Length > 1)
            {
                builder.SslMode = Enum.Parse<SslMode>(Uri.UnescapeDataString(parts[1]), ignoreCase: true);
            }
        }

        return builder;
    }
}
