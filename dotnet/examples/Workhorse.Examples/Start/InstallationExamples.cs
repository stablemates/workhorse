using Npgsql;

namespace Workhorse.Examples.Start;

/// <summary>The C# tab of the site page about installation.</summary>
public static class InstallationExamples
{
    public static async Task AssertCompatibleAsync(NpgsqlDataSource dataSource)
    {
        // docs:start csharp-installation-assert-compatible
        var queue = new Queue(dataSource);
        await queue.AssertCompatibleAsync();
        // docs:end
    }
}
