using Workhorse.DemoWorker;

try
{
    return await DemoWorkerProgram.RunAsync(args, Environment.GetEnvironmentVariable).ConfigureAwait(false);
}
catch (ArgumentException error)
{
    await Console.Error.WriteLineAsync(error.Message).ConfigureAwait(false);
    return 1;
}
