# ADR 0061: Record the agent documentation eval through the Claude CLI

- **Status:** Accepted
- **Date:** 2026-09-05
- **Related:** [ADR 0049](0049-publish-one-agent-documentation-layer.md),
  [ADR 0043](0043-public-ci-and-release-policy.md),
  [WH-659](https://ontrack.sh/projects/WH/issues/WH-659),
  [WH-540](https://ontrack.sh/projects/WH/issues/WH-540)
- **Amends:** the ADR 0049 clause "`record` produces a session and needs a model key"

## Context

ADR 0049 made the eval the agent documentation layer's only real proof. The other assertions in
that layer prove that pointers exist and agree; only a recorded session proves that an agent
arrives. `record` as built on WH-539 calls the Messages API and needs an Anthropic API key.

The maintainer has no key and will not have one. The recorder could therefore never run, which left
WH-540 permanently unreachable and the layer permanently unproven. The `claude` CLI authenticates
from the maintainer's own login, so it can record what the key cannot.

The CLI is not a neutral substitute. It is itself a documentation-reading harness: it carries its
own system prompt, its own web and file tools, the maintainer's MCP servers, and the project's
`CLAUDE.md` and settings. If any of those reach the session, the run measures Claude Code rather
than the published site, and the fixture stops being evidence.

Two behaviours were observed rather than assumed. The CLI refuses `bypassPermissions` in restricted
mode, so the allow-list has to carry the approval. The CLI also truncates a large tool result,
writes the remainder to a file, and names that path to the model. On the first recorded probe the
session tried to read that path back through the eval's own fetch tool. That cost a fetch and moved
the discovery index from 3 to 4, against a pass bar of at most 3.

## Decision

**`record` drives the `claude` CLI and no API key.** It removes `ANTHROPIC_API_KEY` from the
child's environment rather than trusting it to be absent, so an inherited key cannot bill another
account or run another model.

**The harness still performs every fetch.** The session's one tool is `fetch_url`, served by a
stdio MCP server in `scripts/agent-eval/fetch-server.ts` that calls `fetch` and appends one record
per fetch. Handing the session a built-in web tool would lose the status, content type and byte
count that three scored dimensions read.

**The session is isolated by a fixed option set, and a test asserts the whole set.** The system
prompt is replaced rather than appended to, the dynamic sections are excluded, only the eval's MCP
server is loaded, the project and local settings are dropped, `fetch_url` is the one allowed tool,
every built-in tool that could reach a document is denied, and the session runs in a scratch
directory outside the checkout. The working directory is the part no flag can do: a `CLAUDE.md` at
or above it would reach the session whatever the flags say.

**`fetch_url` serves `http` and `https` only.** It refuses any other scheme, and that refusal
neither spends the budget nor enters the transcript. A spilled tool result is a harness artifact,
not a documentation fetch, and counting one shifts every later fetch's position. The discovery
index is a position.

**The budget stays a count of fetches, enforced in the tool.** The CLI has no turn limit, and a
fetch is what the budget has always counted.

## Consequences

Recording still runs on demand and in no CI lane. ADR 0043's reasoning is unchanged: a login is a
credential like any other, and a frozen fixture's score cannot go red.

The 2026-09-01 baseline stays comparable in task and prompt, which are frozen, and not in harness.
It was reconstructed from hand-run sessions whose model was never recorded, so a recorded run
already had to set the reference for every later run. Each fixture names the model it ran.

A page past the CLI's result ceiling still reaches the session truncated. The tool asks for the
500,000-character maximum and `record` raises `MAX_MCP_OUTPUT_TOKENS`, but the landing page is
larger than that, so a dated note states the cut alongside its numbers.

`@anthropic-ai/sdk` is no longer a dependency of this repository.
