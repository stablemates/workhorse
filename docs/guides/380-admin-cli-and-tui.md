# Admin CLI and TUI: operating a queue from the terminal

The dashboard is not always where you are. Sometimes you are in a shell on a bastion host, or
writing a runbook script, and you still need to see what a queue is doing — or stop it.

`workhorse admin` and `workhorse tui` are that surface. One is for scripts and one-off commands;
the other is a live terminal view. Both are the same client underneath, with the same safety
checks, so nothing you learn in one is wrong in the other.

## Looking around is always safe

The inspection commands — `admin jobs`, `admin job`, `admin timeline`, `admin checkpoints`,
`admin waits`, `admin external-waits`, `admin failures`, `admin queues`, `admin schedules`,
`admin workers`, `admin maintenance` — only read. You can run
them against production without ceremony, the same way you would run `queue.health` from code.

Each command answers in two registers. By default you get an aligned table meant for a human
squinting at a terminal. With `--json` you get the machine-readable result, which is the same
object the TypeScript operator API returns — so a script that parses it is reading the documented
shape, not a private CLI format.

```sh
workhorse admin failures --queue billing --json | jq '.items[].jobId'
```

## Finding out what a stalled job is waiting on

A durable handler can stop for a good reason. It saved a checkpoint and is between steps, or it
is sleeping on a timer, or it is waiting for a person or an outside system to answer. From the
outside all four look the same: a job that is not finishing.

Three reads separate them. `admin checkpoints <job-id>` shows the restart boundaries a handler
already got past, so you can see how far it got before it stopped. `admin waits <job-id>` shows
its durable timer waits and when each one wakes. Both take `--name` when you already know which
one you want.

`admin external-waits` asks the fleet-wide version of the question: which jobs are waiting on
someone. It lists the pending human decisions and the pending signal waits together, oldest
first, because the oldest boundary is usually the one closest to running out of time. A human
decision carries the context its handler recorded, which is what the person deciding was meant
to read.

```sh
workhorse admin external-waits --json | jq '.human.items[] | {jobId, name, context}'
```

Long lists page. Each `--json` answer carries the continuation for its own list, and you hand
that object back on the next call. This is the same paging the dashboard does, so both surfaces
walk a busy queue's waits the same way.

Answering a decision is not here. These commands only read; [human
decisions](145-human-decisions.md) explains where a completion comes from and why it is
attributed.

## Changing things requires naming the target twice

The guarded commands — `admin cancel`, `admin redrive`, `admin pause`, `admin resume`,
`admin purge`, `admin pause-worker`, `admin resume-worker` — mutate a live system. The most common
way to hurt yourself with an operator CLI is not a typo in the command. It is running the right
command against the wrong database, because a shell still carried the environment of whatever you
were doing an hour ago.

So a guarded command demands that you name the target explicitly. `--env` must state the
database's own name, and the client checks that claim against the database it actually reached.
If they disagree, nothing happens and the command tells you what it refused and why. There is no
flag that skips this check.

Confirmation is the second, separate gate. Interactively, you retype the job id, queue name, or
worker id you are about to affect. In a script, you pass `--yes` — the script author, not a
default, decides the command may proceed unattended.

```sh
workhorse admin redrive 7d9f… --env workhorse_production --reason "upstream fixed" --yes
```

A redrive always records who asked and why, and carries an idempotency identity, so retrying a
runbook step cannot replay a job twice. That is the same contract as [redrive](340-redrive.md)
through the public `Admin` client — the CLI adds no separate semantics. Queue pause and resume
also require a reason and retain the request's audit identity.

`admin purge` is the one that empties a queue, and it deletes rather than cancels: it takes out
that queue's waiting jobs and leaves the ones a worker is already running. Reach for it when a
backlog is poison and draining it by hand is not worth the incident. It carries the same
idempotency identity as a redrive, so a retried runbook step re-reports the first purge instead of
taking a second bite; reusing that identity with different audit fields is refused. The command
answers with how many jobs it removed.

## Taking one worker out of rotation

Sometimes the queue is fine and one worker is not — a bad host, a leaking process, a deploy that
went out to one box first. `admin pause-worker` stops that worker claiming, and
`admin resume-worker` lets it claim again. Both need a reason, and both name a worker id you can
read out of `admin workers`, which also shows who paused each one.

The pause lives in the fleet registry, so it is not a message shouted at a process that happens to
be listening. A worker finds out on its next registration, and until then anyone reading
`admin workers` can already see the decision. That also sets the limit of what the command can do:
[workers](310-workers.md) explains what an operator pause survives and what it does not.

## The TUI is the same client with a refresh loop

`workhorse tui` shows jobs, queues, schedules, failures, workers, and health as switchable views
that refresh themselves. It is the "what is happening right now" tool: watch a backlog drain,
watch workers come back after a deploy, see a failure count stop growing.

By default the TUI is read-only, and says so in its title bar. Launch it with `--env` — the same
explicit target check as the CLI — and the queues view gains one carefully fenced action: pause
or resume the selected queue, and even then only after an explicit confirmation keystroke.
Pausing a queue is durable, in contrast to pausing a worker; [workers](310-workers.md) explains
that difference.

## What this is not

The terminal surface deliberately stays inside the operator APIs. It adds no authorization —
attribution is recorded, never checked, exactly as everywhere else in Workhorse — so access to a
guarded command is access to the database URL. If you need logins, roles, and an audit trail with
teeth, that is the [dashboard](370-dashboard-authentication.md)'s territory.

## Next

- [340-redrive.md](340-redrive.md) — what a redrive actually creates
- [145-human-decisions.md](145-human-decisions.md) — how a decision boundary is answered
- [360-queue-health.md](360-queue-health.md) — the health view's underlying snapshot

---

Exact commands, flags, guard mechanics, and exit codes:
[`architecture.md`](../architecture.md#administrative-cli-and-tui).
