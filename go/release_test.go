package workhorse_test

import (
	"context"
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
	minimumGo, pgxVersion := moduleVersions(t)
	moduleRoot, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	consumerRoot := t.TempDir()

	goMod := fmt.Sprintf(`module workhorse-consumer

go %s

require (
	github.com/jackc/pgx/v5 %s
	github.com/stablemates/workhorse/go v0.0.0
)

replace github.com/stablemates/workhorse/go => %s
`, minimumGo, pgxVersion, filepath.ToSlash(moduleRoot))
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
	pool, err := pgxpool.New(ctx, os.Getenv("WORKHORSE_TEST_DATABASE_URL"))
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
	jobID, err := queue.Enqueue(ctx, "consumer.enqueue", map[string]any{"source": "external-module"})
	if err != nil {
		panic(err)
	}
	if err := tx.Commit(ctx); err != nil {
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
	command.Env = append(os.Environ(), "GOWORK=off", "WORKHORSE_TEST_DATABASE_URL="+databaseURL)
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

func TestGoSupportContractMatchesRepositoryDeclarations(t *testing.T) {
	minimumGo, pgxVersion := moduleVersions(t)
	if version.Compare(runtime.Version(), "go"+minimumGo) < 0 {
		t.Fatalf("test lane uses %s below the module minimum Go %s", runtime.Version(), minimumGo)
	}

	supportSource := readRepositoryFile(t, "typescript", "core", "src", "support.ts")
	postgresMatch := regexp.MustCompile(`SUPPORTED_POSTGRES_MAJORS: readonly number\[\] = \[([^]]+)\]`).FindStringSubmatch(supportSource)
	if len(postgresMatch) != 2 {
		t.Fatal("TypeScript support source does not declare PostgreSQL majors")
	}
	postgresMajors := strings.Split(strings.ReplaceAll(postgresMatch[1], " ", ""), ",")
	minimumPostgres := regexp.MustCompile(`MINIMUM_POSTGRES_MAJOR = ([0-9]+)`).FindStringSubmatch(supportSource)
	if len(minimumPostgres) != 2 || postgresMajors[0] != minimumPostgres[1] {
		t.Fatalf("PostgreSQL support list %q is not anchored at its declared minimum", postgresMatch[1])
	}

	readme := readRepositoryFile(t, "go", "README.md")
	if !strings.Contains(readme, "Go "+strings.TrimSuffix(minimumGo, ".0")+" or newer") {
		t.Fatalf("go/README.md does not name the Go %s minimum", minimumGo)
	}
	if !strings.Contains(readme, "PostgreSQL "+strings.Join(postgresMajors, ", ")) {
		t.Fatalf("go/README.md does not name the tested PostgreSQL majors %v", postgresMajors)
	}
	if !strings.Contains(readme, "pgx "+pgxVersion) {
		t.Fatalf("go/README.md does not name the pinned pgx release %s", pgxVersion)
	}
	packageManifest := readRepositoryFile(t, "package.json")
	if !strings.Contains(packageManifest, `"go:test": "tsx scripts/with-env.ts go -C go test ./..."`) {
		t.Fatal("package.json does not expose the Go support test lane through the worktree environment")
	}
	if !strings.Contains(packageManifest, `"go:test:race": "tsx scripts/with-env.ts go -C go test -race ./..."`) {
		t.Fatal("package.json does not expose the Go race test lane through the worktree environment")
	}

	databaseURL := os.Getenv("WORKHORSE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("WORKHORSE_TEST_DATABASE_URL is required to exercise the PostgreSQL support lane")
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

func moduleVersions(t *testing.T) (minimumGo string, pgxVersion string) {
	t.Helper()
	goMod := readRepositoryFile(t, "go", "go.mod")
	goMatch := regexp.MustCompile(`(?m)^go ([0-9]+\.[0-9]+\.[0-9]+)$`).FindStringSubmatch(goMod)
	if len(goMatch) != 2 {
		t.Fatal("go/go.mod does not declare a three-part minimum Go version")
	}
	pgxMatch := regexp.MustCompile(`(?m)^require github\.com/jackc/pgx/v5 (v\S+)$`).FindStringSubmatch(goMod)
	if len(pgxMatch) != 2 {
		t.Fatal("go/go.mod does not declare a direct pgx v5 dependency")
	}
	return goMatch[1], pgxMatch[1]
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
