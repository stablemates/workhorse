package workhorse

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

type protocolManifest struct {
	Schema struct {
		MinimumVersion int `json:"minimumVersion"`
		MaximumVersion int `json:"maximumVersion"`
	} `json:"schema"`
	Functions []struct {
		Name     string `json:"name"`
		Arity    int    `json:"arity"`
		Contract string `json:"contract"`
	} `json:"functions"`
	Views []struct {
		Name     string `json:"name"`
		Contract string `json:"contract"`
	} `json:"views"`
	Statements []struct {
		Name     string `json:"name"`
		Arity    int    `json:"arity"`
		Contract string `json:"contract"`
	} `json:"statements"`
}

func TestGeneratedCataloguesMatchProtocolManifest(t *testing.T) {
	manifest := readProtocolManifest(t)
	got := make(map[string]string, len(manifest.Statements))
	for _, registry := range []map[string]string{internalStatementRegistry, protocolStatementRegistry, adminStatementRegistry} {
		for name, contract := range registry {
			if previous, exists := got[name]; exists && previous != contract {
				t.Fatalf("generated catalogues disagree about %s", name)
			}
			got[name] = contract
		}
	}
	placeholder := regexp.MustCompile(`\$(\d+)`)
	for _, statement := range manifest.Statements {
		if got[statement.Name] != statement.Contract {
			t.Errorf("%s SQL differs from the manifest", statement.Name)
		}
		if statementArity(statement.Contract, placeholder) != statement.Arity {
			t.Errorf("%s has the wrong manifest arity", statement.Name)
		}
		delete(got, statement.Name)
	}
	if len(got) != 0 {
		t.Errorf("generated Go catalogue has entries absent from the manifest: %v", got)
	}
}

func TestGeneratedCatalogueCoversGoStatementUsage(t *testing.T) {
	registries := map[string]map[string]string{
		"internalStatementRegistry": internalStatementRegistry,
		"protocolStatementRegistry": protocolStatementRegistry,
		"adminStatementRegistry":    adminStatementRegistry,
	}
	constants := make(map[string]string)
	uses := make(map[string]int)
	files := parseProductionGoFiles(t)

	for _, file := range files {
		ast.Inspect(file, func(node ast.Node) bool {
			declaration, ok := node.(*ast.ValueSpec)
			if !ok {
				return true
			}
			for index, name := range declaration.Names {
				if !strings.HasSuffix(name.Name, "StatementName") || index >= len(declaration.Values) {
					continue
				}
				literal, ok := declaration.Values[index].(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					continue
				}
				value, err := strconv.Unquote(literal.Value)
				if err != nil {
					t.Fatal(err)
				}
				constants[name.Name] = value
			}
			return true
		})
	}

	for _, file := range files {
		ast.Inspect(file, func(node ast.Node) bool {
			if identifier, ok := node.(*ast.Ident); ok {
				uses[identifier.Name]++
			}
			lookup, ok := node.(*ast.IndexExpr)
			if !ok {
				return true
			}
			registryName, ok := lookup.X.(*ast.Ident)
			if !ok || registries[registryName.Name] == nil {
				return true
			}
			statementName := ""
			switch index := lookup.Index.(type) {
			case *ast.BasicLit:
				if index.Kind == token.STRING {
					statementName, _ = strconv.Unquote(index.Value)
				}
			case *ast.Ident:
				statementName = constants[index.Name]
			}
			if statementName != "" && registries[registryName.Name][statementName] == "" {
				t.Errorf("%s lookup names missing generated statement %s", registryName.Name, statementName)
			}
			return true
		})
	}

	for name, statementName := range constants {
		if uses[name] == 1 {
			t.Errorf("%s is declared but never used by Go runtime code", name)
		}
		found := false
		for _, registry := range registries {
			if registry[statementName] != "" {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s names missing generated statement %s", name, statementName)
		}
	}
}

func parseProductionGoFiles(t *testing.T) []*ast.File {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	files := make([]*ast.File, 0, len(entries))
	set := token.NewFileSet()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(set, entry.Name(), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, file)
	}
	return files
}

func TestStatementRegistryMatchesProtocolManifest(t *testing.T) {
	manifest := readProtocolManifest(t)
	want := make(map[string]string, len(manifest.Functions)+len(manifest.Views))
	placeholder := regexp.MustCompile(`\$(\d+)`)

	for _, function := range manifest.Functions {
		addManifestStatement(t, want, function.Name, function.Contract)
		if got := statementArity(protocolStatementRegistry[function.Name], placeholder); got != function.Arity {
			t.Errorf("%s: manifest arity is %d, registered SQL uses %d parameters", function.Name, function.Arity, got)
		}
	}
	for _, view := range manifest.Views {
		addManifestStatement(t, want, view.Name, view.Contract)
	}

	for name, contract := range want {
		if got, ok := protocolStatementRegistry[name]; !ok {
			t.Errorf("manifest statement %s is missing from the registry", name)
		} else if got != contract {
			t.Errorf("%s SQL differs from the manifest\nwant: %s\n got: %s", name, contract, got)
		}
	}
	if got := len(protocolStatementRegistry); got != len(want) {
		t.Errorf("registry has %d protocol statements, manifest has %d", got, len(want))
	}
	if internalStatementRegistry[schemaVersionStatement] == "" {
		t.Error("schema version statement is missing from the internal registry")
	}
	if minimumSchemaVersion != manifest.Schema.MinimumVersion || maximumSchemaVersion != manifest.Schema.MaximumVersion {
		t.Errorf(
			"schema bounds are %d..%d, manifest requires %d..%d",
			minimumSchemaVersion,
			maximumSchemaVersion,
			manifest.Schema.MinimumVersion,
			manifest.Schema.MaximumVersion,
		)
	}
}

func TestProductionSQLLiteralsLiveInStatementRegistry(t *testing.T) {
	nonSQLLiterals := map[string]struct{}{
		"SQL protocol compatibility check refused mutation: %s": {},
		"schema-not-installed":    {},
		"schema-too-old":          {},
		"schema-too-new":          {},
		"client-protocol-too-old": {},
		"client-protocol-too-new": {},
		"42P01":                   {},
		"3F000":                   {},
		"version":                 {},
		// Not SQL: what this client library is, reported to the worker registry so an operator can
		// see which build each worker runs.
		"go":    {},
		"0.1.0": {},
	}
	// admin_protocol.go is hand-written, so pin every non-SQL runtime string rather
	// than exempting the file from the statement-registry check.
	adminProtocolLiterals := map[string]struct{}{
		"":             {},
		"active_slots": {},
		"actor must contain between 1 and 200 characters": {},
		"attempt":                         {},
		"blocked_reason":                  {},
		"cancel_reason":                   {},
		"cancel_requested_at":             {},
		"cancel_requested_by":             {},
		"checkpoint_name":                 {},
		"checkpoint_value":                {},
		"child_job_ids":                   {},
		"claimed_at":                      {},
		"concurrency":                     {},
		"concurrency_key":                 {},
		"context":                         {},
		"contract_version":                {},
		"createdAfter":                    {},
		"createdBefore":                   {},
		"created_at":                      {},
		"current_attempt":                 {},
		"cursor_created_at":               {},
		"cursor_finished_at":              {},
		"cursor_occurred_at":              {},
		"cursor_signature":                {},
		"deadline_at":                     {},
		"default":                         {},
		"deleted_count":                   {},
		"details":                         {},
		"draining":                        {},
		"duration_ms":                     {},
		"error":                           {},
		"errorName":                       {},
		"event_type":                      {},
		"execution_timeout_ms":            {},
		"fence_token":                     {},
		"finishedAfter":                   {},
		"finishedBefore":                  {},
		"finished_at":                     {},
		"get job returned %d rows":        {},
		"get_checkpoint":                  {},
		"get_job":                         {},
		"get_progress":                    {},
		"get_wait":                        {},
		"has_more":                        {},
		"hostname":                        {},
		"id":                              {},
		"include":                         {},
		"instance_id":                     {},
		"job_id":                          {},
		"job_type":                        {},
		"kind":                            {},
		"last_heartbeat_at":               {},
		"limit must be between 1 and %d":  {},
		"list_checkpoints":                {},
		"list_dead_letters":               {},
		"list_human_waits":                {},
		"list_job_timeline":               {},
		"list_jobs":                       {},
		"list_signal_waits":               {},
		"list_waits":                      {},
		"list_workers":                    {},
		"maxBytes":                        {},
		"max_attempts":                    {},
		"mode":                            {},
		"occurred_at":                     {},
		"outcome":                         {},
		"parent_job_id":                   {},
		"paused":                          {},
		"paused_at":                       {},
		"paused_by":                       {},
		"paused_reason":                   {},
		"payload":                         {},
		"payload_bytes":                   {},
		"payload_status":                  {},
		"pid":                             {},
		"prerequisite_job_id":             {},
		"prerequisite_job_ids":            {},
		"priority":                        {},
		"progress_attempt":                {},
		"progress_created_at":             {},
		"progress_fence_token":            {},
		"progress_revision":               {},
		"progress_updated_at":             {},
		"progress_value":                  {},
		"progress_worker_id":              {},
		"purge_queue":                     {},
		"purge_queue_v1 returned %d rows": {},
		"queue":                           {},
		"queue_name":                      {},
		"queue_names":                     {},
		"reason must contain between 1 and 2000 characters": {},
		"record_id":                {},
		"redactKeys":               {},
		"redrive returned %d rows": {},
		"redrive":                  {},
		"redrive_count":            {},
		"redrive_many":             {},
		"request ID must contain between 1 and %d UTF-8 bytes": {},
		"requested_at":                         {},
		"requested_wake_at":                    {},
		"result":                               {},
		"retry_policy":                         {},
		"revision":                             {},
		"run_at":                               {},
		"set_queue_paused":                     {},
		"set_queue_paused_v1 returned %d rows": {},
		"set_worker_paused":                    {},
		"source_finished_at_cursor":            {},
		"source_job_id":                        {},
		"source_state":                         {},
		"started_at":                           {},
		"state":                                {},
		"states":                               {},
		"status":                               {},
		"tags":                                 {},
		"target_job_id":                        {},
		"target_state":                         {},
		"type":                                 {},
		"updated_at":                           {},
		"wait_name":                            {},
		"wake_at":                              {},
		"worker_id":                            {},
		"{}":                                   {},
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") || entry.Name() == "statements.go" || entry.Name() == "sql_catalogue_generated.go" {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), entry.Name(), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		nonRuntimeLiterals := make(map[token.Pos]struct{}, len(file.Imports))
		for _, importSpec := range file.Imports {
			nonRuntimeLiterals[importSpec.Path.Pos()] = struct{}{}
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.Field:
				if node.Tag != nil {
					nonRuntimeLiterals[node.Tag.Pos()] = struct{}{}
				}
				return true
			case *ast.BasicLit:
				if node.Kind != token.STRING {
					return true
				}
				if _, ok := nonRuntimeLiterals[node.Pos()]; ok {
					return true
				}
				value, err := strconv.Unquote(node.Value)
				if err != nil {
					t.Errorf("%s contains an invalid string literal: %s", entry.Name(), node.Value)
					return true
				}
				if _, ok := nonSQLLiterals[value]; ok {
					return true
				}
				if entry.Name() == "admin_protocol.go" {
					if _, ok := adminProtocolLiterals[value]; ok {
						return true
					}
				}
				t.Errorf("%s contains an unclassified production string outside statements.go: %q", entry.Name(), value)
				return true
			}
			return true
		})
	}
}

func readProtocolManifest(t *testing.T) protocolManifest {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("..", "protocol", "v1", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest protocolManifest
	if err := json.Unmarshal(contents, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func addManifestStatement(t *testing.T, statements map[string]string, name string, contract string) {
	t.Helper()
	if _, duplicate := statements[name]; duplicate {
		t.Fatalf("manifest statement %s appears more than once", name)
	}
	statements[name] = contract
}

func statementArity(statement string, placeholder *regexp.Regexp) int {
	maximum := 0
	for _, match := range placeholder.FindAllStringSubmatch(statement, -1) {
		value, err := strconv.Atoi(match[1])
		if err == nil && value > maximum {
			maximum = value
		}
	}
	return maximum
}
