# Tracker history

Historical commits, decision records, and evaluation reports keep their original issue labels as
context. New commits do not need an issue label.

`SM-*` labels refer to issues in the Linear `stablemates` workspace. Linear started a fresh
backlog: it did not migrate old tickets, and no mapping from `WH-*` to `SM-*` labels exists.

Workhorse previously used Plane, then Ontrack. Plane project `workhorse` was frozen at
`2026-08-31T12:16:00.914028Z`. The commit that first added this file marks the repository's
Plane-to-Ontrack boundary. Find it with:

```sh
git log --diff-filter=A --format='%H %cI' -- docs/tracker-history.md
```

Before that boundary, `WH-*` commit subjects refer to Plane work items. After that boundary,
and before the Linear switch, they refer to Ontrack issues. Historical labels remain unchanged.
