package workhorse

// Version is the published Workhorse module version. A parity test keeps it in step with the
// TypeScript and Python manifests, because the Go module has no manifest of its own to read.
const Version = "0.1.0"

// sdkLanguage is what this client library is, reported to the worker registry on every
// registration refresh. An operator reads it to decide whether any worker still speaks a protocol
// they are about to retire.
const sdkLanguage = "go"
