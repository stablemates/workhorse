// Prints the informational version of each package assembly. With an Npgsql connection string, it
// also enqueues one task, runs it through the hosted worker of Workhorse.Hosting, checks the
// outcome, and prints the task id for the check to read back.
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;
using Workhorse;
using Workhorse.AspNetCore;
using Workhorse.EntityFrameworkCore;
using Workhorse.Hosting;

const string QueueName = "release-consumer";
const string TaskType = "release.consumer";

Type[] packages =
[
    typeof(Queue),
    typeof(WorkhorseServiceCollectionExtensions),
    typeof(WorkhorseDatabaseFacadeExtensions),
    typeof(DashboardOptions),
];
Console.WriteLine(string.Join(' ', packages.Select(type =>
    $"{type.Assembly.GetName().Name}={type.Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion}")));
if (args.Length == 0)
{
    return 0;
}

await using var dataSource = NpgsqlDataSource.Create(args[0]);
var builder = Host.CreateApplicationBuilder();
// The log goes to stderr, so stdout holds only the lines that the check reads.
builder.Logging.AddConsole(options => options.LogToStandardErrorThreshold = LogLevel.Trace);
builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
{
    ["Workhorse:Queue:DefaultQueue"] = QueueName,
    ["Workhorse:Worker:Queues:0"] = QueueName,
    ["Workhorse:Worker:DisableRegistry"] = "true",
    ["Workhorse:Worker:PollInterval"] = "00:00:00.200",
});
builder.Services.AddSingleton(dataSource);
builder.Services.AddWorkhorse(builder.Configuration);
builder.Services.AddWorkhorseWorker(handlers => handlers
    .Handle<JsonElement, Dictionary<string, JsonElement>>(TaskType, (_, payload) =>
        Task.FromResult(new Dictionary<string, JsonElement> { ["echo"] = payload })));
using var host = builder.Build();
await host.StartAsync();

var enqueued = await host.Services.GetRequiredService<Queue>().EnqueueAsync(TaskType, new { packaged = true });
var admin = host.Services.GetRequiredService<Admin>();
var deadline = DateTimeOffset.UtcNow.AddSeconds(60);
TaskDetail? task;
do
{
    await Task.Delay(TimeSpan.FromMilliseconds(100));
    task = await admin.GetTaskAsync(enqueued.TaskId);
}
while (task?.State is not (TaskState.Succeeded or TaskState.Failed or TaskState.Canceled) && DateTimeOffset.UtcNow < deadline);
await host.StopAsync();

if (task?.State != TaskState.Succeeded
    || task.Result?.GetProperty("echo").GetProperty("packaged").GetBoolean() != true)
{
    await Console.Error.WriteLineAsync($"task {enqueued.TaskId} is {task?.State.ToString() ?? "missing"}");
    return 1;
}

Console.WriteLine(enqueued.TaskId);
return 0;
