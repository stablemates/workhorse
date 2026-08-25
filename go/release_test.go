package workhorse_test

import (
	"context"
	"encoding/json"
	"fmt"
	"go/version"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestExternalModuleCanImportAndEnqueue(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "module-consumer")
	_, goMod := externalModuleManifest(t, "workhorse-consumer")
	consumerRoot := t.TempDir()
	mainSource := `package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func main() {
	ctx := context.Background()
pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL_TEST"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	tx, err := pool.Begin(ctx)
	if err != nil {
		panic(err)
	}
	defer tx.Rollback(ctx)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "module-consumer")
	maxActivePerKey := 1
	if _, err := queue.SyncConcurrencyPolicies(ctx, "module-consumer", []workhorse.ConcurrencyPolicyDefinition{{
		Queue: "module-consumer", MaxActive: 2, MaxActivePerKey: &maxActivePerKey,
	}}); err != nil {
		panic(err)
	}
	if _, err := queue.ListConcurrencyPolicies(ctx, []string{"module-consumer"}); err != nil {
		panic(err)
	}
	if _, err := queue.SyncRateLimitPolicies(ctx, "module-consumer", []workhorse.RateLimitPolicyDefinition{{
		Queue: "module-consumer", Rate: workhorse.RateLimit{Limit: 10, IntervalMS: 1000, Burst: 10},
	}}); err != nil {
		panic(err)
	}
	if _, err := queue.ListRateLimitPolicies(ctx, []string{"module-consumer"}); err != nil {
		panic(err)
	}
	jobID, err := queue.Enqueue(ctx, "consumer.enqueue", map[string]any{"source": "external-module"})
	if err != nil {
		panic(err)
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	if _, err := admin.GetJob(ctx, jobID); err != nil {
		panic(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "module-consumer",
		WorkerID: "module-consumer",
		PollingOnly: true,
	})
	if err != nil {
		panic(err)
	}
	worker.Handle("consumer.enqueue", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"externalWorker": true}, nil
	})
	processed, err := worker.RunOnce(ctx)
	if err != nil {
		panic(err)
	}
	if !processed {
		panic("external worker did not process its job")
	}
	fmt.Print(jobID)
}
`
	if err := os.WriteFile(filepath.Join(consumerRoot, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(consumerRoot, "main.go"), []byte(mainSource), 0o600); err != nil {
		t.Fatal(err)
	}

	command := exec.Command("go", "run", "-mod=mod", ".")
	command.Dir = consumerRoot
	command.Env = append(os.Environ(), "GOWORK=off", "DATABASE_URL_TEST="+databaseURL)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run external module: %v\n%s", err, output)
	}
	jobID := strings.TrimSpace(string(output))
	if jobID == "" {
		t.Fatal("external module returned an empty job identifier")
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	assertJobCount(t, pool, jobID, 1)
	var state string
	var externalWorker bool
	if err := pool.QueryRow(context.Background(), `SELECT state, (result->>'externalWorker')::boolean
		FROM workhorse.job_outcome WHERE job_id = $1::uuid`, jobID).Scan(&state, &externalWorker); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || !externalWorker {
		t.Fatalf("external worker outcome: state=%s result=%t", state, externalWorker)
	}
}

func TestExamplesCompileAsExternalConsumers(t *testing.T) {
	moduleRoot, goMod := externalModuleManifest(t, "workhorse-examples")
	exampleRoot := filepath.Join(moduleRoot, "examples")
	entries, err := os.ReadDir(exampleRoot)
	if err != nil {
		t.Fatal(err)
	}

	consumerRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(consumerRoot, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatal(err)
	}

	compiled := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		source, err := os.ReadFile(filepath.Join(exampleRoot, entry.Name(), "main.go"))
		if err != nil {
			t.Fatalf("read %s example: %v", entry.Name(), err)
		}
		target := filepath.Join(consumerRoot, entry.Name())
		if err := os.Mkdir(target, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, "main.go"), source, 0o600); err != nil {
			t.Fatal(err)
		}
		compiled++
	}
	if compiled == 0 {
		t.Fatal("go/examples contains no buildable main packages")
	}

	command := exec.Command("go", "build", "-mod=mod", "./...")
	command.Dir = consumerRoot
	command.Env = append(os.Environ(), "GOWORK=off")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build examples as external consumers: %v\n%s", err, output)
	}
}

func TestGoSupportContractMatchesRepositoryDeclarations(t *testing.T) {
	minimumGo, toolchainGo, _ := moduleVersions(t)
	support := readSupportManifest(t)
	if minimumGo != support.Support.Go.Minimum {
		t.Fatalf("go/go.mod minimum %s does not match support.json %s", minimumGo, support.Support.Go.Minimum)
	}
	if toolchainGo != "go"+support.Toolchains.Go {
		t.Fatalf("go/go.mod toolchain %s does not match support.json %s", toolchainGo, support.Toolchains.Go)
	}
	if version.Compare(runtime.Version(), "go"+minimumGo) < 0 {
		t.Fatalf("test lane uses %s below the module minimum Go %s", runtime.Version(), minimumGo)
	}

	postgresMajors := make([]string, len(support.Support.Postgres.Tested))
	for index, major := range support.Support.Postgres.Tested {
		postgresMajors[index] = strconv.Itoa(major)
	}
	if len(postgresMajors) == 0 || support.Support.Postgres.Tested[0] != support.Support.Postgres.Minimum {
		t.Fatalf("PostgreSQL support list %v is not anchored at its declared minimum", postgresMajors)
	}

	databaseURL := os.Getenv("DATABASE_URL_TEST")
	if databaseURL == "" {
		t.Skip("DATABASE_URL_TEST is required to exercise the PostgreSQL support lane")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var versionNumber int
	if err := pool.QueryRow(context.Background(), "SELECT current_setting('server_version_num')::integer").Scan(&versionNumber); err != nil {
		t.Fatal(err)
	}
	serverMajor := strconv.Itoa(versionNumber / 10_000)
	if !contains(postgresMajors, serverMajor) {
		t.Fatalf("test lane uses undeclared PostgreSQL major %s", serverMajor)
	}
}

func externalModuleManifest(t *testing.T, moduleName string) (moduleRoot string, manifest string) {
	t.Helper()
	minimumGo, _, pgxVersion := moduleVersions(t)
	moduleRoot, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	manifest = fmt.Sprintf(`module %s

go %s

require (
	github.com/jackc/pgx/v5 %s
	github.com/stablemates/workhorse/go v0.0.0
)

replace github.com/stablemates/workhorse/go => %s
`, moduleName, minimumGo, pgxVersion, filepath.ToSlash(moduleRoot))
	return moduleRoot, manifest
}

func moduleVersions(t *testing.T) (minimumGo string, toolchainGo string, pgxVersion string) {
	t.Helper()
	goMod := readRepositoryFile(t, "go", "go.mod")
	goMatch := regexp.MustCompile(`(?m)^go ([0-9]+\.[0-9]+\.[0-9]+)$`).FindStringSubmatch(goMod)
	if len(goMatch) != 2 {
		t.Fatal("go/go.mod does not declare a three-part minimum Go version")
	}
	toolchainMatch := regexp.MustCompile(`(?m)^toolchain (go[0-9]+\.[0-9]+\.[0-9]+)$`).FindStringSubmatch(goMod)
	if len(toolchainMatch) != 2 {
		t.Fatal("go/go.mod does not declare a three-part Go toolchain version")
	}
	pgxMatch := regexp.MustCompile(`(?m)^require github\.com/jackc/pgx/v5 (v\S+)$`).FindStringSubmatch(goMod)
	if len(pgxMatch) != 2 {
		t.Fatal("go/go.mod does not declare a direct pgx v5 dependency")
	}
	return goMatch[1], toolchainMatch[1], pgxMatch[1]
}

type supportManifest struct {
	Support struct {
		Go struct {
			Minimum string `json:"minimum"`
		} `json:"go"`
		Postgres struct {
			Minimum int   `json:"minimum"`
			Tested  []int `json:"tested"`
		} `json:"postgres"`
	} `json:"support"`
	Toolchains struct {
		Go string `json:"go"`
	} `json:"toolchains"`
}

func readSupportManifest(t *testing.T) supportManifest {
	t.Helper()
	var manifest supportManifest
	if err := json.Unmarshal([]byte(readRepositoryFile(t, "support.json")), &manifest); err != nil {
		t.Fatalf("parse support.json: %v", err)
	}
	return manifest
}

func readRepositoryFile(t *testing.T, path ...string) string {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(append([]string{".."}, path...)...))
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
