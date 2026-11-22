// Package earlyprovider runs a test in a new process. In that process, OpenTelemetry providers
// can be registered before the Workhorse package starts. It is for tests only.
//
// Go initializes an imported package before the package that imports it. A test file of the
// Workhorse package imports this package, so its init function runs first. It registers the
// providers only when the new process asks for them. Thus the other tests keep the start
// delegates of OpenTelemetry.
//
// The global providers of OpenTelemetry cannot go back to their start state. After a test registers
// a provider, the start delegate sends its records to that provider. Thus a test of the start state
// also runs in a new process.
//
// The coverage of the new process does not go into the coverage report of the first process.
package earlyprovider

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const (
	processVariable = "WORKHORSE_TEST_NEW_PROCESS"
	earlyValue      = "early"
	startValue      = "start"
)

var (
	// Reader collects the metrics of the early meter provider.
	Reader = sdkmetric.NewManualReader()
	// Recorder keeps the spans of the early tracer provider.
	Recorder = tracetest.NewSpanRecorder()
)

func init() {
	if os.Getenv(processVariable) != earlyValue {
		return
	}
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(Reader)))
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(Recorder)))
}

// RunWithEarlyProviders runs the test t in a new process in which Reader and Recorder belong to
// providers that were registered before the Workhorse package started. It returns false in that
// new process, so the test continues there. It returns true in the first process after the new
// process passed.
func RunWithEarlyProviders(t *testing.T) bool {
	return runInNewProcess(t, earlyValue)
}

// RunWithStartDelegates runs the test t in a new process in which the global providers are still
// the start delegates of OpenTelemetry. It returns as RunWithEarlyProviders does.
func RunWithStartDelegates(t *testing.T) bool {
	return runInNewProcess(t, startValue)
}

func runInNewProcess(t *testing.T, value string) bool {
	t.Helper()
	switch os.Getenv(processVariable) {
	case value:
		return false
	case "":
	default:
		t.Skip("this test runs only in its own new process")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+t.Name()+"$", "-test.count=1", "-test.v")
	command.Env = append(os.Environ(), processVariable+"="+value)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("the new process failed: %v\n%s", err, output)
	}
	return true
}
