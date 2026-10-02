# Approve a registered human decision from Slack

Slack presents a choice. Workhorse retains the decision and controls whether the task can resume.
This is an application recipe, not a Slack backend, framework package, or a guarantee of external delivery.

## Files and processes

`typescript/examples/slack-approvals.ts` implements six separate command modes.
`typescript/examples/slack-approvals.sql` owns the application's schema, `slack_recipe`, not the Workhorse schema.

| Mode              | Responsibility                                                           | Slack credential |
| ----------------- | ------------------------------------------------------------------------ | ---------------- |
| `schema`          | Install the application tables after Workhorse installation              | None             |
| `enqueue`         | Enqueue a demonstration task into `slack-approvals`                      | None             |
| `worker`          | Run the handler, checkpoint its scope, and register `waitForHuman`       | None             |
| `notifier`        | Discover committed waits through `Admin.listHumanWaits` and post buttons | Bot token        |
| `receiver`        | Verify the raw signed request and commit a decision before acknowledging | Signing secret   |
| `decision-worker` | Read the durable inbox and call `completeHumanWait`                      | None             |

Each long-lived mode owns a PostgreSQL pool. The receiver never starts a Workhorse worker or calls Slack.
The notifier and decision worker run independently of the receiver's request lifecycle.

The demonstration handler returns the decision. It performs no external business effect.
An application that acts on approval must independently make those effects replay-safe.

The `slack_recipe.approval` table binds and retains these application fields:

| Fields                                                | Meaning                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `task_id`, `wait_name`, `wait_created_at`, `attempt`  | Original Workhorse wait generation; composite primary key                 |
| `reference`                                           | Unique random button value; replaced after an uncommitted posting failure |
| `team_id`, `app_id`, `channel_id`, `authorized_users` | Trusted authorization snapshot                                            |
| `message_ts`, `expires_at`                            | Message identity and effective wait deadline                              |
| `decision`, `decision_key`, `actor`, `accepted_at`    | First durable choice, unique UUID key, attribution, and receipt time      |
| `settlement`, `settled_at`                            | Actual Workhorse completion status and local settlement time              |

The partial `approval_inbox` index covers accepted decisions without settlement.
There is no foreign key from this receipt to a Workhorse table, so retention cannot silently delete application evidence.

## Configure a disposable application

The maintained proof uses PostgreSQL and mocked Slack APIs. It does not provision a Slack workspace or send live messages.
Run the fixture without Slack credentials:

```bash
pnpm build:runtime:dev
pnpm test:slack-approvals
```

For an explicitly authorized Slack evaluation, create an app in one workspace.
Enable interactivity and set its request URL to an HTTPS ingress forwarding `/slack/actions` to the receiver.
The sample listens on `127.0.0.1:3010`; the ingress must preserve the exact request body and signature headers.
Do not run a JSON parser or reconstruct form data before verification.

Request only the bot OAuth scope `chat:write`. Invite the bot to the chosen channel.
Do not request `chat:write.public`, `chat:write.customize`, history access, or directory access for this recipe.
Obtain workspace, app, channel, and authorized user IDs through the operator's existing access.
The recipe supports workspace installations, not organization-wide installations, ephemeral messages, dialogs, or modals.

Install Workhorse using its normal schema lifecycle before installing the application table.
All modes must address the same application database, with the full-tier queue `slack-approvals`.
Database credentials need only the application's required Workhorse operations and `slack_recipe` access.
Give schema creation privileges to the migration process, not every HTTP replica.

Configure these nonsecret values in each long-lived process:

```text
SLACK_TEAM_ID=T...
SLACK_APP_ID=A...
SLACK_CHANNEL_ID=C...
SLACK_AUTHORIZED_USERS=U...,U...
```

Keep `SLACK_BOT_TOKEN` only in the notifier's secret environment.
Keep `SLACK_SIGNING_SECRET` only in the receiver's secret environment.
Keep database passwords in the secret environment for the processes that need them.
Do not commit secrets, put them in command arguments, or include them in exception reports.
If a local environment file holds secrets, exclude it from version control and restrict its file permissions.

In a configured checkout, use the guarded wrapper from that checkout:

```bash
pnpm exec tsx scripts/with-env.ts tsx --tsconfig tsconfig.source-paths.json typescript/examples/slack-approvals.ts schema
pnpm exec tsx scripts/with-env.ts tsx --tsconfig tsconfig.source-paths.json typescript/examples/slack-approvals.ts enqueue
```

Run each of the following in its own process, only when live evaluation is authorized:

```bash
pnpm exec tsx scripts/with-env.ts tsx --tsconfig tsconfig.source-paths.json typescript/examples/slack-approvals.ts worker
pnpm exec tsx scripts/with-env.ts tsx --tsconfig tsconfig.source-paths.json typescript/examples/slack-approvals.ts notifier
pnpm exec tsx scripts/with-env.ts tsx --tsconfig tsconfig.source-paths.json typescript/examples/slack-approvals.ts receiver
pnpm exec tsx scripts/with-env.ts tsx --tsconfig tsconfig.source-paths.json typescript/examples/slack-approvals.ts decision-worker
```

The wrapper resolves `DATABASE_URL_PRIMARY` from the owning checkout's `.env`.
A linked checkout must first complete `pnpm worktree:setup`; never copy another checkout's database configuration.
Outside this repository, copy the two recipe files into your application. The recipe imports the public SDK from `@stablemates/workhorse`.
Install that published SDK, `pg`, TypeScript, and your normal TypeScript runner.
Supply `DATABASE_URL_PRIMARY` from your application's environment; the repository's wrapper is not an application dependency.

## Registration, posting, and authorization

The handler checkpoints `slack-scope` before registering the named `approval` decision.
The checkpoint preserves its original context if worker configuration changes before replay.
Keep the original handler prompt and wait name stable while outstanding tasks exist.

The notifier discovers only committed records through `Admin.listHumanWaits`.
It checks the exact task type, queue, name, attempt, creation timestamp, workspace, app, channel, and authorization context.
An advisory transaction lock serializes notifier processes for one task and wait.
The notifier posts at most one message per pass, then pauses between passes.
It honors `Retry-After` when Slack returns HTTP 429. Scale this process only with a shared channel-level rate policy.

The notifier generates a new cryptographically random opaque reference for each posting attempt.
After Slack returns the message identity, it persists that reference and identity in one transaction.
The receiver requires the stored workspace, app, channel, message timestamp, expiry, and authorized user to match the signed action.
The `container` must identify the same non-ephemeral message as the payload's channel and message fields.
The receiver also checks its current allowlist, so removing a user prevents new acceptance.
It derives attribution as `slack:<workspace-id>:<user-id>`; it never trusts a client-supplied actor or task ID.

The reference is not sufficient authorization. Treat it as sensitive nonetheless.
Do not put task IDs, authorization policy, signing secrets, or database credentials in button values.

## Durable acknowledgment and settlement

Slack requires HTTP 200 within three seconds of receiving an interactive request.
The receiver uses a 2,500 ms budget from HTTP arrival, including body collection, pool acquisition, and database acceptance.
It limits bodies to 16,384 bytes and verifies HMAC-SHA256 over the unmodified `v0:timestamp:raw-body` bytes.
It rejects request timestamps more than 300 seconds from the receiver's clock. Keep that clock synchronized.
Signature comparison uses equal-length buffers and `timingSafeEqual`.

Acceptance locks the application row with `FOR UPDATE`.
It applies a 100 ms lock timeout and a 350 ms statement timeout, then rechecks the current Workhorse task and wait.
It compares the real wait deadline with PostgreSQL's clock, not merely with the stored reference expiry.
An overdue wait can remain visible until maintenance closes it; visibility alone is not permission to accept it.

The receiver stores the first decision, a UUID decision key, server-derived actor, and acceptance timestamp before `COMMIT`.
It sends HTTP 200 only after commit returns, or for a matching receipt that a previous request already committed.
If acceptance cannot finish within its budget, it sends HTTP 503, never a premature success.
The recipe leaves at least 100 ms before beginning commit. Deployment latency must still be measured.
Its controlled tests prove ordering and bounded failure, not a production latency guarantee.

| HTTP result           | Meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `200`                 | Durable receipt exists for this exact decision and actor; the task is not necessarily approved or resumed |
| `400` / `401` / `403` | Unsupported payload, invalid signature/replay window, or unauthorized binding                             |
| `409`                 | Another accepted actor or decision already won                                                            |
| `410`                 | First acceptance targets an expired, canceled, stale, or already-completed wait                           |
| `413` / `415`         | Body limit or unsupported media type                                                                      |
| `503`                 | Acceptance could not safely acknowledge in time; the commit outcome may be unknown                        |

An acknowledgment lost after commit leaves a durable receipt. A matching manual click can recover that receipt.
Do not assume interactive actions inherit the Events API's retry guarantees.
For an ambiguous failure, check the inbox and task state before asking the human to click again.
Ensure an ingress or framework does not replace the receiver's failures with automatic HTTP 200 responses.

The decision worker reads one unsettled receipt with `FOR UPDATE SKIP LOCKED`.
It binds settlement to the original wait generation and passes the persisted decision key and actor to `completeHumanWait`.
It uses the same PostgreSQL client for Workhorse settlement and its application receipt update.
Both writes commit together. A crash between them rolls back both, leaving the accepted inbox row recoverable.

`completed` and `duplicate` retain the chosen decision. `already_completed` means another Workhorse decision remains authoritative.
`stale`, `not_waiting`, and `not_found` record a closed or unavailable boundary, not successful approval.
Unexpected idempotency conflicts stop that settlement pass and need operator investigation; never regenerate the decision key to conceal one.

## Orphans, races, and retention

If posting succeeds before the reference transaction commits, the visible Slack message can become an orphan.
The next notifier pass can post again with a different reference.
The orphan reference is not in the database, so its clicks cannot authorize a decision.
There is no external exactly-once prompt guarantee, including when a network timeout hides Slack's successful post.
The same window briefly exists while a successful post awaits its local commit; a human may need to click again.

Reconcile orphan messages using the notifier's bot identity and a human-reviewed procedure.
The sample does not automatically list, edit, or delete messages, which would need additional operational policy or scopes.
It does not store Slack's `response_url`, call it, or use `trigger_id`.
Treat response URLs as bearer credentials: they can bypass channel posting permissions.
Do not retain them in payload logs, traces, proxy request captures, exception reports, or analytics.

Cancellation or timeout can win after durable acceptance but before settlement.
The HTTP acknowledgment confirms acceptance, not successful completion of the human decision.
Workhorse owns the final transition, and the decision worker records its actual status.
A different authorized Workhorse operator can also win before this receipt settles.
An application must consult the retained task result before performing a business action.

The handler's decision timeout is 30 minutes. Its reference uses the wait's effective deadline.
Discovery is bounded to ten pages of 100 waits across the database.
If that bound is exceeded, the recipe fails closed rather than silently overlooking authorization or ordering.
Partition discovery before using this recipe at that scale.

The sample has no inbox cleanup daemon, message reconciliation service, application metrics, or automatic delivery confirmation.
Define those policies before production use. Retain unsettled receipts, and retain settled receipts for the required audit period.
Keep inbox data access narrower than ordinary application reads. Message identifiers, authorization lists, and attribution are sensitive.
PostgreSQL persistence assumes your normal durability settings, backups, and recovery procedures; the recipe does not make them optional.

## Maintained proof

`typescript/core/test/integration-slack-approvals.test.ts` uses a scratch database owned by this checkout and the real SDK.
Only external Slack effects are mocked. The fixture proves:

- A registered but uncommitted wait is invisible to the notifier; no post precedes registration commit.
- A separate observer cannot see an inbox decision before commit, and the HTTP response remains pending until commit.
- Controlled commit delay and row-lock contention produce failure before Slack's deadline, not premature HTTP 200.
- Signed raw bodies, replay timestamps, actor authorization, scoped references, duplicate clicks, and competing decisions are checked.
- Expired, canceled, stale, and already-completed boundaries reject first acceptance.
- Posting-before-reference-persistence loss creates an unusable orphan and permits a new prompt, not an exactly-once claim.
- Receiver loss before settlement, and failure after `completeHumanWait` before receipt update, preserve recoverable authority.
- Workhorse's duplicate, already-completed, and stale outcomes remain distinct.

The existing TypeScript database CI lane discovers the fixture once.
`docs/examples-coverage.json` tracks this TypeScript application recipe with explicit exclusions for the other languages.
Local proof is not live Slack compatibility or production acknowledgment-latency evidence.
The packed consumer also compiles the tracked recipe and runs its offline `--verify` mode with the installed SDK.
That mode requires `DATABASE_URL` for a disposable verification database, uses local signed HTTP and a mocked post, and needs no Slack credentials.

## References

- [Slack: handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction/)
- [Slack: verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack: chat.postMessage and scopes](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Workhorse: human decisions](../architecture/lifecycle.md#human-decision-suspension)
