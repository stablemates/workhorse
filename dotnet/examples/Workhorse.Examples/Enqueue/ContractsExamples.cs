using System.Text.Json;

namespace Workhorse.Examples.Enqueue;

/// <summary>The C# tab of the site page about payload contracts.</summary>
public sealed class ContractsExamples(Queue queue)
{
    public async Task SyncContractsAsync()
    {
        // docs:start csharp-contracts-sync
        var contracts = new Dictionary<string, TaskTypeContracts>
        {
            ["mail.send"] = new TaskTypeContracts
            {
                CurrentVersion = "mail-current",
                Versions = new Dictionary<string, TaskContractVersion>
                {
                    ["mail-current"] = new TaskContractVersion
                    {
                        PayloadSchema = JsonElement.Parse("""{"type": "object", "required": ["recipient"]}"""),
                        ResultSchema = JsonElement.Parse("""{"type": "object"}"""),
                        SensitivePayloadKeys = ["accessToken"],
                    },
                },
            },
        };
        await queue.SyncContractsAsync(contracts);
        // docs:end
    }
}
