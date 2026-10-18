package workhorse

import (
	"testing"
	"time"
)

func TestHeartbeatRoundBoundIsThreeQuartersOfTheIntervalAndTheIntervalUpTo50Ms(t *testing.T) {
	for _, test := range []struct{ interval, bound time.Duration }{
		{10 * time.Millisecond, 10 * time.Millisecond},
		{40 * time.Millisecond, 40 * time.Millisecond},
		{50 * time.Millisecond, 50 * time.Millisecond},
		{66 * time.Millisecond, 50 * time.Millisecond},
		{69 * time.Millisecond, 51 * time.Millisecond},
		{200 * time.Millisecond, 150 * time.Millisecond},
		{10 * time.Second, 7500 * time.Millisecond},
	} {
		if bound := heartbeatRoundBoundFor(test.interval); bound != test.bound {
			t.Errorf("bound for %s = %s; want %s", test.interval, bound, test.bound)
		}
	}
	// With the defaults, one timed-out round leaves a renewal margin.
	lease := defaultWorkerLease
	if interval := lease / 3; 2*interval+heartbeatRoundBoundFor(interval) >= lease {
		t.Fatalf("no renewal margin for a lease of %s", lease)
	}
}
