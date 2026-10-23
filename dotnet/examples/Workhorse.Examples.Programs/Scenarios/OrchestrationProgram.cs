using System.Runtime.InteropServices;
using System.Text.Json;

namespace Workhorse.Examples.Programs.Scenarios;

/// <summary>
/// Runs an order handler that starts two child tasks, then waits for a signal and a human decision.
/// The signal and the decision can be any JSON value. The worker runs until SIGINT or SIGTERM, then
/// drains its active tasks.
/// </summary>
/// <remarks>Documentation: https://workhorse.run/docs/examples</remarks>
public static class OrchestrationProgram
{
    public static async Task RunAsync()
    {
        await using var dataSource = ProgramDatabase.DataSource();
        await using var worker = new Worker(dataSource, new WorkerOptions { Queues = ["orders"] });
        worker.Handle("order.process", async (HandlerContext context, JsonElement payload) =>
        {
            var children = await context.RunChildrenAllAsync(
            [
                new ChildRequest { Name = "invoice", TaskType = "invoice.create", Payload = payload },
                new ChildRequest { Name = "receipt", TaskType = "receipt.send", Payload = payload },
            ]);
            var approval = await context.WaitForSignalAsync<JsonElement>("approval", timeout: null);
            var decision = await context.WaitForHumanAsync<object, JsonElement>(
                "review",
                new { payload, approval },
                timeout: null);
            return new { children, approval, decision };
        });
        worker.Handle<JsonElement, ChildResult>("invoice.create", CompleteChild);
        worker.Handle<JsonElement, ChildResult>("receipt.send", CompleteChild);

        using var stopping = new CancellationTokenSource();
        using var interrupt = PosixSignalRegistration.Create(PosixSignal.SIGINT, Stop);
        using var terminate = PosixSignalRegistration.Create(PosixSignal.SIGTERM, Stop);
        await worker.RunAsync(stopping.Token);

        void Stop(PosixSignalContext signal)
        {
            // The worker drains, and the program then ends by itself.
            signal.Cancel = true;
            stopping.Cancel();
        }
    }

    private static Task<ChildResult> CompleteChild(HandlerContext context, JsonElement payload) =>
        Task.FromResult(new ChildResult(true, payload));

    /// <summary>The result of <c>invoice.create</c> and <c>receipt.send</c>.</summary>
    public sealed record ChildResult(bool Completed, JsonElement Payload);
}
