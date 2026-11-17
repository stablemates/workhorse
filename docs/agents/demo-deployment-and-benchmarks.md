# Demo, deployment, and benchmark comparisons

This page gives the limits on the demo, the public deployment, and benchmark results. Read it before you work near the demo, a deployment file, a benchmark, or a comparison page.

## Do not run the demo server

Do not start the demo. Not `pnpm demo`, not `pnpm demo:app`, and not a variant in the background.
The dashboard is a data-driven single-page app, so a person with a browser should start it and
assess changes that need visual verification.

A long-lived proxy serves the local demo hostname. If the demo stops, the proxy returns `504
Gateway Timeout` rather than a connection error. Stopping Vite during dependency pre-bundling can
also corrupt `typescript/dashboard/app/node_modules/.vite`; remove that cache and restart the demo
if a running server returns a `504` for a `.vite/deps` chunk.

The demo writes continuously to its database. Run repository commands from the checkout that owns
their data so one checkout cannot change another checkout's test state.

Measuring the demo container is the exception. When an issue asks for its resident set or its CPU
cost, build the image and run it under the limits the deployment gives it. Point it at the
databases of the checkout you work in. Publish it on a port the proxy does not serve, and remove
the container when the measurement ends. Nothing visual comes from that run, so it needs no browser.

## Maintainers own public deployment

Do not run a production setup, deploy, rollback, or container lifecycle command unless a maintainer
explicitly asks for that operation.

Nothing in this repository deploys anything. The live deployment runs from a private operations
repository, and it consumes only `Dockerfile`, `Dockerfile.site`, and what they copy. This
repository once carried parameterized copies of the deployment orchestration, which read as the real
thing and sent work to files that could not affect any deployment; [ADR
0060](../decisions/0060-describe-the-deployment-contract-instead-of-shipping-an-example.md)
deleted them. Do not reintroduce a deploy script, a Kamal configuration, or a `.kamal/` directory
here.

If a change affects the public deployment contract, runtime configuration, image publishing, host
prerequisites, or deployment procedure, update `typescript/demo/DEPLOYMENT.md` in the same commit.

## Keep benchmark comparisons private

Benchmark results stay private until a maintainer decides to publish them. Comparative results
live only in the private operations repository. Never put a benchmark number or a
performance claim about another product in this repository, a commit message, or a pull request.

The name of a compared product can appear only in `site/comparisons.json` and in
`site/content/docs/compare/**`. [ADR 0104](../decisions/0104-publish-sourced-product-comparisons-in-the-docs.md)
records this rule and its exemptions: the decision records, `CHANGELOG.md` files,
`site/content/docs/active-job.mdx`, and `site/content/docs/django.mdx`.
`scripts/comparison-names.test.ts` reads the names from the data file and fails on a name in any
other tracked file. Everywhere else, say "the baseline". A commit message or a pull request that
changes a comparison page can name the products of that page.

A comparison page states qualitative facts only. Each competitor cell has a source URL at a pinned
version, and each Workhorse cell restates `docs/features.md` or `docs/parity.md`. The pages follow
ADR 0051 and use no superlatives.

Perf-lab and other research branches carry those names in their history. Never push them. Rebuild
the finished change on a fresh branch from `main` before opening a pull request.
