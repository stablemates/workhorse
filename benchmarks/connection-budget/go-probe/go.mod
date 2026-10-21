// The Go probe of the connection budget benchmark (SM-1566). It is a separate module, so the
// published module in go/ does not carry it. The replace directive builds it against the SDK
// source of this checkout.
module github.com/stablemates/workhorse/benchmarks/connection-budget/go-probe

go 1.25.0

toolchain go1.26.10

require (
	github.com/jackc/pgx/v5 v5.11.0
	github.com/stablemates/workhorse/go v0.0.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.3 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel v1.46.0 // indirect
	go.opentelemetry.io/otel/metric v1.46.0 // indirect
	go.opentelemetry.io/otel/trace v1.46.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/text v0.41.0 // indirect
)

replace github.com/stablemates/workhorse/go => ../../../go
