# Committed public API snapshots

Each file here records one governed surface as it stands on this commit. A pull request
that removes a name, renames one, or narrows a type changes a file here, so the change is visible in
review and the check names it. [ADR 0054](../docs/decisions/0054-define-what-1-0-0-promises.md)
[ADR 0079](../docs/decisions/0079-govern-the-rust-api-as-an-eighth-surface.md),
[ADR 0084](../docs/decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md),
[ADR 0103](../docs/decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md), and
[ADR 0107](../docs/decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)
define the surfaces, and Gate 1 of
[ADR 0056](../docs/decisions/0056-set-the-1-0-0-exit-criteria.md) requires the checks.

| File             | Surface                                                                                                     | Check                          | Generator                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------- |
| `typescript.txt` | Every published package's `exports` map and shipped `.d.ts`                                                 | `pnpm typescript-api:check`    | `pnpm typescript-api:generate`    |
| `python.txt`     | Every public `workhorse` module's `__all__`                                                                 | `pnpm python-api:check`        | `pnpm python-api:generate`        |
| `go.txt`         | Exported identifiers of the Go module's non-`internal` packages                                             | `pnpm go-api:check`            | `pnpm go-api:generate`            |
| `rust.txt`       | Every public item of the `workhorse` crate, per feature                                                     | `pnpm rust-api:check`          | `pnpm rust-api:generate`          |
| `ruby.txt`       | Every public constant under `Stablemates::Workhorse` and the Active Job adapter, less `:nodoc:`             | `pnpm ruby-api:check`          | `pnpm ruby-api:generate`          |
| `java.txt`       | Every public and protected Java declaration of `workhorse` and the starter, and each `workhorse.*` property | `pnpm java-api:check`          | `pnpm java-api:generate`          |
| `kotlin.txt`     | Every public Kotlin declaration of `workhorse-kotlin`, with its default arguments                           | `pnpm kotlin-api:check`        | `pnpm kotlin-api:generate`        |
| `dotnet.txt`     | Every public and protected C# type and member of the four .NET packages, and each `Workhorse:*` key         | `pnpm dotnet-api:check`        | `pnpm dotnet-api:generate`        |
| `cli.txt`        | The `workhorse` commands, flags, exit codes, and `--json` payloads                                          | `pnpm cli-surface:check`       | `pnpm cli-surface:generate`       |
| `telemetry.txt`  | Every instrument, span, and attribute name Workhorse emits                                                  | `pnpm telemetry-surface:check` | `pnpm telemetry-surface:generate` |

These are generated artifacts. Do not edit one by hand: run its generator and commit what it wrote.

Two more surfaces keep their promise files beside their own artifacts, because their checks
classify a change instead of comparing text. "The promise files of the SQL and dashboard surfaces"
below describes them.

## Reading a failure

The check prints the lines that went and the lines that arrived. A line that went is the interesting
half, because a removal, a rename, and a narrowing all read as a line disappearing. A line that only
arrived is an addition, which is not breaking, and running the generator is the whole fix.

Two checks label some lines in their own way. `java.txt` lists a record that only gained last
components as additive, not as gone. `dotnet.txt` lists some arrived lines as breaking under ADR
0107, and "How the C# file reads the assemblies" names them. Regenerating the file does not make
such a change safe.

## Why the Go file has a different shape

`typescript.txt` and `python.txt` describe the surface. `go.txt` describes the accepted **breaks**
in it, because Go's standard for a break is what `apidiff` reports and `apidiff` compares two
module versions rather than reading a description. So the file pins the published tag the comparison
starts from and lists every incompatible change accepted since it. While the line is `0.x` a minor
may break, so an accepted list is what honesty looks like; a break that is not listed fails the
check. Publishing a `go/vX.Y.Z` tag and running the generator re-pins the baseline and empties the
list.

The baseline is pinned as data rather than looked up because CI checks out without tags. The
generator is the only half that reads Git, and it refuses to write a file with no baseline: a
comparison against nothing would pass every removal silently, which is what these checks exist to
prevent.

## How the Python file reads the package

`python.txt` imports each public module and prints each name in its `__all__`. A class has a line
for each method, property, and annotated attribute, its own and inherited.

An attribute that a `workhorse` `__init__` assigns on `self` has a line too, because a caller reads
`error.code` the same way as a method. Such a line ends with `# set by __init__`. An attribute that
the class declares already has a line, so it gets no second one.

The tool reads the `__init__` that construction runs, in the order that it runs. A call to
`super().__init__` or `Base.__init__(self, ...)` runs that base `__init__` at the place of the call.
A base `__init__` that the chain does not call gives no line, because its assignments never run.
The tool reads only the statements of each `__init__` body. An attribute that a nested function or
another method assigns has no line, and neither has an attribute that a base class outside
`workhorse` assigns.

The type of an attribute is the type of the last assignment that always runs. An assignment inside
a branch, a loop, or a handler can run or not, so its type is added to the line, such as
`int | str`. The type of one assignment comes from its annotation, from the annotation of the
parameter that it copies, from a builtin conversion such as `str(...)`, from the type argument of
`typing.cast`, or from a literal. If none of these gives a type, the line shows `<unannotated>`.
Then the check sees a removed or renamed attribute, but not a retyped one.

## How the Rust file handles features

A Cargo feature can put a public item into the build, so no single build shows the whole surface.
`rust.txt` lists the crate's feature names first, then every item of a build with no features, then
one section per feature. Each line in a feature's section is an item that feature adds, prefixed with
its `#[cfg(feature = "…")]`. Moving an existing item behind a feature therefore changes its line, and
the check reports the old line as gone. A feature that adds no item says so in one line.

The generator reads rustdoc JSON through `rust/tools/api-snapshot` on the pinned toolchain. Blanket
impls are left out, because each follows from a bound the file already lists. Auto-trait impls stay
in, because a type that stops being `Send` breaks callers without any signature changing.

## How the Ruby file reads the gem

Ruby hides a name in two ways. `private_constant` and `private` hide it at run time, and a `:nodoc:`
marker on its definition line hides it by convention. `ruby.txt` honours both. The generator loads
the gem on the pinned Ruby and walks it by reflection, which sees what `private_constant` hid. It
then reads the source with Prism, which sees the `:nodoc:` markers and each parameter list as
written. Reflection alone would drop every default value, so a changed default would pass unseen.
A literal default keeps its whitespace, because that whitespace is part of the value.

A public method that takes `**` hides the keywords it accepts. Each such line names the source of
those keywords, such as `EnqueueRequest#initialize` or `ActiveJob::OPTION_KEYS`, and that source has
its own lines. The generator stops on a public `**` without a named source, so every keyword a caller
can pass has a line.

Each module gets one section with its superclass, included modules, `Data` members, constants, and
public methods. A method the module inherits is left out, because its superclass or included module
already names it. The value of `VERSION` is left out too, because it changes on every release.

## How the JVM files read the artifacts

The two JVM files need different readers, because each language hides a different part of its
surface. `jvm/api-snapshot`, a Gradle subproject that is never published, holds both readers. Its
`javaApi` and `kotlinApi` tasks write the files, and the `pnpm` scripts compare them.

In both files each member line starts with the name of the class that declares it. So a member that
moves from one class to another reads as one line gone and one line arrived.

### What `java.txt` reads

`java.txt` reads the built jars of `workhorse` and `workhorse-spring-boot-starter`, one section for
each. A jar with a module descriptor exports only the packages its descriptor exports, so
`run.workhorse.internal` is absent. The starter is an automatic module, which exports
every package. The reader loads each class by reflection and prints every public and protected
class, constructor, method, and field.

Each type keeps its generic arguments and its JSpecify `@Nullable` and `@NonNull` annotations,
because a Kotlin caller compiles against that nullness. Each class header starts with its JSpecify
scope, `@NullMarked` or `@NullUnmarked`, from the class, an enclosing class, or the package. A
member that sets its own scope shows it too. An unannotated type means "not null" in a marked scope
and "unknown" in an unmarked one. So a scope change is a nullness change.

Parameter names are absent, because a Java caller cannot see them. A compile-time constant keeps its
value, because javac copies that value into the caller.

The starter section ends with each `workhorse.*` property and its type. The names and types come
from the configuration metadata that Spring Boot reads. The defaults come from the built property
class, because the metadata misses some defaults, such as an empty list. The reader makes a new
properties object and reads each property through its getters.

### What `kotlin.txt` reads

`kotlin.txt` reads the sources of `workhorse-kotlin` with the Kotlin compiler's parser. A class file
records that a parameter has a default, but not its value. So only the source can show a changed
default. The task compiles the module first, so a source that does not compile fails before the
reader runs.

Each line keeps its `suspend`, `inline`, and `reified` modifiers. A line also states each keyword
that the compiler adds without a word in the source. These are the constructor of a class that
declares none, `final` on a class, and `abstract` on an interface member without a body. Whitespace
and comments in a default value are collapsed, but a string literal keeps every character. Inside a
literal, `%` shows as `%25` and a line break as `%0A`, so each line stays one line.

An `internal` declaration marked `@PublishedApi` is present, because a public inline function
compiles a call to it into the caller. A type name that the file imports or that the package
declares is fully qualified. The reader refuses a star import, because it could not then qualify
the names.

A top-level line starts with the package, but a compiled caller calls a top-level declaration
through a JVM class. `@file:JvmName` names that class. Without it, the compiler names the class for
the file, so `WorkerScope.kt` gives `WorkerScopeKt`. Each `jvm file class` section has one line for
each top-level function and property that the class holds, with its receiver, its parameter types,
and the bounds of its type parameters, because a bound is the JVM type of a generic parameter.
So a changed `@file:JvmName`, a renamed source file, or an overload that moves to another file reads
as gone lines. A function-level `@JvmName` shows on the declaration line,
because the line prints each annotation.

## How the C# file reads the assemblies

`dotnet.txt` reads the built assemblies of `Workhorse`, `Workhorse.Hosting`,
`Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`, one section for each package. The
reader is `dotnet/tools/Workhorse.ApiSnapshot`, a console project that never ships. It reads the
metadata with `System.Reflection.Metadata` and loads no assembly. The script passes each project
directory under `dotnet/src` as a package. A package that the tool does not reference stops the
reader, so a new package cannot leave its section out.

Each type has a header line, then one line for each public and protected member. A member line
starts with the name of the type that declares it. An `implements` line names one interface of the
type, so a new interface is one arrived line. Types are fully qualified, except the C# keyword
types such as `string` and `int`. The reader stops if a public type is outside the namespace of
its package, because ADR 0107 puts each type there.

Each line keeps what a C# caller compiles against:

- `?` on a nullable type. The reader decodes the compiler's nullable metadata, so the line shows the
  annotation that the source writes. An unconstrained type parameter such as `TPayload` has no
  `?`.
- `required`, `init`, `static`, `abstract`, `virtual`, `override`, `sealed`, `params`, `this` on an
  extension method, `ref`, `ref readonly`, `out`, and `in`.
- The attributes that change what a caller compiles: the nullable analysis attributes, such as
  `[NotNullWhen(true)]` and `[return: MaybeNull]`, and `[SetsRequiredMembers]`.
- The attributes of a property's `get` and `set`, such as `[return: NotNull] get;`.
- Tuple element names, such as `(int count, string? name)`, because a caller reads an element by
  its name.
- The access of a nested type, and the value of a `const decimal`, which C# writes as an attribute.
- `record struct` for a record struct. Its constructor and its `Deconstruct` have lines.
- Parameter names, because a caller can pass an argument by name.
- Default values, generic constraints, and variance. An enum member shows its number, because a
  compiled caller holds the number.

A record header implies the members that the compiler writes for every record: the equality
members, `ToString`, and the clone method behind `with`. So these members have no lines. A
constructor always has a line. The copy constructor of a record that is not sealed is protected,
and a caller can derive from the record through it. A `Deconstruct` method has a line, because only
a positional record has one, and ADR 0107 does not allow positional records.

A change can break callers without a gone line. The check names two such cases under their own
heading. One is a new `required` property or field of an existing type. The other is a new abstract member
of a type that callers implement: an interface, or an abstract class with a public or protected
constructor. Each is an arrived line, and the check reports it as breaking.

The last section lists each `Workhorse:*` configuration key with its type and default. The reader
takes them from `ConfigurationKeys.json`, which `Workhorse.Hosting` embeds in its assembly. The
tests in `Workhorse.Tests/Hosting/ConfigurationTests.cs` hold each key and each default in that file
to the options that the key binds. So a renamed option fails those tests, and the file cannot keep
a key that the code no longer reads.

Package validation is a second check of the same surface. `EnablePackageValidation` is on in every
package, and `dotnet pack` runs it. After the first publish, the release stage compares each package
with the previous published version. That check downloads the baseline, so it does not run in
`pnpm check`. The committed snapshot stays the check of Gate 1.

## Where the last two read from

A snapshot is worth exactly what its reading is worth. A reading taken from a table kept beside the
code would leave a rename in the code and no change in the file, and the check would pass.

`cli.txt` reads `typescript/core/src/cli/surface.ts`, which is not a description of the CLI but the
CLI's own input: dispatch admits the names that table holds, every `parseCommandArgs` call takes its
options from it, and every `--json` writer states its payload as the type that table declares. So a
renamed command stops being accepted, a dropped flag stops parsing, and a retyped payload stops
compiling — each before the snapshot check runs at all.

`telemetry.txt` reads the emitting source itself. An instrument name reaches it from the
`lazyCounter`, `lazyHistogram`, and `lazyGauge` call that creates the instrument, a span name from
the `withSpan` call that opens the span, and an attribute name from the object literal or
`setAttribute` call that sets it. Log event names are absent because `WorkhorseLogEvent` is an
exported union, so `typescript.txt` already prints every member and the compiler already refuses an
unlisted one.

Two sections of `cli.txt` come from running the built CLI, not from the declaration:

- Every admin subcommand parses with the one admin option set, and then refuses each flag that does
  not apply to it. "Flags of each admin subcommand" has one line for each subcommand and each flag
  that it accepts. The generator calls `runAdminCommand` for each pair, with a database URL that no
  server answers. A pair has a line unless the CLI refuses it with `does not support --<flag>`. Some
  subcommands require a flag before they connect, such as `--reason`. `requiredFlags` in
  `scripts/cli-surface.ts` gives those inputs, and the generator stops if a subcommand refuses them.
- The payload types are TypeScript types, so a `bigint` field is the type before `--json` writes it.
  "--json encoding" states the JSON type, and the format when a script depends on it, that the
  writer of the admin subcommands gives each value kind that JSON lacks: `bigint`, `Date`, and
  `undefined`, as a field and as an item of an array. The generator runs the built `toAdminJson` on
  one sample of each kind. Then it runs the writer of each admin `--json` command on each field name
  that a payload type declares, with each kind. If one command or one field gets another JSON type
  than the table states, or the writer changes a value of a kind that JSON has, the generator stops.
  The kinds that JSON has are a string, a number, a boolean, `null`, an array, and an object. The
  generator also stops if a payload type holds another kind that JSON lacks, such as `Map`.
- `schema status` and `health` write with `JSON.stringify` and no replacer. That call writes a
  `Date` as the table states and throws on a `bigint`, so the generator stops if one of their
  payload types holds a `bigint`.

The payload shapes in `cli.txt` repeat shapes `typescript.txt` also prints, because most `--json`
payloads are public types. That is deliberate: a script reading `--json` should be able to read one
file, and `SchemaStatusReport` is on the CLI surface without being on the TypeScript one.

## The promise files of the SQL and dashboard surfaces

`protocol/v1/governed-surface.json` and `dashboard/v1/governed-surface.json` record what the SQL
protocol and `dashboard/v1` promise. `pnpm sql-catalogues:check` and `pnpm dashboard-spec:check`
compare the current surface with the file. Each check names a change that ADR 0054 or ADR 0109
calls breaking, and it asks for a regenerate after an addition. The generator only adds to the
file, so a removal fails even after a regenerate.

The SQL file records, for each function that a supported release reads:

- The type of each argument, with `?` when it has a default.
- The name of each argument, in `argumentNames`. A caller can pass an argument by name, and the
  amendment of 2026-11-12 to ADR 0109 fixes each released name.
- The value of each default, in `defaults`, keyed by the position of the argument. A direct SQL call
  that leaves out the argument gets this value. The generator writes the expression in lower case
  without spaces next to punctuation, except inside a string literal or a dollar-quoted literal. So
  a change of layout or keyword case is not a change of value.
- The result type, and the name and type of each result column. A function that returns a row type
  of a `workhorse` table, such as `SETOF workhorse.contract_definition`, records the columns of that
  table, because a reader expands them with `(definition).*`.
- The order of the result columns, in `returnsColumnOrder`. The promised columns must come first and
  in the same order. A new column can follow them.

It also records the columns of each table and view that a supported release reads.

The dashboard file records, for each procedure, the type of each request and response field, the
values of an enum, and whether a request field is required. It also records the validation bounds of
each request field: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`,
`maxLength`, `minItems`, `maxItems`, `multipleOf`, `pattern`, and `format`.

The check gives each finding one of two classes:

- `breaking`: the host now refuses a request that it accepted before. A higher lower bound, a lower
  upper bound, and a new numeric or length bound are breaking.
- `cannot prove compatible`: the change can refuse a request, but the check cannot tell. A new or
  changed `pattern` or `format`, a changed `multipleOf`, and each change of a check that JSON Schema
  cannot state are in this class. A maintainer reviews such a change, as "Known limits" says.

Both classes fail the check.

If a field accepts several branches, `branches` keeps the bounds of each branch, and a bound beside
`anyOf`, `enum`, or `const` applies to each branch. The check compares the branches of each JSON
type. If a current branch of the type has no bound, the field accepts each value of that type. If
each promised branch is still present, a new branch only accepts more. Another change of several
bounded branches cannot be proved compatible.

JSON Schema cannot state each request check. A Zod refinement, such as the byte limit of an audit
request ID, and a normalization, such as `trim`, also decide whether a host accepts a request.
`customValidation` records the checks of each field that has such a check, or of `(request)` for a
check of the whole input. `typescript/dashboard-server/spec/custom-validation.ts` reads them from
the router. A field keeps all its checks in the order that Zod runs them, because a `trim` before a
length limit accepts more than a `trim` after it. A stated check shows its kind and its parameters.
A refinement or a normalization shows the tokens of its function, joined with one space. A token
keeps its text, so a string or a regular expression keeps each character. The reader writes the
choices of a compiler one way: the spelling of a number and a string, `void 0`, the parentheses
around one arrow parameter, a trailing comma, and the `;` that ends a statement. So a new compiler,
or a change of layout, is not a change of the check.

A field whose checks keep their order, and only lose validation checks, accepts more. Each other
change of the checks of an existing field cannot be proved compatible. A check on a new field
changes no request that a caller sent before.

`recordsValidationBounds` marks a file that records the bounds and the custom checks.

## What the snapshots do not cover

A declaration a dependency owns is named without its members. `Pool` comes from `pg`, and its shape
moves with a dependency range rather than with a release here; "Moving a dependency range" in
[`docs/compatibility.md`](../docs/compatibility.md) governs that move. Nothing here says whether an
API is experimental either — the Experimental table in
[`docs/versioning.md`](../docs/versioning.md#experimental-surface) is the only authority.

Some facts of a surface have no line in any file here, because the surface does not promise them:

- The order of the columns that a supported release reads from a table or a view. A reader names
  each column.
- The bounds of a `dashboard/v1` response field, and the default of a request field. ADR 0054
  governs the type of a response field and the validation of a request, not these values.
- A flag that a CLI subcommand requires, and two flags that a subcommand refuses together. ADR 0054
  governs the commands and flags, and the file records each flag that a subcommand accepts.

## Known limits

Two kinds of limit follow. A reader can stop on a construct that it cannot read, although the
change does not break the surface. And a check can miss a change that breaks the surface.

### When a check stops on a construct that it cannot read

Each of these stops has a message that names the construct, says that the stop is a limit of the
reader and not a judged break, and points here.

- **CLI: a value-kind word in a literal.** The generator reads the payload types as text. If the
  word `bigint`, `symbol`, `Map`, `Set`, `Uint8Array`, `Buffer`, or `RegExp` is in a string literal
  type or in a quoted property name, such as `kind?: "symbol"` or `"bigint"?: string`, it reads the
  word as that type and stops. Write the property name without quotes. If a literal value must hold
  the word, a maintainer changes the scan in `scripts/cli-surface.ts` after a review. If the payload
  really holds that kind, add a sample of it to `encodingSamples`.
- **Kotlin: an expression in `@file:JvmName`.** The reader reads a string literal without a
  template, with its escapes, or the name of a `const val` of the same file. It stops on another
  expression, such as `("Stable")` or `"Sta" + "ble"`. Write the name as a string literal, such as
  `@file:JvmName("QueueSuspend")`.
- **Dashboard: a change that the checker cannot prove.** The checker does not evaluate a pattern, a
  format, or the function of a check, and it does not join several branches. So it reports a new
  or changed pattern, format, or check as `cannot prove compatible`, also when the change refuses
  no request, such as a new `pattern: "^"` or a new `min_length 0` after a `trim`. Review the
  change. If it refuses no request that the promise accepted, record it with
  `pnpm exec tsx --conditions=workhorse-source typescript/dashboard-server/spec/generate.ts --accept-breaking`,
  as `docs/versioning.md` describes, and state the review in the pull request.

### When a check can miss a break

The surface promises the facts below, but a check does not see each change to them. A change here
needs a careful review, because a check can pass on a break.

- **CLI `--json` writer that reads other fields.** The generator gives the admin writer one field
  at a time. A writer that changes the JSON type of a field only when the object also has another
  field passes the check.
- **CLI writers of `schema status` and `health`.** The generator does not run them, because each
  one needs a database. It reads their source and stops if a `JSON.stringify` of their payload
  gets a replacer. A writer that changes the payload in another way, for example through a second
  variable, passes the check.
- **Dashboard values outside a check.** The file records the source of each refinement, transform,
  and normalization of a request. A value that the function reads from outside itself, such as a
  constant that another module declares, has no line. A change to that value passes the check.
- **Dashboard `when` on a stated check.** Zod gives each length and size check a `when` function of
  its own, so the file records the `when` of a refinement only. A `when` that a change gives to a
  length or size check passes the check.
- **Python attribute types that the source does not state.** An attribute whose type the tool
  cannot read shows `<unannotated>`, as "How the Python file reads the package" says. A retype of
  such an attribute passes the check. An attribute that a method other than `__init__` assigns has
  no line.
- **Union branches that cover each other together.** If no single current branch accepts each value
  of a promised branch, the dashboard check reports a change it cannot prove, also when several
  branches together accept each value. A maintainer reviews it.
