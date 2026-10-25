package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import run.workhorse.ConcurrencyPolicyDefinition;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.Worker;

/** The Java tab of the site page "What is Workhorse?". */
public final class OverviewExamples {
  /** The service that creates the workspace of a new account. */
  public interface Workspaces {
    /** Creates the workspace of the account, and returns the workspace. */
    Map<String, @Nullable Object> create(String accountId, String idempotencyKey);
  }

  /** The service that sends the welcome email. */
  public interface Mailer {
    /** Sends the welcome email for the workspace, and returns the result. */
    Map<String, @Nullable Object> welcome(String email, @Nullable Object workspace);
  }

  private final Workspaces workspaces;
  private final Mailer mailer;

  /** The handler of the page uses these services. */
  public OverviewExamples(Workspaces workspaces, Mailer mailer) {
    this.workspaces = workspaces;
    this.mailer = mailer;
  }

  /** Stores the tenant limit, enqueues one onboarding, and registers its handler. */
  public Worker.Builder onboard(
      Queue queue, Worker.Builder builder, String accountId, String email, String tenantId) {
    // docs:start java-overview-onboard
    // Step 1: allow three active onboardings per tenant, across all workers.
    // PostgreSQL applies this limit when a worker claims a task.
    queue.syncConcurrencyPolicies(
        "accounts", List.of(new ConcurrencyPolicyDefinition("onboarding", 20, 3)));

    // Enqueue the task. The tenant is the concurrency key.
    queue.enqueue(
        "account.onboard",
        Map.of("accountId", accountId, "email", email),
        EnqueueOptions.builder().queue("onboarding").concurrencyKey(tenantId).build());

    builder.handle(
        "account.onboard",
        Map.class,
        (context, account) -> {
          String id = String.valueOf(account.get("accountId"));

          // Step 2: create the workspace. The checkpoint stores it.
          // On a later run, it returns the stored workspace, and the handler
          // does not create a second one.
          Object workspace =
              context.checkpoint(
                  "workspace", Object.class, () -> workspaces.create(id, "workspace:" + id));

          // Step 3: wait until the user verifies the email address. The task
          // releases its worker, and it does not count against the tenant limit.
          context.waitForSignal("email-verified", Map.class, null);

          // Step 4: the signal arrived. The handler ran again from its first line,
          // and the "workspace" checkpoint gave back the stored workspace.

          // Step 5: send the welcome email.
          String address = String.valueOf(account.get("email"));
          context.checkpoint("welcome", Object.class, () -> mailer.welcome(address, workspace));
          return workspace;
        });
    // docs:end
    return builder;
  }
}
