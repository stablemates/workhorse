namespace Workhorse.Examples.Durable;

/// <summary>The payload of the <c>account.activate</c> task.</summary>
public sealed record AccountPayload(string AccountId);

/// <summary>The payload of the <c>approval</c> signal.</summary>
public sealed record Approval(bool Approved);

/// <summary>The C# tab of the site page about signals.</summary>
public sealed class SignalsExamples(Func<Task> publications)
{
    /// <summary>Registers the <c>order.publish</c> handler, which waits for the <c>approval</c> signal.</summary>
    public void Register(Worker worker)
    {
        ArgumentNullException.ThrowIfNull(worker);
        worker.Handle<OrderPayload, Approval>(
            "order.publish",
            async (context, payload) =>
            {
                // docs:start csharp-signals-wait
                var approval = await context.WaitForSignalAsync<Approval>("approval", null);
                if (approval.Approved)
                {
                    await PublishOrderAsync();
                }
                // docs:end
                return approval;
            });
    }

    private Task PublishOrderAsync() => publications();
}

/// <summary>The C# tab of the site page about human waits.</summary>
public sealed class HumanWaitsExamples(Func<string, Task> activations)
{
    /// <summary>Registers the <c>account.activate</c> handler, which waits for a human decision.</summary>
    public void Register(Worker worker)
    {
        ArgumentNullException.ThrowIfNull(worker);
        worker.Handle<AccountPayload, Review>(
            "account.activate",
            async (context, payload) =>
            {
                var accountId = payload.AccountId;
                // docs:start csharp-human-waits-wait
                var review = await context.WaitForHumanAsync<object, Review>(
                    "account-review",
                    new { accountId, prompt = "Approve this account?" },
                    null);

                if (review.Approved)
                {
                    await ActivateAccountAsync(accountId);
                }
                // docs:end
                return review;
            });
    }

    private Task ActivateAccountAsync(string accountId) => activations(accountId);
}
