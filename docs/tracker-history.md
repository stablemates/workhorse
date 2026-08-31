# Tracker history

Workhorse used Plane before production Ontrack became its authoritative task system. The commit
that first adds this file is the public repository's tracker boundary; its commit timestamp is the
cutover timestamp. Find it with `git log --diff-filter=A --format='%H %cI' -- docs/tracker-history.md`.

A `WH-*` identifier in a commit subject before that boundary names a Plane work item. The same form
after the boundary names a native Issue in the Ontrack `Workhorse` Project. Git history remains
unchanged, so the repository never guesses which tracker an identifier belongs to without checking
the boundary commit.

Imported Plane work items have new Ontrack keys. Their descriptions contain a `Plane provenance`
section with the original source key and UUID, plus a machine-readable `plane-work-item-id` marker.
Search production Ontrack for that source key or UUID when following an old commit. The private
cutover bundle in `workhorse-operations` retains the exact source-to-destination mapping and
canonical snapshot evidence.
