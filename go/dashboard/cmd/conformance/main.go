// Command conformance exposes the Go dashboard backend to the shared HTTP fixture runner.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/dashboard"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	config, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	config.AfterConnect = func(ctx context.Context, connection *pgx.Conn) error {
		_, err := connection.Exec(ctx, "SET TIME ZONE 'UTC'")
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		panic(err)
	}
	defer pool.Close()
	sqlDatabase, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer sqlDatabase.Close()
	harness := func(executor workhorse.Executor, readOnly bool) http.Handler {
		procedures := map[string]dashboard.Procedure{}
		if !readOnly {
			queue := workhorse.NewQueue(executor, "conformance-demo")
			procedures["enqueueTest"] = func(ctx context.Context, input any, _ string) (any, error) {
				value := input.(map[string]any)
				priority := 0
				fmt.Sscan(fmt.Sprint(value["priority"]), &priority)
				id, err := queue.Enqueue(ctx, "conformance.demo-"+fmt.Sprint(value["kind"]), map[string]any{}, workhorse.EnqueueOptions{Priority: priority})
				return map[string]any{"jobId": id}, err
			}
			procedures["setScheduleEnabled"] = func(ctx context.Context, input any, _ string) (any, error) {
				value := input.(map[string]any)
				rows, err := executor.Query(ctx, `UPDATE workhorse.schedule_definition SET enabled=$1,revision=revision+1,updated_at=clock_timestamp() WHERE namespace=$2 AND schedule_name=$3 RETURNING enabled`, value["enabled"], value["namespace"], value["name"])
				if err != nil {
					return nil, err
				}
				if len(rows) == 0 {
					return nil, &dashboard.RPCError{Status: 404, Code: "NOT_FOUND", Message: "Schedule not found"}
				}
				return map[string]any{"enabled": rows[0]["enabled"]}, nil
			}
		}
		handler, err := dashboard.NewHandler(dashboard.HandlerOptions{Executor: executor,
			Authorize: func(*http.Request) dashboard.Authorization {
				return dashboard.Authorization{Principal: &dashboard.Principal{Actor: "conformance"}}
			},
			Path: "/workhorse", Environment: "conformance", ConfiguredWorkers: []string{"conformance-worker"}, MaintenanceLoops: map[string]int{"tickIntervalMs": 1000}, ReadOnly: readOnly, Procedures: procedures})
		if err != nil {
			panic(err)
		}
		return handler
	}
	pgxWritable, pgxReadOnly := harness(workhorse.NewPGXExecutor(pool), false), harness(workhorse.NewPGXExecutor(pool), true)
	sqlWritable, sqlReadOnly := harness(workhorse.NewSQLExecutor(sqlDatabase), false), harness(workhorse.NewSQLExecutor(sqlDatabase), true)
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		request.Host = "dashboard.conformance.test"
		writable, readOnly := pgxWritable, pgxReadOnly
		if request.Header.Get("X-Workhorse-Executor") == "database-sql" {
			writable, readOnly = sqlWritable, sqlReadOnly
		}
		if request.Header.Get("X-Workhorse-Conformance-Mode") == "read-only" {
			readOnly.ServeHTTP(response, request)
		} else {
			writable.ServeHTTP(response, request)
		}
	})}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	fmt.Println(listener.Addr().String())
	go func() { <-ctx.Done(); _ = server.Shutdown(context.Background()) }()
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		panic(err)
	}
}
