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

The payload shapes in `cli.txt` repeat shapes `typescript.txt` also prints, because most `--json`
payloads are public types. That is deliberate: a script reading `--json` should be able to read one
file, and `SchemaStatusReport` is on the CLI surface without being on the TypeScript one.

## What the snapshots do not cover

A declaration a dependency owns is named without its members. `Pool` comes from `pg`, and its shape
moves with a dependency range rather than with a release here; "Moving a dependency range" in
[`docs/compatibility.md`](../docs/compatibility.md) governs that move. Nothing here says whether an
API is experimental either — the Experimental table in that document is the only authority.
