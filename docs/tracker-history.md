# Tracker history

Linear is the authoritative tracker for new Workhorse work in the `stablemates` workspace,
with team identifier `SM` and project `workhorse`. This switch starts a fresh backlog;
old tickets are not migrated, and there is no mapping from `WH-*` to `SM-*` identifiers.

Historical commits, decision records, and evaluation reports retain their original issue labels
as context. Those labels do not identify current Linear issues. New work uses `SM-*` identifiers.

Workhorse previously used Plane, then Ontrack. Plane project `workhorse` was frozen at
`2026-08-31T12:16:00.914028Z`. The commit that first added this file marks the repository's
Plane-to-Ontrack boundary. Find it with:

```sh
git log --diff-filter=A --format='%H %cI' -- docs/tracker-history.md
```

Before that boundary, `WH-*` commit subjects refer to Plane work items. After that boundary,
and before the Linear switch, they refer to Ontrack issues. Historical labels remain unchanged;
new issues get their identifiers from Linear.
