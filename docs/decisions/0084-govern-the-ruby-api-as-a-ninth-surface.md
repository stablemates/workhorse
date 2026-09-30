# ADR 0084: Govern the Ruby API as a ninth surface

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md),
  [ADR 0059](0059-assemble-the-1-0-0-specification.md)
- **Related:** [ADR 0075](0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md),
  [ADR 0079](0079-govern-the-rust-api-as-an-eighth-surface.md),
  SM-904,
  SM-903,
  SM-896

## Context

ADR 0075 adds Ruby as the fifth SDK. It ships one gem, `stablemates-workhorse`, with an Active Job
adapter, and it promises that SM-904 records the gem's public surface before 1.0.0.

ADR 0054 governs eight surfaces since ADR 0079 added the Rust API. ADR 0059 assembles the
specification from that list, and ADR 0056 holds the tag until each surface has a mechanical check.
None of the three mentions Ruby. A gem that ships at 1.0.0 without a governed API would carry a
version number that promises nothing.

Ruby has no compiler to tell a caller that a name is gone. Visibility is also split across two
mechanisms. `private_constant` and `private` hide a name from a caller at run time. A module that
an SDK file outside its namespace reaches by full path cannot use them. The gem marks such a module
`:nodoc:` instead, the convention RDoc and YARD already read. Reflection sees only the first
mechanism.

## Decision

### The Ruby API is the ninth governed surface

**9. The Ruby API.** A breaking change is one that makes caller code that ran against the previous
release raise or behave differently. The surface is every public constant under
`Stablemates::Workhorse`, with each module's superclass, included modules, `Data` members, and the
public method signatures, keywords included. It also covers the Active Job adapter,
`ActiveJob::QueueAdapters::StablematesWorkhorseAdapter`, and `workhorse_options`, which a job class
calls. It is the same rule ADR 0054 applies to the other language APIs.

A name is internal when `private_constant` or `private` hides it, or when its definition line
carries `:nodoc:`. A `:nodoc:` module takes everything under it out of the surface. `Suspension`,
`Values`, `SqlCatalogue`, and the worker's heartbeat and listener are internal this way.

Removing or renaming a constant, method, keyword, or `Data` member is breaking. So is narrowing a
signature, such as making an optional keyword required or dropping a default. Adding any of them is
not. The value of `VERSION` is not part of the promise, because it changes on every release.

### `ruby-api:check` enforces it against `api/ruby.txt`

`pnpm ruby-api:generate` loads the gem on the pinned Ruby and runs `ruby/tools/api_snapshot.rb`.
The tool walks the two namespaces by reflection, which alone knows what `private_constant` hid. It
reads the source with Prism for the two facts reflection cannot give: the `:nodoc:` markers, and
each parameter list as written. `Method#parameters` drops default values, so a changed default
would otherwise pass unseen.

A keyword reaches the snapshot only through a line that names it. A public method therefore names
the keywords it accepts, unless it takes `**` and forwards them. Such a method's line names the
source of its keywords, which has lines of its own: `Queue#enqueue` forwards to
`EnqueueRequest#initialize`, and `workhorse_options` accepts `ActiveJob::OPTION_KEYS`. The tool stops
on a public `**` without a named source.

`pnpm ruby-api:check` runs in the CI `static` job, which feeds `required`, and in `pnpm check`. It
fails on any drift, like `rust-api:check`. A gone line is a removal, a rename, or a narrowing, and
the failure labels it breaking. An arrived line is an addition, and the fix is one regeneration.

This adds a row to Gate 1 of ADR 0056: the Ruby API, checked by `ruby-api:check` against a
committed snapshot of every public constant and method signature.

### The Ruby clock starts where the snapshot lands

Gate 2 needs six weeks and two published 0.x minors after the last non-additive change to a
governed surface. The Ruby API had no snapshot before SM-904, so before that commit nothing records
whether a Ruby change was additive.

The Ruby clock therefore starts at the later of two commits: the merge of SM-904, which first lands
`api/ruby.txt`, and the last merge that removes a line from it. Both counted minors must publish the
gem to RubyGems from a commit at or after that start. ADR 0075 makes 0.6.0 the gem's first release,
so the earliest qualifying pair is 0.6.0 and 0.7.0. Both must publish the gem before 1.0.0.

The Ruby clock runs beside the others and does not replace them. The tag needs every clock to have
run out.

### The cold install covers Ruby

Gate 3 of ADR 0056 needs a fresh host to install the candidate from the published registries. That
gate now covers five languages. The fresh host also installs `stablemates-workhorse` from RubyGems,
following only the site's installation page, and runs a job end to end.

### The gem rides the train and floats afterwards

The gem joins the one 1.0.0 release train of ADR 0054. It publishes 1.0.0 from the same source
commit as the npm packages, the Python distribution, the Go module, and the Rust crate. SM-903 adds
the publishing job. After 1.0.0 its version line floats independently, like the other four.

## Consequences

- Gate 1 has nine checks, and the Ruby API holds its one before 1.0.0.
- Gate 2 cannot close before 0.7.0 publishes the gem.
- Gate 3's cold install needs a Ruby job to run on the fresh host.
- A change to the gem's public surface updates `api/ruby.txt` in the same commit. Review reads a
  gone line as a break.
- Marking a public constant `:nodoc:` removes its lines, so the check reports it as a break.
- The snapshot lists methods a module defines, not the ones it inherits from Ruby or `Data`. Each
  follows from a superclass or an included module the snapshot already names.

## Alternatives considered

- **Diff against the published gem.** No gem is published yet, and a registry download on every
  check adds a network dependency. A committed snapshot needs neither, and a reviewer reads it in
  the diff.
- **Generate the snapshot from RBS or YARD.** Either one reads annotations beside the code, which can
  drift from what the gem loads. Reflection reads the loaded gem itself.
- **Hide every internal module with `private_constant`.** That would leave one visibility mechanism.
  But `private_constant` refuses a qualified path, and the Active Job adapter lives outside the
  namespace and reaches `SqlCatalogue` by its full path.
