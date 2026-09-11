package workhorse

import (
	"os"
	"regexp"
	"testing"
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
