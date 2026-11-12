package workhorse

import (
	"fmt"
	"strings"
	"testing"
)

// SM-2010: recoverQueryPanic lets a panic of Workhorse code continue, also when the code panics
// inside the standard library, so a defect of the worker still ends the test binary. The external
// tests in worker_query_panic_test.go show the other side: a tracer of the caller becomes an error.
func TestRecoverQueryPanicHidesNoPanicOfWorkhorseCode(t *testing.T) {
	for name, call := range map[string]func() error{
		"explicit panic": func() error { panic("a defect of the worker") },
		"runtime error": func() error {
			var attempts []int
			return fmt.Errorf("attempt %d", attempts[len(attempts)])
		},
		"standard library panic": func() error {
			count := -1
			return fmt.Errorf("%s", strings.Repeat("x", count))
		},
	} {
		recovered := func() (recovered any) {
			defer func() { recovered = recover() }()
			_ = recoverQueryPanic(call)
			return nil
		}()
		if recovered == nil {
			t.Errorf("%s: recoverQueryPanic hid a panic of Workhorse code", name)
		}
	}
}

// A panic is application code only if a pgx frame comes before the first frame of this module.
// The package name of the application code does not change the answer.
func TestCallerCodeFramesAcceptsOnlyAPanicThatPgxCalled(t *testing.T) {
	for name, test := range map[string]struct {
		frames []string
		want   bool
	}{
		"tracer of the external test package": {[]string{
			"github.com/stablemates/workhorse/go_test.(*tracer).TraceQueryStart",
			"github.com/jackc/pgx/v5.(*Conn).Query",
			"github.com/stablemates/workhorse/go.(*pgxExecutor).Query",
		}, true},
		"tracer of package main": {[]string{
			"main.(*tracer).TraceQueryStart",
			"github.com/jackc/pgx/v5.(*Conn).Query",
			"github.com/stablemates/workhorse/go.(*pgxExecutor).Query",
		}, true},
		"tracer of a package without a dot": {[]string{
			"localapp/hooks.(*Tracer).TraceQueryStart",
			"github.com/jackc/pgx/v5.(*Conn).Exec",
			"github.com/stablemates/workhorse/go.(*taskNotificationHub).listen.func2",
		}, true},
		"tracer that panics inside the standard library": {[]string{
			"strings.Repeat",
			"localapp/hooks.(*Tracer).TraceQueryStart",
			"github.com/jackc/pgx/v5.(*Conn).Query",
			"github.com/stablemates/workhorse/go.(*pgxExecutor).Query",
		}, true},
		"pgx itself": {[]string{
			"github.com/jackc/pgx/v5/pgtype.(*Map).Encode",
			"github.com/stablemates/workhorse/go.(*pgxExecutor).Query",
		}, true},
		"Workhorse code": {[]string{
			"github.com/stablemates/workhorse/go.(*Worker).completeChunk",
		}, false},
		"Workhorse code inside the standard library": {[]string{
			"reflect.Value.Field",
			"encoding/json.(*encodeState).reflectValue",
			"github.com/stablemates/workhorse/go/internal/executorqueryer.Of",
		}, false},
		"Workhorse code that pgx calls back": {[]string{
			"github.com/stablemates/workhorse/go.taskIDs.Value",
			"github.com/jackc/pgx/v5/pgtype.(*Map).Encode",
			"github.com/stablemates/workhorse/go.(*pgxExecutor).Query",
		}, false},
		"hook of package main that Workhorse calls directly": {[]string{
			"main.main.func1",
			"github.com/stablemates/workhorse/go.closeAndRemove.func1",
		}, false},
		"acquire tracer": {[]string{
			"github.com/stablemates/workhorse/go_test.tracer.TraceAcquireEnd",
			"github.com/jackc/pgx/v5/pgxpool.(*Pool).Acquire.func1",
			"github.com/jackc/pgx/v5/pgxpool.(*Pool).Acquire",
			"github.com/stablemates/workhorse/go.holdClaimConnection",
		}, false},
		"release tracer": {[]string{
			"github.com/stablemates/workhorse/go_test.tracer.TraceRelease",
			"github.com/jackc/pgx/v5/pgxpool.(*Conn).Release",
			"github.com/stablemates/workhorse/go.(*pgxExecutor).Query",
		}, false},
		"no frame": {nil, false},
	} {
		if got := callerCodeFrames(test.frames); got != test.want {
			t.Errorf("%s: callerCodeFrames = %t, want %t", name, got, test.want)
		}
	}
}

func TestIsWorkhorseFunctionSeparatesTheExternalTestPackage(t *testing.T) {
	for name, want := range map[string]bool{
		"github.com/stablemates/workhorse/go.(*Worker).Run":                        true,
		"github.com/stablemates/workhorse/go/internal/executorqueryer.Of":          true,
		"github.com/stablemates/workhorse/go_test.(*tracer).TraceQueryStart":       false,
		"github.com/stablemates/workhorse/goextra.Function":                        false,
		"example.com/app/github.com/stablemates/workhorse/go.(*Tracer).TraceQuery": false,
		"github.com/jackc/pgx/v5.(*Conn).Query":                                    false,
	} {
		if got := isWorkhorseFunction(name); got != want {
			t.Errorf("isWorkhorseFunction(%q) = %t, want %t", name, got, want)
		}
	}
}

// workhorseDefectThroughAHook models a defect of Workhorse code that an application hook calls.
func workhorseDefectThroughAHook() { panic("a defect of the worker behind the hook") }

// A hook can call back into Workhorse. A panic there is a defect of the worker, so it continues.
func TestRecoverCallerHookKeepsAPanicOfWorkhorseCodeThatTheHookCalls(t *testing.T) {
	recovered := func() (recovered any) {
		defer func() { recovered = recover() }()
		recoverCallerHook(func(string) { workhorseDefectThroughAHook() }, "connection")
		return nil
	}()
	if recovered == nil {
		t.Fatal("recoverCallerHook hid a panic of Workhorse code that the hook called")
	}
}

func TestHookPanicFramesAcceptsOnlyAPanicAboveRecoverCallerHook(t *testing.T) {
	for name, test := range map[string]struct {
		frames []string
		want   bool
	}{
		"hook of package main": {[]string{
			"main.main.func1",
			"github.com/stablemates/workhorse/go.recoverCallerHook[...]",
			"github.com/stablemates/workhorse/go.closeAndRemove",
		}, true},
		"hook of a package without a dot": {[]string{
			"strings.Repeat",
			"localapp/hooks.BeforeClose",
			"github.com/stablemates/workhorse/go.recoverCallerHook[...]",
		}, true},
		"Workhorse code that the hook calls": {[]string{
			"github.com/stablemates/workhorse/go.(*Worker).Run",
			"localapp/hooks.BeforeClose",
			"github.com/stablemates/workhorse/go.recoverCallerHook[...]",
		}, false},
		"no frame": {nil, false},
	} {
		if got := hookPanicFrames(test.frames); got != test.want {
			t.Errorf("%s: hookPanicFrames = %t, want %t", name, got, test.want)
		}
	}
}

// deepFrames recurses depth times and then panics, so the panic has a deep stack.
func deepFrames(depth int) {
	if depth == 0 {
		panic("deep")
	}
	deepFrames(depth - 1)
}

// A deep stack must not hide the frame that decides: panicFrames reads the whole stack.
func TestPanicFramesReadsAWholeDeepStack(t *testing.T) {
	var names []string
	func() {
		defer func() {
			if recover() != nil {
				names = panicFrames()
			}
		}()
		deepFrames(500)
	}()
	if len(names) < 500 {
		t.Fatalf("panicFrames read %d frames, want at least 500", len(names))
	}
	last := names[len(names)-1]
	found := false
	for _, name := range names {
		if strings.HasSuffix(name, "TestPanicFramesReadsAWholeDeepStack") {
			found = true
		}
	}
	if !found {
		t.Fatalf("panicFrames did not reach the test function; the last frame is %s", last)
	}
}
