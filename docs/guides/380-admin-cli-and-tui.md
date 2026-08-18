# Admin CLI and TUI: operating a queue from the terminal

The dashboard is not always where you are. Sometimes you are in a shell on a bastion host, or
writing a runbook script, and you still need to see what a queue is doing — or stop it.

`workhorse admin` and `workhorse tui` are that surface. One is for scripts and one-off commands;
the other is a live terminal view. Both are the same client underneath, with the same safety
checks, so nothing you learn in one is wrong in the other.

## Looking around is always safe

The inspection commands — `admin jobs`, `admin job`, `admin timeline`, `admin failures`,
`admin queues`, `admin schedules`, `admin workers`, `admin maintenance` — only read. You can run
them against production without ceremony, the same way you would run `queue.health` from code.

Each command answers in two registers. By default you get an aligned table meant for a human
squinting at a terminal. With `--json` you get the machine-readable result, which is the same
object the TypeScript operator API returns — so a script that parses it is reading the documented
shape, not a private CLI format.

```sh
workhorse admin failures --queue billing --json | jq '.items[].jobId'
```

## Changing things requires naming the target twice

The guarded commands — `admin cancel`, `admin redrive`, `admin pause`, `admin resume` — mutate a
live system, and the most common way to hurt yourself with an operator CLI is not a typo in the
command. It is running the right command against the wrong database, because a shell still
carried the environment of whatever you were doing an hour ago.

So a guarded command demands that you name the target explicitly. `--env` must state the
database's own name, and the client checks that claim against the database it actually reached.
If they disagree, nothing happens and the command tells you what it refused and why. There is no
flag that skips this check.

Confirmation is the second, separate gate. Interactively, you retype the job id or queue name you
are about to affect. In a script, you pass `--yes` — the script author, not a default, decides
the command may proceed unattended.

```sh
workhorse admin redrive 7d9f… --env workhorse_production --reason "upstream fixed" --yes
```

A redrive always records who asked and why, and carries an idempotency identity, so retrying a
runbook step cannot replay a job twice. That is the same contract as [redrive](340-redrive.md)
from code — the CLI adds no separate semantics.

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
- [360-queue-health.md](360-queue-health.md) — the health view's underlying snapshot
- [310-workers.md](310-workers.md) — worker pause versus queue pause

---

Exact commands, flags, guard mechanics, and exit codes:
[`architecture.md`](../architecture.md#administrative-cli-and-tui).
