package workhorse

// RecoverCallerHookForTest calls recoverCallerHook, so an external test can give it a hook that is
// code of the application.
func RecoverCallerHookForTest[T any](hook func(T), value T) { recoverCallerHook(hook, value) }
