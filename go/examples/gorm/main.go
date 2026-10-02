package main

import (
	"context"
	"fmt"
	"os"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Order struct {
	ID    string `gorm:"primaryKey"`
	Email string `gorm:"not null"`
}

func acceptOrder(ctx context.Context, tx *gorm.DB, order Order) (string, error) {
	if err := tx.WithContext(ctx).Create(&order).Error; err != nil {
		return "", err
	}
	queue := workhorse.NewQueue(workhorse.NewSQLExecutor(tx.Statement.ConnPool), "orders")
	return queue.Enqueue(ctx, "order.accepted", map[string]any{"orderId": order.ID})
}

func createOrder(ctx context.Context, db *gorm.DB, order Order) (string, error) {
	var taskID string
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var err error
		taskID, err = acceptOrder(ctx, tx, order)
		return err
	})
	if err != nil {
		return "", err
	}
	return taskID, nil
}

func main() {
	if len(os.Args) != 3 || os.Getenv("WORKHORSE_DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "set WORKHORSE_DATABASE_URL and run: go run ./examples/gorm ORDER_ID EMAIL")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := gorm.Open(postgres.Open(os.Getenv("WORKHORSE_DATABASE_URL")), &gorm.Config{PrepareStmt: true})
	if err != nil {
		panic(err)
	}
	pool, err := db.DB()
	if err != nil {
		panic(err)
	}
	defer pool.Close()
	taskID, err := createOrder(ctx, db, Order{ID: os.Args[1], Email: os.Args[2]})
	if err != nil {
		panic(err)
	}
	fmt.Println(taskID)
}
