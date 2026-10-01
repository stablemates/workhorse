package workhorse

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	notificationReconnectInitial = 100 * time.Millisecond
	notificationReconnectMaximum = 5 * time.Second
	notificationCleanupTimeout   = time.Second
)

func taskNotificationMatches(payload string, queues []string) bool {
	if payload == taskNotificationWildcard {
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

// taskNotificationSubscription is one worker's share of its pool's notification listener.
type taskNotificationSubscription struct {
	hub    *taskNotificationHub
	queues []string
	logger *slog.Logger
	wake   chan<- struct{}
	closed sync.Once
}

// taskNotificationHub holds the one listener connection that every worker on a pool shares. It
// fans each notification out to the subscribers whose queues it names.
type taskNotificationHub struct {
	pool        *pgxpool.Pool
	subscribers map[*taskNotificationSubscription]struct{}
	// lastLogger is the logger of the subscriber that stopped the hub. The listener sends UNLISTEN
	// after that subscriber has left, and reports a failure there.
	lastLogger *slog.Logger
	listening  atomic.Bool
	stop       context.CancelFunc
	done       chan struct{}
}

var taskNotificationHubs = struct {
	mu   sync.Mutex
	hubs map[*pgxpool.Pool]*taskNotificationHub
	// stopping holds the done channel of a hub whose last subscriber left. A hub that replaces it
	// waits for that channel, so a pool never holds two listener connections at once.
	stopping map[*pgxpool.Pool]chan struct{}
}{
	hubs:     make(map[*pgxpool.Pool]*taskNotificationHub),
	stopping: make(map[*pgxpool.Pool]chan struct{}),
}

// subscribeToTaskNotifications wakes the worker when a task becomes ready on one of its queues. It
// returns nil when the worker polls instead: when it was configured to, or when its pool is too
// small to lend the listener a connection.
func subscribeToTaskNotifications(
	ctx context.Context,
	pool *pgxpool.Pool,
	queues []string,
	pollingOnly bool,
	logger *slog.Logger,
	wake chan<- struct{},
) *taskNotificationSubscription {
	if pollingOnly {
		logger.WarnContext(ctx, pollingOnlyListenerLogMessage)
		return nil
	}
	if pool.Config().MaxConns < 2 {
		logger.WarnContext(ctx, shortPoolListenerLogMessage)
		return nil
	}
	taskNotificationHubs.mu.Lock()
	defer taskNotificationHubs.mu.Unlock()
	hub, ok := taskNotificationHubs.hubs[pool]
	if !ok {
		listenContext, stop := context.WithCancel(context.Background())
		hub = &taskNotificationHub{
			pool:        pool,
			subscribers: make(map[*taskNotificationSubscription]struct{}),
			stop:        stop,
			done:        make(chan struct{}),
		}
		taskNotificationHubs.hubs[pool] = hub
		previous := taskNotificationHubs.stopping[pool]
		go func() {
			defer close(hub.done)
			if previous != nil {
				<-previous
			}
			hub.listen(listenContext)
		}()
	}
	subscription := &taskNotificationSubscription{hub: hub, queues: queues, logger: logger, wake: wake}
	hub.subscribers[subscription] = struct{}{}
	if hub.listening.Load() {
		wakeWorker(wake)
	}
	return subscription
}

// isListening reports whether the shared listener holds a LISTEN, so the worker may poll slowly.
func (subscription *taskNotificationSubscription) isListening() bool {
	return subscription != nil && subscription.hub.listening.Load()
}

// close ends this worker's subscription. The last subscriber to leave stops the listener and waits
// for it to return its connection. A concurrent or later call waits for the first to finish.
func (subscription *taskNotificationSubscription) close() {
	if subscription == nil {
		return
	}
	subscription.closed.Do(subscription.leave)
}

func (subscription *taskNotificationSubscription) leave() {
	hub := subscription.hub
	taskNotificationHubs.mu.Lock()
	delete(hub.subscribers, subscription)
	if len(hub.subscribers) > 0 {
		taskNotificationHubs.mu.Unlock()
		return
	}
	hub.lastLogger = subscription.logger
	delete(taskNotificationHubs.hubs, hub.pool)
	taskNotificationHubs.stopping[hub.pool] = hub.done
	taskNotificationHubs.mu.Unlock()
	hub.stop()
	<-hub.done
	taskNotificationHubs.mu.Lock()
	if taskNotificationHubs.stopping[hub.pool] == hub.done {
		delete(taskNotificationHubs.stopping, hub.pool)
	}
	taskNotificationHubs.mu.Unlock()
}

// wakeMatching wakes every subscriber whose queues the payload names, and wakeAll wakes every
// subscriber. The listener calls them, so a subscriber added since the last wake receives the next.
func (hub *taskNotificationHub) wakeMatching(payload string) {
	taskNotificationHubs.mu.Lock()
	defer taskNotificationHubs.mu.Unlock()
	for subscription := range hub.subscribers {
		if taskNotificationMatches(payload, subscription.queues) {
			wakeWorker(subscription.wake)
		}
	}
}

func (hub *taskNotificationHub) wakeAll() {
	taskNotificationHubs.mu.Lock()
	defer taskNotificationHubs.mu.Unlock()
	for subscription := range hub.subscribers {
		wakeWorker(subscription.wake)
	}
}

// report logs a listener failure through every subscriber's logger, since each worker owns its log.
// Once the last subscriber has left, it logs through that subscriber's logger.
func (hub *taskNotificationHub) report(err error) {
	taskNotificationHubs.mu.Lock()
	loggers := make([]*slog.Logger, 0, len(hub.subscribers))
	for subscription := range hub.subscribers {
		loggers = append(loggers, subscription.logger)
	}
	if len(loggers) == 0 && hub.lastLogger != nil {
		loggers = append(loggers, hub.lastLogger)
	}
	taskNotificationHubs.mu.Unlock()
	for _, logger := range loggers {
		logger.Warn(notificationListenerLogMessage, notificationListenerErrorKey, err)
	}
}

func (hub *taskNotificationHub) listen(ctx context.Context) {
	reconnectDelay := notificationReconnectInitial
	for ctx.Err() == nil {
		connection, err := hub.pool.Acquire(ctx)
		listenSucceeded := false
		if err == nil {
			_, err = connection.Exec(ctx, listenForTasksStatement)
			listenSucceeded = err == nil
		}
		if err == nil {
			hub.listening.Store(true)
			reconnectDelay = notificationReconnectInitial
			hub.wakeAll()
			for ctx.Err() == nil {
				notification, waitErr := connection.Conn().WaitForNotification(ctx)
				if waitErr != nil {
					err = waitErr
					break
				}
				if notification.Channel == taskNotificationChannel {
					hub.wakeMatching(notification.Payload)
				}
			}
		}
		hub.listening.Store(false)
		if connection != nil {
			if listenSucceeded && ctx.Err() != nil {
				cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), notificationCleanupTimeout)
				_, cleanupError := connection.Exec(cleanupContext, unlistenForTasksStatement)
				cancelCleanup()
				if cleanupError != nil {
					hub.report(cleanupError)
				}
			}
			connection.Release()
		}
		if ctx.Err() != nil {
			return
		}

		hub.report(err)
		hub.wakeAll()
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
