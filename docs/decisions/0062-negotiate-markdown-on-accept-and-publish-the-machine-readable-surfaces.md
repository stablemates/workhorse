# ADR 0062: Negotiate Markdown on `Accept` and publish the machine-readable surfaces

- **Status:** Accepted
- **Date:** 2026-09-05
- **Related:** [ADR 0049](0049-publish-one-agent-documentation-layer.md),
  [ADR 0023](0023-language-sdks-and-http-boundaries.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0060](0060-describe-the-deployment-contract-instead-of-shipping-an-example.md),
  WH-665,
  WH-666
- **Amends:** the ADR 0049 clauses "a canonical HTML URL does not negotiate on `Accept`" and
  "nothing in the repository runs the site's nginx"

## Context

ADR 0049 gave every page a Markdown twin and told an agent to append `.md`. The twin is the form an
agent reads, and the `alternate` link in each page's head names it. WH-665 measured what that
mechanism does: four recorded sessions after the landing twin shipped, and not one fetched it. A
session is handed a URL and fetches it, and by the time it can read the `alternate` link it has
paid for the page the link sits in. The twin was correct and unused, and WH-665 listed the ways
out, of which only one changes what the first fetch returns: negotiating on `Accept`.

The agents that fetch documentation now say what they want. Claude Code, Copilot, Cursor, OpenCode
and others send `Accept: text/markdown` first, at full quality, before `text/html` and `*/*`. A
browser never sends it. The acceptmarkdown.com convention states the contract: serve Markdown when
the header names it, send `Vary: Accept` so a cache keeps the two representations apart, honour
`q=0`, and answer 406 only when nothing the client accepts exists.

An audit of the site against an agent-readiness model found the rest of the gap. A missing URL
answered with nginx's stock HTML page, which tells an agent nothing about where to look. No
OpenAPI document described the one HTTP API the product has. `llms.txt` listed every page and said
nothing about when Workhorse is the right tool or how to call it from a shell. The site had no
About, Contact, or Privacy page and no `Organization` record, which are what an agent checks before
it recommends a publisher.

`site/nginx.conf` is the site image's whole runtime, and ADR 0060 calls it behaviour this
repository owns and tests, yet nothing in the repository ran it. The Markdown type was proved
against the file's text and never against a served response.

## Decision

**The origin negotiates on `Accept`.** A page URL answers `Accept: text/markdown` with the page's
Markdown twin as `text/markdown; charset=utf-8`, and answers a browser, a missing header, or
`*/*` with HTML. Every negotiated response carries `Vary: Accept`. `text/markdown;q=0` is a
rejection and selects HTML. A page with no twin answers a client that accepts only Markdown with
`406 Not Acceptable` and a `text/plain` body naming the representation that exists; a client that
also accepts HTML gets the page. Files named with an extension, `/assets/`, and `/up` are one
representation each and never vary.

The negotiation is a substring match in an nginx `map`, not a full q-value ordering.
`text/html, text/markdown;q=0.1` still selects Markdown. Every agent in the support matrix puts
`text/markdown` first at full quality, browsers never send it, and the one ordering that matters,
an explicit `q=0`, is honoured. The file states the caveat where the rule lives.

**A 404 carries a body in the representation the client asked for, and keeps its status.** A
browser gets the site's own not-found page, prerendered as a real route at `/not-found` because
the prerenderer refuses a page that answers anything but 2xx. An agent asking for Markdown gets
`/404.md`, which names the index, the entry point, the one-file download, the sitemap, and the
`.md` rule. A client asking for JSON, and every request under `/api/`, gets `/404.json`, whose
shape is the error shape the OpenAPI document declares. The bodies are generated from the same
page records as `llms.txt`, and the files that exist only to be served this way are `internal`, so
a direct request cannot turn a not-found body into a page that a crawler indexes.

**`dashboard/v1` publishes an OpenAPI 3.1 document.** `pnpm dashboard-spec:generate` composes
`dashboard/v1/openapi.json` from `manifest.json`, `procedures.json`, and `conformance.json`, so
the document cannot drift from the contract, and `pnpm dashboard-spec:check` covers it. Every
operation has a unique `operationId`, a description, typed request and response schemas, the
shared error responses, and examples lifted from the conformance fixtures. The site copies the
tracked file to `/openapi.json`. The document's own description says what ADR 0023 and ADR 0054
say together: the API is served by the reader's own deployment and never by workhorse.run, SQL is
the primary protocol, the surface is an operator surface and not an application ingress, and the
contract is versioned in its path. Publishing a description of a governed contract changes
neither decision.

**`llms.txt` says when to use Workhorse and how to call it.** Three sections join the router:
the jobs Workhorse is right for and the properties that disqualify it, drawn from the playbook's
own list; the command line, listed from `CLI_COMMANDS` so a command cannot ship unlisted; and the
machine-readable files with the negotiation rule. The trust pages are never listed there, because
an agent integrating the product has no need of them.

**The site carries About, Contact, and Privacy pages and names its publisher.** The three are a
`pages` collection with the blog's shape, each with a twin, a sitemap entry, and a footer link.
Every page emits one `Organization` record for Stablemates with the registries it publishes to
and a contact point that names the contact page. The record carries no email address and no
postal address, because neither exists; the site never invents a fact, and adding one is two
fields in `site/lib/site.ts`.

**The repository runs the site's nginx.** `pnpm test:site-nginx` serves the built site through
the system nginx with `site/nginx.conf` as a `conf.d` include, the way the image does, and asserts
the negotiation vectors, the 404 bodies, the 406, and the `Vary` header against served responses.
Without nginx on the machine it skips and says so. It runs on demand, like the site smoke, and the
text assertions on the file stay as the check that runs everywhere.

## Consequences

An agent that sends `Accept: text/markdown` reads the twin on its first fetch. That is what WH-665
asked to be named: the thing expected to fetch the twin, and why it will find it. A later eval run
records whether the landing page's fetch cost moved.

Any cache in front of the origin must honour `Vary`. Cloudflare does by default and marks these
responses dynamic; `typescript/demo/DEPLOYMENT.md` states the requirement, and a deploy that
changes negotiation purges the cache.

A page with no twin and a Markdown-only client meet a 406 rather than a silent HTML fallback.
Today that is only the blog index, and only for a client that sends no `*/*`.

The OpenAPI document depends on the conformance fixtures, so regenerating fixtures stales it;
`dashboard/v1/README.md` states the order. The organization record stays partial until an email
and an address exist, and search indexing of the brand stays outside the repository.
