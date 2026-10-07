package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	workhorse "github.com/stablemates/workhorse/go"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestGORMTransactions(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	sourceURL := os.Getenv("DATABASE_URL_TEST")
	if sourceURL == "" {
		if os.Getenv("WORKHORSE_REQUIRE_DATABASE") == "1" {
			t.Fatal("DATABASE_URL_TEST is required")
		}
		t.Skip("DATABASE_URL_TEST is not set")
	}
	for _, prepared := range []bool{false, true} {
		t.Run(fmt.Sprintf("PrepareStmt=%t", prepared), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			databaseURL := scratchDatabase(t, ctx, sourceURL)
			db, err := gorm.Open(postgres.Open(databaseURL), &gorm.Config{
				PrepareStmt: prepared, Logger: logger.Default.LogMode(logger.Silent),
			})
			if err != nil {
				t.Fatal(err)
			}
			pool, err := db.DB()
			if err != nil {
				t.Fatal(err)
			}
			pool.SetMaxOpenConns(1)
			t.Cleanup(func() { _ = pool.Close() })
			observer, err := pgx.Connect(ctx, databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = observer.Close(context.Background()) })
			var version string
			if err := observer.QueryRow(ctx, "SHOW server_version").Scan(&version); err != nil {
				t.Fatal(err)
			}
			t.Logf("PostgreSQL %s; GORM v1.31.2; postgres dialector v1.6.3; pgx v5.11.0", version)
			if _, err := observer.Exec(ctx, `CREATE TABLE orders (
				id text PRIMARY KEY, email text NOT NULL,
				backend_pid integer NOT NULL DEFAULT pg_backend_pid(),
				transaction_id bigint NOT NULL DEFAULT txid_current()
			)`); err != nil {
				t.Fatal(err)
			}

			t.Run("identity_invisibility_joint_commit", func(t *testing.T) {
				err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
					assertTransactionPool(t, tx, prepared)
					taskID, err := acceptOrder(ctx, tx, Order{ID: "commit", Email: "commit@example.com"})
					if err != nil {
						return err
					}
					if _, err := uuid.Parse(taskID); err != nil {
						t.Fatalf("task ID: %v", err)
					}
					executor := workhorse.NewSQLExecutor(tx.Statement.ConnPool)
					rows, err := executor.Query(ctx, `SELECT pg_backend_pid() AS backend_pid,
						txid_current() AS transaction_id, orders.backend_pid AS business_pid,
						orders.transaction_id AS business_xid, task.xmin::text::bigint AS task_xid
						FROM orders JOIN workhorse.task task ON task.id = $1::uuid WHERE orders.id = $2`, taskID, "commit")
					if err != nil {
						return err
					}
					if len(rows) != 1 || rows[0]["backend_pid"] != rows[0]["business_pid"] ||
						rows[0]["transaction_id"] != rows[0]["business_xid"] ||
						rows[0]["transaction_id"] != rows[0]["task_xid"] {
						t.Fatalf("physical transaction mismatch: %#v", rows)
					}
					var observerPID int64
					if err := observer.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&observerPID); err != nil {
						return err
					}
					if observerPID == rows[0]["backend_pid"] {
						t.Fatal("observer shares the transaction connection")
					}
					assertVisible(t, ctx, observer, "commit", 0)
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				assertVisible(t, ctx, observer, "commit", 1)
			})

			t.Run("callback_rollback", func(t *testing.T) {
				rejected := errors.New("application rejected transaction")
				err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
					if _, err := acceptOrder(ctx, tx, Order{ID: "rollback", Email: "rollback@example.com"}); err != nil {
						return err
					}
					assertVisible(t, ctx, observer, "rollback", 0)
					return rejected
				})
				if !errors.Is(err, rejected) {
					t.Fatalf("callback error = %v", err)
				}
				assertVisible(t, ctx, observer, "rollback", 0)
			})

			t.Run("nested_savepoint", func(t *testing.T) {
				rejected := errors.New("roll back inner savepoint")
				err := db.WithContext(ctx).Transaction(func(outer *gorm.DB) error {
					if _, err := acceptOrder(ctx, outer, Order{ID: "outer", Email: "outer@example.com"}); err != nil {
						return err
					}
					innerErr := outer.Transaction(func(inner *gorm.DB) error {
						if _, err := acceptOrder(ctx, inner, Order{ID: "inner", Email: "inner@example.com"}); err != nil {
							return err
						}
						return rejected
					})
					if !errors.Is(innerErr, rejected) {
						return fmt.Errorf("nested error: %w", innerErr)
					}
					assertVisible(t, ctx, observer, "outer", 0)
					assertVisible(t, ctx, observer, "inner", 0)
					_, err := acceptOrder(ctx, outer, Order{ID: "after-inner", Email: "outer@example.com"})
					return err
				})
				if err != nil {
					t.Fatal(err)
				}
				assertVisible(t, ctx, observer, "outer", 1)
				assertVisible(t, ctx, observer, "after-inner", 1)
				assertVisible(t, ctx, observer, "inner", 0)
			})

			t.Run("cancellation", func(t *testing.T) {
				cancelled, stop := context.WithCancel(ctx)
				defer stop()
				err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
					if err := tx.Create(&Order{ID: "cancel", Email: "cancel@example.com"}).Error; err != nil {
						return err
					}
					queue := workhorse.NewQueue(workhorse.NewSQLExecutor(tx.Statement.ConnPool), "orders")
					stop()
					_, err := queue.Enqueue(cancelled, "order.accepted", map[string]any{"orderId": "cancel"})
					return err
				})
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("enqueue cancellation = %v", err)
				}
				assertVisible(t, ctx, observer, "cancel", 0)
			})

			t.Run("recipe_returns_enqueue_failure", func(t *testing.T) {
				queue := workhorse.NewQueue(workhorse.NewSQLExecutor(db.Statement.ConnPool), "orders")
				if err := queue.SyncContracts(ctx, map[string]workhorse.TaskTypeContracts{
					"order.accepted": {CurrentVersion: "1", Versions: map[string]workhorse.TaskContractVersion{
						"1": {PayloadSchema: map[string]any{
							"type": "object", "required": []any{"orderId"},
							"properties": map[string]any{"orderId": map[string]any{"type": "string", "minLength": 8}},
						}},
					}},
				}); err != nil {
					t.Fatal(err)
				}
				taskID, err := createOrder(ctx, db, Order{ID: "short", Email: "short@example.com"})
				var validation *workhorse.TaskContractValidationError
				if !errors.As(err, &validation) || taskID != "" {
					t.Fatalf("recipe error = %v, ID = %q", err, taskID)
				}
				assertVisible(t, ctx, observer, "short", 0)
				if _, err := createOrder(ctx, db, Order{ID: "valid-order", Email: "valid@example.com"}); err != nil {
					t.Fatal(err)
				}
				assertVisible(t, ctx, observer, "valid-order", 1)
			})

			t.Run("inflight_cancellation", func(t *testing.T) {
				blocker, err := observer.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(ctx) }()
				if _, err := blocker.Exec(ctx, "LOCK TABLE workhorse.task IN ACCESS EXCLUSIVE MODE"); err != nil {
					t.Fatal(err)
				}
				err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
					if err := tx.Create(&Order{ID: "inflight", Email: "cancel@example.com"}).Error; err != nil {
						return err
					}
					queue := workhorse.NewQueue(workhorse.NewSQLExecutor(tx.Statement.ConnPool), "orders")
					deadline, stop := context.WithTimeout(ctx, 150*time.Millisecond)
					defer stop()
					_, err := queue.Enqueue(deadline, "gorm.cancel", map[string]any{"orderId": "inflight"})
					if !errors.Is(deadline.Err(), context.DeadlineExceeded) {
						t.Fatalf("query did not wait for cancellation: %v", err)
					}
					return err
				})
				var databaseError *pgconn.PgError
				if !errors.Is(err, context.DeadlineExceeded) && (!errors.As(err, &databaseError) || databaseError.Code != "57014") {
					t.Fatalf("inflight cancellation = %v", err)
				}
				if err := blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				assertVisible(t, ctx, observer, "inflight", 0)
			})

			t.Run("bind_decode_order_sqlstate_ownership", func(t *testing.T) {
				var guard *queryGuard
				modelCallbacks := 0
				if err := db.Callback().Create().After("gorm:create").Register("gorm_recipe_count", func(*gorm.DB) {
					modelCallbacks++
				}); err != nil {
					t.Fatal(err)
				}
				err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
					if err := tx.Create(&Order{ID: "ownership", Email: "owner@example.com"}).Error; err != nil {
						return err
					}
					guard = &queryGuard{ConnPool: tx.Statement.ConnPool}
					executor := workhorse.NewSQLExecutor(guard)
					queue := workhorse.NewQueue(executor, "gorm-batch")
					if _, err := queue.Enqueue(ctx, "gorm.owner", map[string]any{"orderId": "ownership"}); err != nil {
						return err
					}
					requests := []workhorse.EnqueueRequest{
						{Type: "gorm.bind", Payload: map[string]any{"index": 0, "nested": map[string]any{"unicode": "雪", "null": nil}}},
						{Type: "gorm.bind", Payload: map[string]any{"index": 1}},
						{Type: "gorm.bind", Payload: map[string]any{"index": 2}},
					}
					results, err := queue.EnqueueManyWithResults(ctx, requests)
					if err != nil {
						return err
					}
					if len(results) != len(requests) {
						t.Fatalf("results = %#v", results)
					}
					for index, result := range results {
						if _, err := uuid.Parse(result.TaskID); err != nil || result.Outcome != workhorse.EnqueueAccepted || result.Reason != nil {
							t.Fatalf("result %d: %#v, %v", index, result, err)
						}
						rows, err := executor.Query(ctx, "SELECT payload FROM workhorse.task WHERE id = $1::uuid", result.TaskID)
						if err != nil {
							return err
						}
						encoded, err := json.Marshal(requests[index].Payload)
						if err != nil {
							return err
						}
						var expected, actual any
						if err := json.Unmarshal(encoded, &expected); err != nil {
							return err
						}
						if len(rows) != 1 {
							t.Fatalf("payload rows = %#v", rows)
						}
						payload, ok := rows[0]["payload"].([]byte)
						if !ok {
							t.Fatalf("JSONB decoded as %T", rows[0]["payload"])
						}
						if err := json.Unmarshal(payload, &actual); err != nil {
							return err
						}
						if !reflect.DeepEqual(expected, actual) {
							t.Fatalf("ordered payload %d = %#v, want %#v", index, actual, expected)
						}
					}
					options := workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "gorm-key"}}
					first, err := queue.EnqueueWithResult(ctx, "gorm.bind", map[string]any{"value": "first"}, options)
					if err != nil {
						return err
					}
					second, err := queue.EnqueueWithResult(ctx, "gorm.bind", map[string]any{"value": "first"}, options)
					if err != nil || first.TaskID != second.TaskID || second.Outcome != workhorse.EnqueueReplayed {
						return fmt.Errorf("replay = %#v: %w", second, err)
					}
					retained, err := queue.EnqueueWithResult(ctx, "gorm.bind", map[string]any{"value": "different"}, workhorse.EnqueueOptions{
						Debounce: &workhorse.Debounce{Key: "gorm-key", WindowMS: 60000, Schedule: workhorse.DebounceReset},
					})
					if err != nil {
						return err
					}
					if retained.TaskID != first.TaskID || retained.Outcome != workhorse.EnqueueNonReplaceable ||
						retained.Reason == nil || *retained.Reason != workhorse.NonReplaceableIncompatibleKeyMode {
						t.Fatalf("non-null reason = %#v", retained)
					}
					if err := tx.SavePoint("before_conflict").Error; err != nil {
						return err
					}
					_, err = queue.Enqueue(ctx, "gorm.bind", map[string]any{"value": "different"}, options)
					var conflict *workhorse.EnqueueIdempotencyConflictError
					if !errors.As(err, &conflict) || !errors.Is(err, workhorse.ErrEnqueueIdempotencyConflict) || conflict.Details.KeyLength != len("gorm-key") || conflict.Details.ExistingTaskID != first.TaskID {
						t.Fatalf("structured protocol conflict = %#v, %v", conflict, err)
					}
					if guard.lastError == nil || guard.lastError.Code != "P1001" || guard.lastError.Detail == "" {
						t.Fatalf("driver SQLSTATE = %#v", guard.lastError)
					}
					if err := tx.RollbackTo("before_conflict").Error; err != nil {
						return err
					}
					_, err = executor.Query(ctx, "SELECT 1 / 0")
					var databaseError *pgconn.PgError
					if !errors.As(err, &databaseError) || databaseError.SQLState() != "22012" {
						t.Fatalf("raw SQLSTATE = %v", err)
					}
					if err := tx.RollbackTo("before_conflict").Error; err != nil {
						return err
					}
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				if guard.lifecycleCalls != 0 || guard.queryCalls == 0 {
					t.Fatalf("executor lifecycle calls = %d, queries = %d", guard.lifecycleCalls, guard.queryCalls)
				}
				if modelCallbacks != 1 {
					t.Fatalf("model callbacks = %d, want only the business Create", modelCallbacks)
				}
				assertVisible(t, ctx, observer, "ownership", 1)
				if err := pool.PingContext(ctx); err != nil {
					t.Fatalf("caller-owned pool no longer usable: %v", err)
				}
			})
			if prepared {
				t.Run("runnable_command", func(t *testing.T) {
					command := exec.CommandContext(ctx, "go", "run", ".", "command-order", "command@example.com")
					for _, variable := range os.Environ() {
						if !strings.HasPrefix(variable, "WORKHORSE_DATABASE_URL=") {
							command.Env = append(command.Env, variable)
						}
					}
					command.Env = append(command.Env, "WORKHORSE_DATABASE_URL="+databaseURL)
					output, err := command.CombinedOutput()
					if err != nil {
						t.Fatalf("example command: %v\n%s", err, output)
					}
					if _, err := uuid.Parse(strings.TrimSpace(string(output))); err != nil {
						t.Fatalf("example output: %s (%v)", output, err)
					}
					assertVisible(t, ctx, observer, "command-order", 1)
				})
			}
		})
	}
}

func assertTransactionPool(t *testing.T, tx *gorm.DB, prepared bool) {
	t.Helper()
	if prepared {
		if _, ok := tx.Statement.ConnPool.(*gorm.PreparedStmtTX); !ok {
			t.Fatalf("prepared transaction pool = %T", tx.Statement.ConnPool)
		}
	} else if _, ok := tx.Statement.ConnPool.(*sql.Tx); !ok {
		t.Fatalf("transaction pool = %T", tx.Statement.ConnPool)
	}
}

func assertVisible(t *testing.T, ctx context.Context, observer *pgx.Conn, orderID string, expected int) {
	t.Helper()
	var orders, tasks int
	if err := observer.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM orders WHERE id = $1),
		(SELECT count(*) FROM workhorse.task WHERE payload->>'orderId' = $1)`, orderID).Scan(&orders, &tasks); err != nil {
		t.Fatal(err)
	}
	if orders != expected || tasks != expected {
		t.Fatalf("%s: observer sees %d orders, %d tasks; want %d each", orderID, orders, tasks, expected)
	}
}

type queryGuard struct {
	gorm.ConnPool
	lifecycleCalls int
	queryCalls     int
	lastError      *pgconn.PgError
}

func (guard *queryGuard) QueryContext(ctx context.Context, statement string, arguments ...any) (*sql.Rows, error) {
	guard.queryCalls++
	rows, err := guard.ConnPool.QueryContext(ctx, statement, arguments...)
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		guard.lastError = databaseError
	}
	return rows, err
}

func (guard *queryGuard) BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error) {
	guard.lifecycleCalls++
	return nil, errors.New("executor must not begin a transaction")
}

func (guard *queryGuard) Commit() error {
	guard.lifecycleCalls++
	return errors.New("executor must not commit")
}

func (guard *queryGuard) Rollback() error {
	guard.lifecycleCalls++
	return errors.New("executor must not roll back")
}

func (guard *queryGuard) Close() error {
	guard.lifecycleCalls++
	return errors.New("executor must not close")
}

func scratchDatabase(t *testing.T, ctx context.Context, sourceURL string) string {
	t.Helper()
	parsed, err := url.Parse(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	host := parsed.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		t.Fatalf("GORM tests refuse non-loopback database host %q", host)
	}
	sourceName := strings.TrimPrefix(parsed.Path, "/")
	if !strings.Contains(sourceName, "test") {
		t.Fatal("DATABASE_URL_TEST must name a test database")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(t.Name()+strconv.Itoa(os.Getpid()))))[:10]
	prefix := sourceName
	if len(prefix) > 44 {
		prefix = prefix[:44]
	}
	databaseName := prefix + "_gorm_" + digest
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	quotedName := pgx.Identifier{databaseName}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quotedName); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	if err := admin.Close(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		admin, err := pgx.Connect(cleanup, adminURL.String())
		if err != nil {
			t.Errorf("connect for GORM database cleanup: %v", err)
			return
		}
		defer func() { _ = admin.Close(cleanup) }()
		if err := dropScratchDatabase(cleanup, admin, databaseName); err != nil {
			t.Errorf("drop GORM scratch database: %v; run pnpm db:sweep", err)
		}
	})
	databaseURL := *parsed
	databaseURL.Path = "/" + databaseName
	schema, err := os.ReadFile(filepath.Join("..", "..", "..", "sql", "schema", "current.sql"))
	if err != nil {
		t.Fatal(err)
	}
	connection, err := pgx.Connect(ctx, databaseURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connection.Close(ctx) }()
	if _, err := connection.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	return databaseURL.String()
}
