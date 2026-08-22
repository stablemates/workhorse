package workhorse

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

type cronOccurrenceFixture struct {
	ID               string   `json:"id"`
	Expression       string   `json:"expression"`
	Timezone         string   `json:"timezone"`
	LastOccurrenceAt *string  `json:"lastOccurrenceAt"`
	Now              string   `json:"now"`
	Limit            int      `json:"limit"`
	Expected         []string `json:"expected"`
}

func TestDueOccurrencesMatchTheSharedCronTable(t *testing.T) {
	contents, err := os.ReadFile("../protocol/v1/cron-occurrences.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []cronOccurrenceFixture
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatal(err)
	}

	for _, fixture := range fixtures {
		t.Run(fixture.ID, func(t *testing.T) {
			location, err := time.LoadLocation(fixture.Timezone)
			if err != nil {
				t.Fatal(err)
			}
			now, err := time.Parse(time.RFC3339, fixture.Now)
			if err != nil {
				t.Fatal(err)
			}
			var lastOccurrence *time.Time
			if fixture.LastOccurrenceAt != nil {
				parsed, err := time.Parse(time.RFC3339, *fixture.LastOccurrenceAt)
				if err != nil {
					t.Fatal(err)
				}
				lastOccurrence = &parsed
			}

			actual, err := dueOccurrences(
				fixture.Expression,
				lastOccurrence,
				now,
				fixture.Limit,
				location,
			)
			if err != nil {
				t.Fatal(err)
			}
			if len(actual) != len(fixture.Expected) {
				t.Fatalf("expected %d occurrences, received %v", len(fixture.Expected), actual)
			}
			for index, occurrence := range actual {
				if occurrence.UTC().Format(time.RFC3339) != fixture.Expected[index] {
					t.Fatalf("occurrence %d: expected %s, received %s", index, fixture.Expected[index], occurrence.UTC().Format(time.RFC3339))
				}
			}
		})
	}
}
