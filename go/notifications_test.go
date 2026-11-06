package workhorse

import (
	"os"
	"regexp"
	"testing"
	"time"
)

func TestTaskNotificationProtocolMatchesTypeScript(t *testing.T) {
	contents, err := os.ReadFile("../typescript/core/src/notifications.ts")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	channelMatch := regexp.MustCompile(`const CHANNEL = "([^"]+)"`).FindStringSubmatch(source)
	if len(channelMatch) != 2 {
		t.Fatal("TypeScript notification channel was not found")
	}
	if taskNotificationChannel != channelMatch[1] {
		t.Fatalf("Go listens on %q, TypeScript listens on %q", taskNotificationChannel, channelMatch[1])
	}
	if !regexp.MustCompile(`notification\.payload === subscriber\.queueName\s*\|\|\s*notification\.payload === "\*"`).MatchString(source) {
		t.Fatal("TypeScript queue and wildcard notification semantics changed")
	}
	if !taskNotificationMatches("email", []string{"email", "reports"}) {
		t.Fatal("a queue notification did not wake its configured Go queue")
	}
	if !taskNotificationMatches("*", []string{"email", "reports"}) {
		t.Fatal("a wildcard notification did not wake the Go worker")
	}
	if taskNotificationMatches("billing", []string{"email", "reports"}) {
		t.Fatal("an unrelated queue notification woke the Go worker")
	}
}

// The listener reconnect delay carries the same ±10% jitter as the other SDKs. So a PostgreSQL
// restart does not reconnect a fleet of Go listeners at the same moment.
func TestListenerReconnectDelayCarriesJitter(t *testing.T) {
	for delay := notificationReconnectInitial; ; delay = min(notificationReconnectMaximum, delay*2) {
		low := time.Duration(float64(delay) * 0.9)
		high := time.Duration(float64(delay) * 1.1)
		seen := map[time.Duration]bool{}
		for range 200 {
			jittered := jitterDelay(delay)
			if jittered < low || jittered > high {
				t.Fatalf("reconnect delay %s waited %s, want %s to %s", delay, jittered, low, high)
			}
			seen[jittered] = true
		}
		if len(seen) < 2 {
			t.Fatalf("reconnect delay %s waited one value 200 times, want jitter", delay)
		}
		if delay == notificationReconnectMaximum {
			break
		}
	}
}
