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
	}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") || entry.Name() == "statements.go" || entry.Name() == "sql_catalogue_generated.go" || entry.Name() == "admin_protocol.go" {
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
				if _, ok := nonSQLLiterals[value]; !ok {
					t.Errorf("%s contains an unclassified production string outside statements.go: %q", entry.Name(), value)
				}
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
