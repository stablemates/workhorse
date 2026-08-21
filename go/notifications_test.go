package workhorse

import (
	"os"
	"regexp"
	"testing"
)

func TestJobNotificationProtocolMatchesTypeScript(t *testing.T) {
	contents, err := os.ReadFile("../typescript/core/src/notifications.ts")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	channelMatch := regexp.MustCompile(`const CHANNEL = "([^"]+)"`).FindStringSubmatch(source)
	if len(channelMatch) != 2 {
		t.Fatal("TypeScript notification channel was not found")
	}
	if jobNotificationChannel != channelMatch[1] {
		t.Fatalf("Go listens on %q, TypeScript listens on %q", jobNotificationChannel, channelMatch[1])
	}
	if !regexp.MustCompile(`notification\.payload === subscriber\.queueName\s*\|\|\s*notification\.payload === "\*"`).MatchString(source) {
		t.Fatal("TypeScript queue and wildcard notification semantics changed")
	}
	if !jobNotificationMatches("email", []string{"email", "reports"}) {
		t.Fatal("a queue notification did not wake its configured Go queue")
	}
	if !jobNotificationMatches("*", []string{"email", "reports"}) {
		t.Fatal("a wildcard notification did not wake the Go worker")
	}
	if jobNotificationMatches("billing", []string{"email", "reports"}) {
		t.Fatal("an unrelated queue notification woke the Go worker")
	}
}
