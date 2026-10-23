using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Workhorse.Examples.Programs.Scenarios;

namespace Workhorse.Examples.Programs.Tests.Testing;

/// <summary>
/// One scenario program, started as <c>dotnet Workhorse.Examples.Programs.dll &lt;scenario&gt;</c>
/// in a child process with its database URL in the environment. <see cref="DisposeAsync"/> kills a
/// child that still runs.
/// </summary>
public sealed class ProgramProcess : IAsyncDisposable
{
    private readonly Process _process;
    private readonly StringBuilder _output = new();
    private readonly StringBuilder _errors = new();

    private readonly CancellationToken _cancellation;

    private ProgramProcess(Process process, CancellationToken cancellation)
    {
        _process = process;
        _cancellation = cancellation;
    }

    /// <summary>
    /// Starts <paramref name="scenario"/> with <paramref name="databaseUrl"/> in
    /// <c>WORKHORSE_DATABASE_URL</c>. The waits of the instance end when <paramref name="cancellation"/>,
    /// the token of the test, is cancelled.
    /// </summary>
    public static ProgramProcess Start(string scenario, string databaseUrl, CancellationToken cancellation)
    {
        var start = new ProcessStartInfo(DotnetHost())
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add(typeof(QuickstartProgram).Assembly.Location);
        start.ArgumentList.Add(scenario);
        start.Environment["WORKHORSE_DATABASE_URL"] = databaseUrl;
        var process = new Process { StartInfo = start };
        var program = new ProgramProcess(process, cancellation);
        process.OutputDataReceived += (_, line) => Append(program._output, line.Data);
        process.ErrorDataReceived += (_, line) => Append(program._errors, line.Data);
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return program;
    }

    /// <summary>Waits until the program ends, and returns its exit status.</summary>
    public async Task<int> ExitAsync()
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_cancellation);
        timeout.CancelAfter(ScenarioDatabase.Patience);
        try
        {
            await _process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            Assert.Fail($"the program ends; {Describe()}");
        }

        // The parameterless wait returns after the output readers reach the end of their streams.
        _process.WaitForExit();
        return _process.ExitCode;
    }

    /// <summary>
    /// Sends <c>SIGTERM</c> after the worker registers, and returns the exit status. The test then
    /// expects no registry row.
    /// </summary>
    public async Task<int> TerminateRegisteredAsync(ScenarioDatabase db)
    {
        await ScenarioDatabase.EventuallyAsync(async () => await db.RegisteredWorkersAsync() > 0, $"the worker registers; {Describe()}", _cancellation);
        using (var kill = Process.Start("kill", ["-TERM", _process.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)]))
        {
            await kill.WaitForExitAsync(_cancellation);
            Assert.Equal(0, kill.ExitCode);
        }

        return await ExitAsync();
    }

    /// <summary>The standard output of the program.</summary>
    public string Output()
    {
        lock (_output)
        {
            return _output.ToString();
        }
    }

    /// <summary>The standard output and the standard error, for an assertion message.</summary>
    public string Describe()
    {
        lock (_output)
        {
            lock (_errors)
            {
                return $"standard output: {_output}; standard error: {_errors}";
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (!_process.HasExited)
        {
            _process.Kill(entireProcessTree: true);
            // The database drop waits for the connections of the child to end.
            await _process.WaitForExitAsync();
        }

        _process.Dispose();
    }

    private static void Append(StringBuilder buffer, string? line)
    {
        if (line is null)
        {
            return;
        }

        lock (buffer)
        {
            buffer.Append(line).Append('\n');
        }
    }

    /// <summary>
    /// The <c>dotnet</c> host of the runtime that runs the tests. The runtime directory is
    /// <c>&lt;root&gt;/shared/Microsoft.NETCore.App/&lt;version&gt;/</c>.
    /// </summary>
    private static string DotnetHost()
    {
        var root = Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", ".."));
        var host = Path.Combine(root, OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet");
        return File.Exists(host) ? host : "dotnet";
    }
}
