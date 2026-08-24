package workhorse

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	notificationReconnectInitial = 100 * time.Millisecond
	notificationReconnectMaximum = 5 * time.Second
	notificationCleanupTimeout   = time.Second
)

func jobNotificationMatches(payload string, queues []string) bool {
	if payload == jobNotificationWildcard {
		return true
	}
	for _, queue := range queues {
		if payload == queue {
			return true
		}
	}
	return false
}

func wakeWorker(wake chan<- struct{}) {
	select {
	case wake <- struct{}{}:
	default:
	}
}

func listenForJobNotifications(
	ctx context.Context,
	pool *pgxpool.Pool,
	queues []string,
	pollingOnly bool,
	logger *slog.Logger,
	wake chan<- struct{},
	listening *atomic.Bool,
) {
	if pollingOnly {
		logger.WarnContext(ctx, pollingOnlyListenerLogMessage)
		return
	}
	if pool.Config().MaxConns < 2 {
		logger.WarnContext(ctx, shortPoolListenerLogMessage)
		return
	}

	reconnectDelay := notificationReconnectInitial
	for ctx.Err() == nil {
		connection, err := pool.Acquire(ctx)
		listenSucceeded := false
		if err == nil {
			_, err = connection.Exec(ctx, listenForJobsStatement)
			listenSucceeded = err == nil
		}
		if err == nil {
			listening.Store(true)
			reconnectDelay = notificationReconnectInitial
			wakeWorker(wake)
			for ctx.Err() == nil {
				notification, waitErr := connection.Conn().WaitForNotification(ctx)
				if waitErr != nil {
					err = waitErr
					break
				}
				if notification.Channel == jobNotificationChannel && jobNotificationMatches(notification.Payload, queues) {
					wakeWorker(wake)
				}
			}
		}
		listening.Store(false)
		if connection != nil {
			if listenSucceeded && ctx.Err() != nil {
				cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), notificationCleanupTimeout)
				_, cleanupError := connection.Exec(cleanupContext, unlistenForJobsStatement)
				cancelCleanup()
				if cleanupError != nil {
					logger.Warn(notificationListenerLogMessage, notificationListenerErrorKey, cleanupError)
				}
			}
			connection.Release()
		}
		if ctx.Err() != nil {
			return
		}

		logger.WarnContext(ctx, notificationListenerLogMessage, notificationListenerErrorKey, err)
		reconnectTimer := time.NewTimer(reconnectDelay)
		select {
		case <-ctx.Done():
			if !reconnectTimer.Stop() {
				<-reconnectTimer.C
			}
			return
		case <-reconnectTimer.C:
		}
		reconnectDelay = min(notificationReconnectMaximum, reconnectDelay*2)
	}
}
