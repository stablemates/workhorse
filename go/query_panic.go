package workhorse

import (
	"context"
	"fmt"
	"runtime"
	"runtime/debug"
	"strings"
)

// queryPanicError is a panic that code outside Workhorse raised inside a database call of a worker
// goroutine (SM-2010). The worker does not own its pool, so a caller can give it a pgx tracer, and
// pgx runs that tracer inside each query. On a goroutine other than the execution goroutine, such a
// panic used to end the process. The worker now gives the error to the usual error path of that
// goroutine, which answers its callers and logs the error.
type queryPanicError struct {
	value any
	stack string
}

func (err *queryPanicError) Error() string {
	return fmt.Sprintf(queryPanicFormat, err.value, err.stack)
}

// recoverQueryPanic runs call, which is a database call of a worker goroutine, and returns its
// error. A panic inside call becomes a queryPanicError only if panicFromCallerCode accepts it, such
// as a panic of a pgx tracer. Any other panic continues with its stack, so a defect of the worker
// still ends the process and the test binary that finds it.
func recoverQueryPanic(call func() error) (err error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		if !panicFromCallerCode() {
			panic(recovered)
		}
		err = &queryPanicError{value: recovered, stack: string(debug.Stack())}
	}()
	return call()
}

// panicFromCallerCode reports whether the panic that the calling deferred function recovers came
// from code outside Workhorse. A deferred function runs on the stack of the panic, so the frames
// below runtime.gopanic lead from the panic to its callers.
//
//   - A panic inside an acquire or a release of pgxpool is not accepted. pgxpool can then lose the
//     connection, and a worker that continues would empty its pool.
//   - Code of the application reaches a database call of the worker only through pgx, for example
//     as a tracer. Thus the panic is accepted only if a pgx frame comes before the first frame of
//     this module. The package name of the application code does not matter.
//   - A panic of Workhorse code reaches a frame of this module first, also when it panics inside
//     the standard library. pgx can call back into Workhorse code, such as a value that encodes
//     itself; that frame of this module also comes first.
func panicFromCallerCode() bool {
	return callerCodeFrames(panicFrames())
}

// panicFrames returns the function name of each frame below runtime.gopanic, from the panic to its
// callers. The caller must be a deferred function that recovers the panic. The buffer grows until
// it holds the whole stack, so a deep stack of application code cannot hide the frame that decides
// (SM-2010).
func panicFrames() []string {
	callers := make([]uintptr, 128)
	count := runtime.Callers(3, callers)
	for count == len(callers) {
		callers = make([]uintptr, 2*len(callers))
		count = runtime.Callers(3, callers)
	}
	frames := runtime.CallersFrames(callers[:count])
	var names []string
	belowPanic := false
	for {
		frame, more := frames.Next()
		if belowPanic {
			names = append(names, frame.Function)
		}
		belowPanic = belowPanic || frame.Function == runtimePanicFunction
		if !more {
			return names
		}
	}
}

// callerCodeFrames applies the rules of panicFromCallerCode to the frames below runtime.gopanic,
// from the panic to its callers.
func callerCodeFrames(names []string) bool {
	for _, name := range names {
		if strings.HasPrefix(name, pgxPoolAcquireFunction) || strings.HasPrefix(name, pgxPoolReleaseFunction) {
			return false
		}
	}
	for _, name := range names {
		if isWorkhorseFunction(name) {
			return false
		}
		if strings.HasPrefix(name, pgxModulePath) {
			return true
		}
	}
	// No pgx frame and no frame of this module names the panic. The worker cannot prove that the
	// panic came from outside, so it does not hide it.
	return false
}

// recoverCallerHook calls hook, which is code of the application that the worker calls directly,
// such as the BeforeClose hook of the pool, with value. It drops a panic of the application,
// whatever its package (SM-2010). The hook can call back into Workhorse. A panic there continues
// with its stack, so a defect of the worker does not hide behind the hook.
func recoverCallerHook[T any](hook func(T), value T) {
	defer func() {
		recovered := recover()
		if recovered != nil && !hookPanicFrames(panicFrames()) {
			panic(recovered)
		}
	}()
	hook(value)
}

// hookPanicFrames reports whether a panic inside recoverCallerHook came from the application. The
// hook runs right below recoverCallerHook, so the first frame of this module, from the panic to its
// callers, is recoverCallerHook itself. Any earlier frame of this module is Workhorse code that the
// hook called.
func hookPanicFrames(names []string) bool {
	for _, name := range names {
		if isWorkhorseFunction(name) {
			return strings.HasPrefix(name, recoverCallerHookFunction)
		}
	}
	return false
}

// isWorkhorseFunction reports whether a fully qualified function name belongs to this module. The
// name of the external test package, workhorse_test, does not.
func isWorkhorseFunction(name string) bool {
	rest, ok := strings.CutPrefix(name, workhorseModulePath)
	return ok && (strings.HasPrefix(rest, functionNameSeparator) || strings.HasPrefix(rest, packagePathSeparator))
}

// panicSafeExecutor runs each query of its executor through recoverQueryPanic. The worker gives it
// to the goroutines that query outside the execution goroutine. The execution goroutine keeps the
// plain executor, because its own recover fails the attempt (SM-1938).
type panicSafeExecutor struct {
	executor Executor
}

// guardQueries returns executor behind a panicSafeExecutor, once.
func guardQueries(executor Executor) Executor {
	if _, ok := executor.(panicSafeExecutor); ok {
		return executor
	}
	return panicSafeExecutor{executor: executor}
}

func (guarded panicSafeExecutor) Query(ctx context.Context, statement string, arguments ...any) ([]Row, error) {
	var rows []Row
	err := recoverQueryPanic(func() error {
		var err error
		rows, err = guarded.executor.Query(ctx, statement, arguments...)
		return err
	})
	return rows, err
}
