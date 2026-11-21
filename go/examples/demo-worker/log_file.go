// Writes the demo log file of the Go demo worker, in the record format that every demo worker
// shares, so the merged demo logs read as one stream.
//
// Documentation: https://workhorse.run/docs/dashboard
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	defaultLogMaxBytes = 10 * 1024 * 1024
	defaultLogArchives = 5
)

var unsafePathCharacters = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

// demoLogRecord is the NDJSON record of typescript/demo/file-log-exporter.cjs. The field order is
// the order of that file.
type demoLogRecord struct {
	Timestamp         string            `json:"timestamp"`
	ObservedTimestamp string            `json:"observedTimestamp"`
	SeverityText      string            `json:"severityText"`
	SeverityNumber    int               `json:"severityNumber"`
	EventName         string            `json:"eventName,omitempty"`
	Body              string            `json:"body"`
	Attributes        map[string]any    `json:"attributes"`
	Resource          map[string]any    `json:"resource"`
	Scope             map[string]string `json:"scope"`
}

// demoLogFile appends demo log records to one file. It rotates the file before a record would take
// it past maxBytes, and keeps archives numbered archives. A write that fails reports once to
// standard error and never reaches the worker.
type demoLogFile struct {
	path     string
	maxBytes int64
	archives int
	resource map[string]any
	mu       sync.Mutex
	failed   bool
}

func safePathSegment(value string) string {
	safe := unsafePathCharacters.ReplaceAllString(value, "_")
	if len(safe) > 100 {
		safe = safe[:100]
	}
	if safe == "" {
		return "unknown"
	}
	return safe
}

func positiveInteger(name string, fallback int) (int, error) {
	value, ok := os.LookupEnv(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return parsed, nil
}

// newDemoLogFile returns the log file of this worker, or nil when the launcher names no log
// directory or no service name.
func newDemoLogFile() (*demoLogFile, error) {
	directory := os.Getenv("WORKHORSE_DEMO_LOG_DIRECTORY")
	service := os.Getenv("WORKHORSE_DEMO_SERVICE_NAME")
	if directory == "" || service == "" {
		return nil, nil
	}
	environment := os.Getenv("WORKHORSE_DEMO_ENV")
	if environment == "" {
		environment = "development"
	}
	maxBytes, err := positiveInteger("WORKHORSE_DEMO_LOG_MAX_BYTES", defaultLogMaxBytes)
	if err != nil {
		return nil, err
	}
	archives, err := positiveInteger("WORKHORSE_DEMO_LOG_ARCHIVES", defaultLogArchives)
	if err != nil {
		return nil, err
	}
	root, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	return &demoLogFile{
		path:     filepath.Join(root, safePathSegment(environment), safePathSegment(service)+".ndjson"),
		maxBytes: int64(maxBytes),
		archives: archives,
		resource: map[string]any{
			"service.name":                service,
			"deployment.environment.name": environment,
			"deployment.environment":      environment,
			"host.name":                   host,
			"process.pid":                 os.Getpid(),
			"telemetry.sdk.language":      "go",
		},
	}, nil
}

func (file *demoLogFile) write(record demoLogRecord) {
	record.Resource = file.resource
	line, err := json.Marshal(record)
	file.mu.Lock()
	defer file.mu.Unlock()
	if err == nil {
		err = file.append(append(line, '\n'))
	}
	if err != nil && !file.failed {
		file.failed = true
		fmt.Fprintf(os.Stderr, "Could not write the demo log file %s: %v\n", file.path, err)
	}
}

func (file *demoLogFile) append(line []byte) error {
	if err := os.MkdirAll(filepath.Dir(file.path), 0o755); err != nil {
		return err
	}
	var size int64
	if info, err := os.Stat(file.path); err == nil {
		size = info.Size()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if size > 0 && size+int64(len(line)) > file.maxBytes {
		if err := file.rotate(); err != nil {
			return err
		}
	}
	output, err := os.OpenFile(file.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := output.Write(line); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

func (file *demoLogFile) rotate() error {
	if err := os.Remove(fmt.Sprintf("%s.%d", file.path, file.archives)); err != nil &&
		!errors.Is(err, fs.ErrNotExist) {
		return err
	}
	for index := file.archives - 1; index >= 1; index-- {
		err := os.Rename(fmt.Sprintf("%s.%d", file.path, index), fmt.Sprintf("%s.%d", file.path, index+1))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return os.Rename(file.path, file.path+".1")
}

func utcMilliseconds(moment time.Time) string {
	return moment.UTC().Format("2006-01-02T15:04:05.000Z")
}

// demoLogHandler writes each slog record to a demoLogFile. It records every level, so the file has
// the debug records that the console handler leaves out.
type demoLogHandler struct {
	file   *demoLogFile
	attrs  []slog.Attr
	groups []string
}

func newDemoLogHandler(file *demoLogFile) *demoLogHandler {
	return &demoLogHandler{file: file}
}

func (handler *demoLogHandler) Enabled(context.Context, slog.Level) bool { return true }

func (handler *demoLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := *handler
	next.attrs = append(append([]slog.Attr{}, handler.attrs...), qualify(handler.groups, attrs)...)
	return &next
}

func (handler *demoLogHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return handler
	}
	next := *handler
	next.groups = append(append([]string{}, handler.groups...), name)
	return &next
}

func qualify(groups []string, attrs []slog.Attr) []slog.Attr {
	if len(groups) == 0 {
		return attrs
	}
	prefix := ""
	for _, group := range groups {
		prefix += group + "."
	}
	qualified := make([]slog.Attr, len(attrs))
	for index, attr := range attrs {
		qualified[index] = slog.Attr{Key: prefix + attr.Key, Value: attr.Value}
	}
	return qualified
}

func severity(level slog.Level) (string, int) {
	switch {
	case level < slog.LevelInfo:
		return "DEBUG", 5
	case level < slog.LevelWarn:
		return "INFO", 9
	case level < slog.LevelError:
		return "WARN", 13
	default:
		return "ERROR", 17
	}
}

// addAttribute follows the slog rules: a group with an empty key adds its members inline, and any
// other attribute with an empty key adds nothing. A NaN or an infinity becomes null, as
// `JSON.stringify` writes it, because encoding/json refuses the whole record otherwise.
func addAttribute(attributes map[string]any, key string, value slog.Value) {
	value = value.Resolve()
	switch value.Kind() {
	case slog.KindGroup:
		for _, member := range value.Group() {
			memberKey := member.Key
			if key != "" && memberKey != "" {
				memberKey = key + "." + memberKey
			} else if key != "" && member.Value.Kind() == slog.KindGroup {
				memberKey = key
			}
			addAttribute(attributes, memberKey, member.Value)
		}
		return
	}
	if key == "" {
		return
	}
	switch value.Kind() {
	case slog.KindFloat64:
		if number := value.Float64(); math.IsNaN(number) || math.IsInf(number, 0) {
			attributes[key] = nil
		} else {
			attributes[key] = number
		}
	case slog.KindTime:
		attributes[key] = utcMilliseconds(value.Time())
	case slog.KindDuration:
		attributes[key] = value.Duration().Milliseconds()
	case slog.KindAny:
		if err, ok := value.Any().(error); ok {
			attributes[key] = err.Error()
		} else {
			attributes[key] = value.Any()
		}
	default:
		attributes[key] = value.Any()
	}
}

func (handler *demoLogHandler) Handle(_ context.Context, record slog.Record) error {
	attributes := map[string]any{}
	for _, attr := range handler.attrs {
		addAttribute(attributes, attr.Key, attr.Value)
	}
	var recordAttrs []slog.Attr
	record.Attrs(func(attr slog.Attr) bool {
		recordAttrs = append(recordAttrs, attr)
		return true
	})
	for _, attr := range qualify(handler.groups, recordAttrs) {
		addAttribute(attributes, attr.Key, attr.Value)
	}
	eventName, _ := attributes["event.name"].(string)
	delete(attributes, "event.name")
	moment := record.Time
	if moment.IsZero() {
		moment = time.Now()
	}
	text, number := severity(record.Level)
	handler.file.write(demoLogRecord{
		Timestamp:         utcMilliseconds(moment),
		ObservedTimestamp: utcMilliseconds(time.Now()),
		SeverityText:      text,
		SeverityNumber:    number,
		EventName:         eventName,
		Body:              record.Message,
		Attributes:        attributes,
		Scope:             map[string]string{"name": "github.com/stablemates/workhorse/go"},
	})
	return nil
}

// demoLogger writes JSON lines to standard output and, when the launcher names a log directory,
// every record to the demo log file.
func demoLogger(file *demoLogFile) *slog.Logger {
	console := slog.NewJSONHandler(os.Stdout, nil)
	if file == nil {
		return slog.New(console)
	}
	return slog.New(slog.NewMultiHandler(console, newDemoLogHandler(file)))
}
