# ADR 0100: Make the root README a product overview

- **Status:** Accepted
- **Date:** 2026-10-13
- **Supersedes:** The root README part of [ADR 0046](0046-make-readmes-entry-points.md). Its
  published package README contract stays accepted.
- **Issue:** SM-1287

## Context

ADR 0046 gave the root README a first-run path. The README installed the TypeScript package and its
schema, ran one task, and listed the published packages. Tests held those sections in place.

Since then, the product has five SDKs at parity. The root README showed the first task in
TypeScript only. It also had Ruby install lines, because SM-905 added them, but it had no install
lines for Python, Go, or Rust. Thus the README gave one language a full path, one language a
partial path, and three languages none.

The site quickstart and each SDK README already show a first task, in each language. The package
list repeated the SDK READMEs and the site, and it put internal package boundaries on the first
page that a new reader sees.

## Decision

The root README is a product overview. It says what Workhorse is, why PostgreSQL ownership is
important, and when Workhorse fits. It shows one overview diagram and one dashboard screenshot.
Then it sends the reader to the documentation, the quickstart, and the live demo.

The root README has no install commands, no first task, and no package list. The quickstart on
the site and the README of each SDK own the first task and the install commands.

Each image in the README has a light and a dark version, and a narrow version for screens up to
600 px wide. `pnpm diagrams:generate` makes the diagram images from `scripts/`, so a later change
can edit the diagram and generate it again.

## Consequences

- A reader who wants to install Workhorse follows the Quickstart link at the top of the README, or
  opens the README of an SDK.
- The README tests no longer require a TypeScript example, the supported-version sentence, or install
  commands in the root README. The TypeScript core README keeps those requirements.
- The root README still points an agent at `https://workhorse.run/llms.txt` exactly once.
- The README is shorter than the limit of about 200 lines that ADR 0046 set.
