// Starts the scenario program that the first argument names.
using Workhorse.Examples.Programs.Scenarios;

switch (args.FirstOrDefault())
{
    case "quickstart":
        await QuickstartProgram.RunAsync();
        return 0;
    case "transaction":
        await TransactionProgram.RunAsync();
        return 0;
    case "dedicated-worker":
        await DedicatedWorkerProgram.RunAsync(args[1..]);
        return 0;
    case "orchestration":
        await OrchestrationProgram.RunAsync();
        return 0;
    case "agentic-flow":
        await AgenticFlowProgram.RunAsync();
        return 0;
    default:
        Console.Error.WriteLine(
            "usage: Workhorse.Examples.Programs quickstart|transaction|dedicated-worker|orchestration|agentic-flow");
        return 2;
}
