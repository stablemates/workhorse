package workhorse

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

var hashedCronFieldPattern = regexp.MustCompile(hashedCronFieldPatternValue)
var lastWeekdayCronFieldPattern = regexp.MustCompile(lastWeekdayCronFieldPatternValue)

var cronOccurrenceParser = cron.NewParser(
	cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor,
)

func dueOccurrences(
	expression string,
	lastOccurrenceAt *time.Time,
	now time.Time,
	limit int,
	location *time.Location,
) ([]time.Time, error) {
	normalized, err := expandHashedCronFields(expression)
	if err != nil {
		return nil, err
	}
	schedule, err := parseCronOccurrenceSchedule(normalized)
	if err != nil {
		return nil, fmt.Errorf(invalidCronExpressionFormat, expression, err)
	}
	wallNow := wallClock(now.In(location))
	if lastOccurrenceAt == nil {
		wallOccurrence, err := latestWallOccurrence(
			schedule,
			wallClock(now.Add(time.Second).In(location)),
		)
		if err != nil {
			return nil, err
		}
		occurrence := resolveWallClock(wallOccurrence, location)
		return []time.Time{occurrence}, nil
	}

	cursor := wallClock(lastOccurrenceAt.In(location))
	occurrences := make([]time.Time, 0, limit)
	for len(occurrences) < limit {
		wallOccurrence := schedule.Next(cursor)
		if wallOccurrence.IsZero() || wallOccurrence.After(wallNow) {
			break
		}
		occurrence := resolveWallClock(wallOccurrence, location)
		if occurrence.After(now) {
			break
		}
		occurrences = append(occurrences, occurrence)
		cursor = wallOccurrence
	}
	return occurrences, nil
}

func latestWallOccurrence(schedule cron.Schedule, wallNow time.Time) (time.Time, error) {
	for distance := time.Second; distance <= 128*366*24*time.Hour; distance *= 2 {
		candidate := schedule.Next(wallNow.Add(-distance))
		if candidate.IsZero() || candidate.After(wallNow) {
			continue
		}
		for {
			next := schedule.Next(candidate)
			if next.IsZero() || next.After(wallNow) {
				return candidate, nil
			}
			candidate = next
		}
	}
	return time.Time{}, errors.New(cronOccurrenceSearchMessage)
}

type filteredCronSchedule struct {
	schedule cron.Schedule
	accept   func(time.Time) bool
}

type extendedCronSchedule struct {
	schedule cron.Schedule
}

func (schedule extendedCronSchedule) Next(after time.Time) time.Time {
	cursor := after
	for range 32 {
		candidate := schedule.schedule.Next(cursor)
		if !candidate.IsZero() {
			return candidate
		}
		cursor = cursor.AddDate(4, 0, 0)
	}
	return time.Time{}
}

func (schedule filteredCronSchedule) Next(after time.Time) time.Time {
	for candidate := schedule.schedule.Next(after); !candidate.IsZero(); candidate = schedule.schedule.Next(candidate) {
		if schedule.accept(candidate) {
			return candidate
		}
	}
	return time.Time{}
}

type mergedCronSchedule []cron.Schedule

func (schedules mergedCronSchedule) Next(after time.Time) time.Time {
	var earliest time.Time
	for _, schedule := range schedules {
		candidate := schedule.Next(after)
		if !candidate.IsZero() && (earliest.IsZero() || candidate.Before(earliest)) {
			earliest = candidate
		}
	}
	return earliest
}

func parseCronOccurrenceSchedule(expression string) (cron.Schedule, error) {
	fields := strings.Fields(expression)
	if len(fields) != 5 && len(fields) != 6 {
		return parseRobfigCron(expression)
	}
	domIndex := len(fields) - 3
	dowIndex := len(fields) - 1
	if !strings.Contains(strings.ToUpper(fields[domIndex]+fields[dowIndex]), cronLastDayField) {
		return parseRobfigCron(expression)
	}

	domWildcard := cronFieldIsWildcard(fields[domIndex])
	dowWildcard := cronFieldIsWildcard(fields[dowIndex])
	schedules := make(mergedCronSchedule, 0, 4)
	if !domWildcard {
		parsed, err := parseDayOfMonthSchedules(fields, domIndex)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, parsed...)
	}
	if !dowWildcard {
		parsed, err := parseDayOfWeekSchedules(fields, dowIndex)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, parsed...)
	}
	if len(schedules) == 0 {
		return parseRobfigCron(expression)
	}
	return schedules, nil
}

func parseDayOfMonthSchedules(fields []string, domIndex int) ([]cron.Schedule, error) {
	ordinaryTokens := make([]string, 0)
	hasLastDay := false
	for _, token := range strings.Split(fields[domIndex], cronListSeparator) {
		if strings.EqualFold(token, cronLastDayField) {
			hasLastDay = true
			continue
		}
		ordinaryTokens = append(ordinaryTokens, token)
	}
	schedules := make([]cron.Schedule, 0, 2)
	if len(ordinaryTokens) > 0 {
		parsed, err := parseCronDayFields(fields, strings.Join(ordinaryTokens, cronListSeparator), cronWildcardField)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, parsed)
	}
	if hasLastDay {
		parsed, err := parseCronDayFields(fields, cronLastDayCandidateRange, cronWildcardField)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, filteredCronSchedule{
			schedule: parsed,
			accept: func(candidate time.Time) bool {
				return candidate.AddDate(0, 0, 1).Month() != candidate.Month()
			},
		})
	}
	return schedules, nil
}

func parseDayOfWeekSchedules(fields []string, dowIndex int) ([]cron.Schedule, error) {
	ordinaryTokens := make([]string, 0)
	lastWeekdays := make([]string, 0)
	for _, token := range strings.Split(fields[dowIndex], cronListSeparator) {
		match := lastWeekdayCronFieldPattern.FindStringSubmatch(token)
		if match == nil {
			ordinaryTokens = append(ordinaryTokens, token)
			continue
		}
		weekday := match[1]
		if weekday == cronSundayAlias {
			weekday = cronSundayField
		}
		lastWeekdays = append(lastWeekdays, weekday)
	}
	schedules := make([]cron.Schedule, 0, len(lastWeekdays)+1)
	if len(ordinaryTokens) > 0 {
		parsed, err := parseCronDayFields(fields, cronWildcardField, strings.Join(ordinaryTokens, cronListSeparator))
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, parsed)
	}
	for _, weekday := range lastWeekdays {
		parsed, err := parseCronDayFields(fields, cronWildcardField, weekday)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, filteredCronSchedule{
			schedule: parsed,
			accept: func(candidate time.Time) bool {
				return candidate.AddDate(0, 0, 7).Month() != candidate.Month()
			},
		})
	}
	return schedules, nil
}

func parseCronDayFields(fields []string, dayOfMonth, dayOfWeek string) (cron.Schedule, error) {
	variant := append([]string(nil), fields...)
	variant[len(fields)-3] = dayOfMonth
	variant[len(fields)-1] = dayOfWeek
	return parseRobfigCron(strings.Join(variant, cronFieldSeparator))
}

func parseRobfigCron(expression string) (cron.Schedule, error) {
	parsed, err := cronOccurrenceParser.Parse(cronUTCZonePrefix + expression)
	if err != nil {
		return nil, err
	}
	return extendedCronSchedule{schedule: parsed}, nil
}

func cronFieldIsWildcard(field string) bool {
	return field == cronWildcardField || field == cronUnspecifiedField
}

func wallClock(value time.Time) time.Time {
	return time.Date(
		value.Year(), value.Month(), value.Day(), value.Hour(), value.Minute(), value.Second(), 0, time.UTC,
	)
}

func resolveWallClock(wall time.Time, location *time.Location) time.Time {
	approximate := time.Date(
		wall.Year(), wall.Month(), wall.Day(), wall.Hour(), wall.Minute(), wall.Second(), 0, location,
	)
	offsets := make(map[int]struct{}, 3)
	for _, sample := range []time.Time{
		approximate.Add(-48 * time.Hour),
		approximate,
		approximate.Add(48 * time.Hour),
	} {
		_, offset := sample.Zone()
		offsets[offset] = struct{}{}
	}
	var earliest time.Time
	for offset := range offsets {
		candidate := time.Unix(wall.Unix()-int64(offset), 0).In(location)
		if !wallClock(candidate).Equal(wall) {
			continue
		}
		if earliest.IsZero() || candidate.Before(earliest) {
			earliest = candidate
		}
	}
	if !earliest.IsZero() {
		return earliest
	}

	_, beforeOffset := approximate.Add(-48 * time.Hour).Zone()
	_, afterOffset := approximate.Add(48 * time.Hour).Zone()
	if gap := afterOffset - beforeOffset; gap > 0 {
		return resolveWallClock(wall.Add(time.Duration(gap)*time.Second), location)
	}
	return approximate
}

func expandHashedCronFields(expression string) (string, error) {
	fields := strings.Fields(expression)
	var domains [][2]int
	switch len(fields) {
	case 5:
		domains = [][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}}
	case 6:
		domains = [][2]int{{0, 59}, {0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}}
	default:
		return expression, nil
	}

	for fieldIndex, domain := range domains {
		field := fields[fieldIndex]
		matches := hashedCronFieldPattern.FindAllStringSubmatchIndex(field, -1)
		if len(matches) == 0 {
			continue
		}
		var expanded strings.Builder
		previousEnd := 0
		tokenIndex := 0
		for _, match := range matches {
			start, end := match[0], match[1]
			if (start > 0 && isASCIILetter(field[start-1])) || (end < len(field) && isASCIILetter(field[end])) {
				continue
			}
			lower, upper := domain[0], domain[1]
			if match[2] >= 0 {
				lower, _ = strconv.Atoi(field[match[2]:match[3]])
				upper, _ = strconv.Atoi(field[match[4]:match[5]])
			}
			if lower < domain[0] || upper > domain[1] || lower > upper {
				return emptyString, fmt.Errorf(invalidHashedCronRangeFormat, expression)
			}
			var step *int
			if match[6] >= 0 {
				parsed, _ := strconv.Atoi(field[match[6]:match[7]])
				if parsed < 1 {
					return emptyString, fmt.Errorf(invalidHashedCronStepFormat, expression)
				}
				step = &parsed
			}

			seed := fmt.Sprintf(hashedCronSeedFormat, expression, fieldIndex, tokenIndex)
			digest := sha256.Sum256([]byte(seed))
			width := upper - lower + 1
			if step != nil && *step < width {
				width = *step
			}
			chosen := lower + int(binary.BigEndian.Uint32(digest[:4])%uint32(width))
			expanded.WriteString(field[previousEnd:start])
			if step == nil {
				expanded.WriteString(strconv.Itoa(chosen))
			} else {
				expanded.WriteString(fmt.Sprintf(expandedHashedCronStepFormat, chosen, upper, *step))
			}
			previousEnd = end
			tokenIndex++
		}
		if tokenIndex > 0 {
			expanded.WriteString(field[previousEnd:])
			fields[fieldIndex] = expanded.String()
		}
	}
	return strings.Join(fields, cronFieldSeparator), nil
}

func isASCIILetter(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}
