namespace Workhorse.Examples.Overview;

/// <summary>The payload of the <c>account.onboard</c> task.</summary>
public sealed record AccountPayload(string AccountId, string Email);

/// <summary>The workspace of a new account.</summary>
public sealed record Workspace(string Id, string Url);

/// <summary>The result of the welcome email.</summary>
public sealed record WelcomeResult(bool Sent);

/// <summary>The service that creates the workspace of a new account.</summary>
public interface IWorkspaces
{
    Task<Workspace> CreateAsync(string accountId, string idempotencyKey, CancellationToken cancellationToken);
}

/// <summary>The service that sends the welcome email.</summary>
public interface IMailer
{
    Task<WelcomeResult> WelcomeAsync(string email, Workspace workspace, CancellationToken cancellationToken);
}

/// <summary>The C# tab of the site page "What is Workhorse?".</summary>
public sealed class OverviewExamples(IWorkspaces workspaces, IMailer mailer)
{
    /// <summary>Stores the tenant limit, enqueues one onboarding, and registers its handler.</summary>
    public async Task OnboardAsync(Queue queue, Worker worker, string accountId, string email, string tenantId)
    {
        ArgumentNullException.ThrowIfNull(queue);
        ArgumentNullException.ThrowIfNull(worker);
        // docs:start csharp-overview-onboard
        // Step 1: allow three active onboardings per tenant, across all workers.
        // PostgreSQL applies this limit when a worker claims a task.
        await queue.SyncConcurrencyPoliciesAsync(
            "accounts",
            [new ConcurrencyPolicyDefinition { Queue = "onboarding", MaxActive = 20, MaxActivePerKey = 3 }]);

        // Enqueue the task. The tenant is the concurrency key.
        await queue.EnqueueAsync(
            "account.onboard",
            new AccountPayload(accountId, email),
            new EnqueueOptions { Queue = "onboarding", ConcurrencyKey = tenantId });

        worker.Handle<AccountPayload, Workspace>(
            "account.onboard",
            async (context, account) =>
            {
                // Step 2: create the workspace. The checkpoint stores it.
                // On a later run, it returns the stored workspace, and the handler
                // does not create a second one.
                var workspace = await context.CheckpointAsync(
                    "workspace",
                    ct => workspaces.CreateAsync(account.AccountId, $"workspace:{account.AccountId}", ct));

                // Step 3: wait until the user verifies the email address. The task
                // releases its worker, and it does not count against the tenant limit.
                await context.WaitForSignalAsync<object>("email-verified", null);

                // Step 4: the signal arrived. The handler ran again from its first line,
                // and the "workspace" checkpoint gave back the stored workspace.

                // Step 5: send the welcome email.
                await context.CheckpointAsync("welcome", ct => mailer.WelcomeAsync(account.Email, workspace, ct));
                return workspace;
            });
        // docs:end
    }
}
