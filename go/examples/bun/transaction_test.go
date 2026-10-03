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
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

type queryRecorder struct {
	mutex   sync.Mutex
	queries []string
}

func (recorder *queryRecorder) BeforeQuery(ctx context.Context, event *bun.QueryEvent) context.Context {
	recorder.mutex.Lock()
	defer recorder.mutex.Unlock()
	recorder.queries = append(recorder.queries, event.Query)
	return ctx
}

func (recorder *queryRecorder) AfterQuery(context.Context, *bun.QueryEvent) {}

func (recorder *queryRecorder) count() int {
	recorder.mutex.Lock()
	defer recorder.mutex.Unlock()
	return len(recorder.queries)
}

func bunFixture(t *testing.T) (*bun.DB, *sql.DB, *queryRecorder, string) {
	t.Helper()
	if testing.Short() {
		t.Skip("Bun PostgreSQL fixture does not run in short mode")
	}
	sourceURL := os.Getenv("DATABASE_URL_TEST")
	if sourceURL == "" {
		if os.Getenv("WORKHORSE_REQUIRE_DATABASE") == "1" {
			t.Fatal("DATABASE_URL_TEST is required for the Bun PostgreSQL fixture")
		}
		t.Skip("DATABASE_URL_TEST is required for the Bun PostgreSQL fixture")
	}
	parsed, err := url.Parse(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	sourceName := strings.TrimPrefix(parsed.Path, "/")
	if (parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "::1") || !strings.Contains(sourceName, "test") {
		t.Fatal("Bun fixture requires a loopback test database")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s:%d", t.Name(), os.Getpid()))))[:10]
	if len(sourceName) > 44 {
		sourceName = sourceName[:44]
	}
	name := sourceName + "_bun_" + digest
	adminURL := *parsed
	adminURL.Path = "/postgres"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	quotedName := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quotedName); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		admin, err := pgx.Connect(ctx, adminURL.String())
		if err != nil {
			t.Error(err)
			return
		}
		defer admin.Close(ctx)
		if _, err := admin.Exec(ctx, "DROP DATABASE "+quotedName); err != nil {
			t.Error(err)
		}
	})
	parsed.Path = "/" + name
	databaseURL := parsed.String()
	connection, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(ctx)
	schema, err := os.ReadFile(filepath.Join("..", "..", "..", "sql", "schema", "current.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(ctx); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(1)
	db := bun.NewDB(database, pgdialect.New())
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.NewCreateTable().Model((*order)(nil)).Exec(ctx); err != nil {
		t.Fatal(err)
	}
	observer, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	observer.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = observer.Close() })
	recorder := &queryRecorder{}
	db.AddQueryHook(recorder)
	var version string
	if err := observer.QueryRowContext(ctx, "SHOW server_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	t.Logf("Bun v1.2.18 / pgdialect v1.2.18 / pgx stdlib v5.11.0 / PostgreSQL %s", version)
	return db, observer, recorder, databaseURL
}

func newOrder() *order {
	return &order{ID: uuid.NewString(), Customer: `O'Reilly ? $1 \\ 世界`, Receipt: json.RawMessage(`{"nested":{"quote":"'?$2"},"values":[1,true,null]}`)}
}

func assertVisible(t *testing.T, observer *sql.DB, orders, tasks int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var actualOrders, actualTasks int
	if err := observer.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM bun_order), (SELECT count(*) FROM workhorse.task)").Scan(&actualOrders, &actualTasks); err != nil {
		t.Fatal(err)
	}
	if actualOrders != orders || actualTasks != tasks {
		t.Fatalf("observer sees orders/tasks %d/%d, want %d/%d", actualOrders, actualTasks, orders, tasks)
	}
}

func TestBunJointCommitRollbackAndIdentity(t *testing.T) {
	for _, commit := range []bool{true, false} {
		t.Run(fmt.Sprintf("commit=%t", commit), func(t *testing.T) {
			db, observer, recorder, _ := bunFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			rollback := errors.New("application rejected order")
			var expired workhorse.Executor
			accepted := newOrder()
			err := db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
				expired = workhorse.NewSQLExecutor(tx.Tx)
				var backend, observerBackend int
				var transactionID int64
				if err := tx.Tx.QueryRowContext(ctx, "SELECT pg_backend_pid(), txid_current()").Scan(&backend, &transactionID); err != nil {
					return err
				}
				if err := observer.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&observerBackend); err != nil {
					return err
				}
				if backend == observerBackend {
					t.Fatal("observer shares the transaction connection")
				}
				result, err := acceptOrder(ctx, tx, accepted, workhorse.EnqueueOptions{})
				if err != nil {
					return err
				}
				if _, err := uuid.Parse(result.TaskID); err != nil || result.Outcome != workhorse.EnqueueAccepted {
					t.Fatalf("enqueue result: %+v, UUID error: %v", result, err)
				}
				var sameBackend int
				var sameTransaction, businessXmin, taskXmin int64
				if err := tx.Tx.QueryRowContext(ctx, `SELECT pg_backend_pid(), txid_current(),
					(SELECT xmin::text::bigint FROM bun_order WHERE id = $1::uuid),
					(SELECT xmin::text::bigint FROM workhorse.task WHERE id = $2::uuid)`, accepted.ID, result.TaskID).Scan(&sameBackend, &sameTransaction, &businessXmin, &taskXmin); err != nil {
					return err
				}
				if sameBackend != backend || sameTransaction != transactionID || businessXmin != transactionID%(1<<32) || taskXmin != businessXmin {
					t.Fatalf("physical transaction mismatch: backend %d/%d tx %d/%d xmin %d/%d", backend, sameBackend, transactionID, sameTransaction, businessXmin, taskXmin)
				}
				if db.DB.Stats().InUse != 1 || recorder.count() != 2 {
					t.Fatalf("expected sole held connection and only Bun BEGIN/INSERT hooks, stats=%+v hooks=%d", db.DB.Stats(), recorder.count())
				}
				assertVisible(t, observer, 0, 0)
				if !commit {
					return rollback
				}
				return nil
			})
			if commit && err != nil || !commit && !errors.Is(err, rollback) {
				t.Fatal(err)
			}
			visible := 0
			if commit {
				visible = 1
			}
			assertVisible(t, observer, visible, visible)
			if _, err := expired.Query(ctx, "SELECT 1"); !errors.Is(err, sql.ErrTxDone) {
				t.Fatalf("ended transaction remains usable: %v", err)
			}
			if err := db.PingContext(ctx); err != nil {
				t.Fatalf("caller pool was closed: %v", err)
			}
		})
	}
}

func TestBunNestedSavepoints(t *testing.T) {
	for _, outerCommit := range []bool{true, false} {
		t.Run(fmt.Sprintf("outerCommit=%t", outerCommit), func(t *testing.T) {
			db, observer, _, _ := bunFixture(t)
			ctx := context.Background()
			rollback := errors.New("rollback savepoint")
			err := db.RunInTx(ctx, nil, func(ctx context.Context, outer bun.Tx) error {
				if _, err := acceptOrder(ctx, outer, newOrder(), workhorse.EnqueueOptions{}); err != nil {
					return err
				}
				for _, nestedCommit := range []bool{false, true} {
					err := outer.RunInTx(ctx, nil, func(ctx context.Context, nested bun.Tx) error {
						if nested.Tx != outer.Tx {
							t.Fatal("savepoint acquired a different physical transaction")
						}
						if _, err := acceptOrder(ctx, nested, newOrder(), workhorse.EnqueueOptions{}); err != nil {
							return err
						}
						assertVisible(t, observer, 0, 0)
						if !nestedCommit {
							return rollback
						}
						return nil
					})
					if nestedCommit && err != nil || !nestedCommit && !errors.Is(err, rollback) {
						return err
					}
				}
				assertVisible(t, observer, 0, 0)
				var orders, tasks int
				if err := outer.Tx.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM bun_order), (SELECT count(*) FROM workhorse.task)").Scan(&orders, &tasks); err != nil {
					return err
				}
				if orders != 2 || tasks != 2 {
					t.Fatalf("savepoint rollback leaked: %d/%d", orders, tasks)
				}
				if !outerCommit {
					return rollback
				}
				return nil
			})
			if outerCommit && err != nil || !outerCommit && !errors.Is(err, rollback) {
				t.Fatal(err)
			}
			visible := 0
			if outerCommit {
				visible = 2
			}
			assertVisible(t, observer, visible, visible)
		})
	}
}

func TestBunNativeBindingsBatchResultsAndHooks(t *testing.T) {
	db, observer, recorder, _ := bunFixture(t)
	ctx := context.Background()
	runAt := time.Date(2030, 4, 5, 6, 7, 8, 123456000, time.UTC)
	deadline := runAt.Add(time.Hour)
	tags := []string{"orders", "世界"}
	accepted := newOrder()
	err := db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		executor := workhorse.NewSQLExecutor(tx.Tx)
		hooks := recorder.count()
		rows, err := executor.Query(ctx, `SELECT $4::uuid AS id, $1::jsonb AS payload,
			to_jsonb($2::text[]) AS tags, $3::timestamptz AS scheduled, '?'::text AS literal,
			$4::uuid AS repeated, NULL::text AS nullable`, []byte(accepted.Receipt), tags, runAt, accepted.ID)
		if err != nil {
			return err
		}
		if len(rows) != 1 || rows[0]["id"] != accepted.ID || rows[0]["repeated"] != accepted.ID || rows[0]["literal"] != "?" || rows[0]["nullable"] != nil {
			t.Fatalf("native result columns: %#v", rows)
		}
		if scheduled, ok := rows[0]["scheduled"].(time.Time); !ok || !scheduled.Equal(runAt) {
			t.Fatalf("timestamp result: %#v", rows[0]["scheduled"])
		}
		var actualTags []string
		if err := json.Unmarshal(rows[0]["tags"].([]byte), &actualTags); err != nil || !reflect.DeepEqual(actualTags, tags) {
			t.Fatalf("array binding: %#v, %v", actualTags, err)
		}
		var payload map[string]any
		if err := json.Unmarshal(rows[0]["payload"].([]byte), &payload); err != nil || payload["nested"].(map[string]any)["quote"] != "'?$2" {
			t.Fatalf("JSONB binding: %#v, %v", payload, err)
		}
		empty, err := executor.Query(ctx, "SELECT 1 WHERE false")
		if err != nil || len(empty) != 0 || recorder.count() != hooks {
			t.Fatalf("raw executor invokes Bun hooks or changes empty results: %#v, %v", empty, err)
		}
		result, err := acceptOrder(ctx, tx, accepted, workhorse.EnqueueOptions{Tags: tags, RunAt: &runAt, Deadline: &deadline})
		if err != nil {
			return err
		}
		var receipt, taskReceipt, storedTags []byte
		var customer string
		var storedRunAt, storedDeadline time.Time
		if err := tx.Tx.QueryRowContext(ctx, `SELECT o.receipt, t.payload->'receipt', r.run_at, t.deadline_at,
			to_jsonb(t.tags), t.payload->>'customer'
			FROM bun_order o JOIN workhorse.task t ON t.payload->>'orderId' = o.id::text
			JOIN workhorse.task_runtime r ON r.task_id = t.id WHERE t.id = $1::uuid`, result.TaskID).Scan(&receipt, &taskReceipt, &storedRunAt, &storedDeadline, &storedTags, &customer); err != nil {
			return err
		}
		if err := json.Unmarshal(storedTags, &actualTags); err != nil || !reflect.DeepEqual(actualTags, tags) || customer != accepted.Customer {
			t.Fatalf("task tags/customer changed: %s/%q, %v", storedTags, customer, err)
		}
		if string(receipt) != string(taskReceipt) || !storedRunAt.Equal(runAt.Truncate(time.Millisecond)) || !storedDeadline.Equal(deadline.Truncate(time.Millisecond)) {
			t.Fatalf("enqueue native values changed: %s/%s %v/%v", receipt, taskReceipt, storedRunAt, storedDeadline)
		}
		queue := workhorse.NewQueue(executor, "orders")
		request := workhorse.EnqueueRequest{Type: "order.batch", Payload: map[string]any{"orderId": accepted.ID}, Options: workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: accepted.ID, Scope: "bun", TTLMS: 60000}}}
		results, err := queue.EnqueueManyWithResults(ctx, []workhorse.EnqueueRequest{request, request})
		if err != nil {
			return err
		}
		if len(results) != 2 || results[0].Outcome != workhorse.EnqueueAccepted || results[1].Outcome != workhorse.EnqueueReplayed || results[0].TaskID != results[1].TaskID {
			t.Fatalf("batch ordered canonical results: %+v", results)
		}
		assertVisible(t, observer, 0, 0)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	assertVisible(t, observer, 1, 2)
}

func TestBunStructuredErrorsAndSavepointRecovery(t *testing.T) {
	db, observer, _, _ := bunFixture(t)
	ctx := context.Background()
	err := db.RunInTx(ctx, nil, func(ctx context.Context, outer bun.Tx) error {
		accepted := newOrder()
		if _, err := acceptOrder(ctx, outer, accepted, workhorse.EnqueueOptions{}); err != nil {
			return err
		}
		err := outer.RunInTx(ctx, nil, func(ctx context.Context, nested bun.Tx) error {
			_, err := acceptOrder(ctx, nested, accepted, workhorse.EnqueueOptions{})
			return err
		})
		var postgresError *pgconn.PgError
		if !errors.As(err, &postgresError) || postgresError.Code != "23505" || postgresError.TableName != "bun_order" || postgresError.ConstraintName != "bun_order_pkey" {
			t.Fatalf("business error lost structure: %v", err)
		}
		err = outer.RunInTx(ctx, nil, func(ctx context.Context, nested bun.Tx) error {
			_, err := workhorse.NewSQLExecutor(nested.Tx).Query(ctx, "SELECT 1 / $1::integer", 0)
			return err
		})
		if !errors.As(err, &postgresError) || postgresError.Code != "22012" {
			t.Fatalf("executor error lost SQLSTATE: %v", err)
		}
		err = outer.RunInTx(ctx, nil, func(ctx context.Context, nested bun.Tx) error {
			_, err := workhorse.NewSQLExecutor(nested).Query(ctx, "SELECT $1::text", "must stay bound")
			return err
		})
		if err == nil {
			t.Fatal("unsafe Bun wrapper unexpectedly preserved native arguments")
		}
		err = outer.RunInTx(ctx, nil, func(ctx context.Context, nested bun.Tx) error {
			queue := workhorse.NewQueue(workhorse.NewSQLExecutor(nested.Tx), "orders")
			options := workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "conflict", Scope: "bun", TTLMS: 60000}}
			if _, err := queue.Enqueue(ctx, "order.conflict", map[string]any{"value": 1}, options); err != nil {
				return err
			}
			_, err := queue.Enqueue(ctx, "order.conflict", map[string]any{"value": 2}, options)
			return err
		})
		var conflict *workhorse.EnqueueIdempotencyConflictError
		if !errors.Is(err, workhorse.ErrEnqueueIdempotencyConflict) || !errors.As(err, &conflict) {
			t.Fatalf("Workhorse structured enqueue conflict lost: %v", err)
		}
		if conflict.Details.Scope != "bun" || conflict.Details.KeyLength != len("conflict") || conflict.Details.KeyPreview == "" || conflict.Details.ExistingTaskID == "" || !reflect.DeepEqual(conflict.Details.ConflictingFields, []string{"payload"}) {
			t.Fatalf("Workhorse conflict details changed: %+v", conflict.Details)
		}
		if _, err := acceptOrder(ctx, outer, newOrder(), workhorse.EnqueueOptions{}); err != nil {
			return err
		}
		assertVisible(t, observer, 0, 0)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	assertVisible(t, observer, 2, 2)
}

func TestBunCancellationRollsBackAndLeavesPoolOwned(t *testing.T) {
	db, observer, _, _ := bunFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := acceptOrder(ctx, tx, newOrder(), workhorse.EnqueueOptions{}); err != nil {
			return err
		}
		assertVisible(t, observer, 0, 0)
		cancel()
		_, err := workhorse.NewQueue(workhorse.NewSQLExecutor(tx.Tx), "orders").Enqueue(ctx, "order.cancelled", nil)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	assertVisible(t, observer, 0, 0)
	if err := db.PingContext(context.Background()); err != nil {
		t.Fatalf("cancellation closed caller pool: %v", err)
	}
}

func TestBunRunnableRecipe(t *testing.T) {
	_, observer, _, databaseURL := bunFixture(t)
	taskID, err := run(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uuid.Parse(taskID); err != nil {
		t.Fatal(err)
	}
	assertVisible(t, observer, 1, 1)
}

func TestBunInFlightCancellation(t *testing.T) {
	db, observer, _, _ := bunFixture(t)
	err := db.RunInTx(context.Background(), nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := acceptOrder(ctx, tx, newOrder(), workhorse.EnqueueOptions{}); err != nil {
			return err
		}
		assertVisible(t, observer, 0, 0)
		queryContext, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
		defer cancel()
		_, err := workhorse.NewSQLExecutor(tx.Tx).Query(queryContext, "SELECT pg_sleep($1::double precision)", 10)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("in-flight cancellation lost: %v", err)
		}
		return err
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	assertVisible(t, observer, 0, 0)
	if err := db.PingContext(context.Background()); err != nil {
		t.Fatalf("in-flight cancellation closed caller pool: %v", err)
	}
}
