# Contributing

Workhorse is licensed under the Apache License, Version 2.0. See `LICENSE` and
`NOTICE`.

## Contributor agreement

The first pull request from a person or company must include the signature block
from `CLA.md`. Stablemates will not merge copyrightable Contributions without it.
The agreement assigns copyrightable Contributions to Stablemates and licenses them
back to you under Apache-2.0, so the core stays ownable.

## Generative tooling

You may use an assistant to draft a patch. You still review every line before you
submit, and you still sign `CLA.md`. If the tool’s terms would block Apache-2.0
publication, do not submit the output.

When a model produced a substantial part of the patch, end the commit message
with one `Co-Authored-By:` trailer per model, naming the exact model ID, for
example `Co-Authored-By: claude-fable-5-1 <noreply@anthropic.com>`. That is the
same trailer `AGENTS.md` asks of an agent's own commits. It does not replace the
review or the agreement.

Do not include third-party code the tool copied unless you can license it here.
Disclose that material in the pull request if it remains.

## Outbound licence

Do not add a Contribution under a different outbound licence. Apache License
section 5 already treats an unmarked submission as Apache-2.0; `CLA.md` is the
separate agreement on top of that.
