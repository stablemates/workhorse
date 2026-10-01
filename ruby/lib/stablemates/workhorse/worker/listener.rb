# frozen_string_literal: true

module Stablemates
  module Workhorse
    class Worker
      # Wakes workers when PostgreSQL announces claimable work. Internal to the SDK.
      #
      # Every worker built on one pool shares one listener, keyed by the pool object, the way it
      # shares the heartbeat. So a pool budgets one listener connection however many workers it
      # serves. The listener holds that connection, which runs +LISTEN workhorse_tasks+, while it
      # has subscribers. A notification names a queue, or +*+ for every queue, and wakes each
      # subscriber whose queues match. A lost connection reconnects with a jittered backoff, and
      # each worker keeps polling meanwhile, so a notification only shortens a wait.
      class Listener # :nodoc:
        CHANNEL = "workhorse_tasks"
        INITIAL_RECONNECT = 0.1
        MAX_RECONNECT = 5.0
        READ_TIMEOUT = 0.1
        private_constant :CHANNEL, :INITIAL_RECONNECT, :MAX_RECONNECT, :READ_TIMEOUT

        Subscriber = Data.define(:queues, :on_wake, :on_error)
        private_constant :Subscriber

        # One worker's registration. +close+ removes it, and closing twice is harmless.
        class Subscription
          def initialize(listener, subscriber)
            @listener = listener
            @subscriber = subscriber
          end

          def listening? = @listener.listening?

          def close = @listener.unsubscribe(@subscriber)
        end

        @shared = {}.compare_by_identity
        @shared_lock = Mutex.new

        # The listener every worker on +pool+ shares.
        def self.shared(pool)
          @shared_lock.synchronize { @shared[pool] ||= new(pool) }
        end

        def initialize(pool)
          @pool = pool
          @lock = Mutex.new
          @subscribers = {}.compare_by_identity
          @listening = Concurrent::AtomicBoolean.new(false)
          @stop = nil
          @thread = nil
        end

        def listening? = @listening.true?

        # Wakes +on_wake+ for notifications that name one of +queues+, and starts the listener for
        # the first subscriber. It never waits: a listener that is still stopping, perhaps on a
        # stalled connection, sees the subscriber once that connection is back in the pool and
        # listens again. So a pool never holds two listener connections, and a worker polls
        # meanwhile.
        def subscribe(queues, on_wake:, on_error:)
          subscriber = Subscriber.new(queues, on_wake, on_error)
          @lock.synchronize do
            @subscribers[subscriber] = true
            start unless @thread&.alive?
          end
          Subscription.new(self, subscriber)
        end

        # Removes +subscriber+. The last subscriber stops the listener, which returns its
        # connection to the pool.
        def unsubscribe(subscriber)
          thread = @lock.synchronize do
            next unless @subscribers.delete(subscriber) && @subscribers.empty?

            @stop.set
            @thread
          end
          thread&.join(READ_TIMEOUT * 2)
        end

        private

        def start
          stop = @stop = Concurrent::Event.new
          @thread = Thread.new { run(stop) }
          @thread.name = "workhorse-notification-listener"
        end

        # Listens until stopped. Once its connection is back in the pool, the thread exits unless a
        # subscriber arrived while it stopped.
        def run(stop)
          loop do
            listen_until(stop)
            stop = @lock.synchronize do
              if @subscribers.empty?
                @thread = nil
                next
              end

              @stop = Concurrent::Event.new
            end
            break unless stop
          end
        end

        def listen_until(stop)
          backoff = INITIAL_RECONNECT
          until stop.set?
            begin
              @pool.with do |connection|
                listen(connection, stop) { backoff = INITIAL_RECONNECT }
              end
            rescue => e
              report(e)
              wake_all
            end
            break if stop.wait(backoff * rand(0.9..1.1))

            backoff = [backoff * 2, MAX_RECONNECT].min
          end
        end

        def listen(connection, stop)
          connection.exec("LISTEN #{CHANNEL}")
          yield
          @listening.make_true
          wake_all
          until stop.set?
            connection.wait_for_notify(READ_TIMEOUT) { |_channel, _pid, payload| wake_matching(payload) }
          end
        ensure
          @listening.make_false
          unlisten(connection)
        end

        # A connection that still listens cannot go back to the pool.
        def unlisten(connection)
          connection.exec("UNLISTEN *")
        rescue
          if @pool.respond_to?(:discard_current_connection)
            @pool.discard_current_connection { |discarded| discarded.close rescue nil } # standard:disable Style/RescueModifier
          else
            connection.close rescue nil # standard:disable Style/RescueModifier
          end
        end

        def subscribers = @lock.synchronize { @subscribers.keys }

        def wake_matching(payload)
          subscribers.each do |subscriber|
            notify(subscriber.on_wake) if payload == "*" || subscriber.queues.include?(payload)
          end
        end

        def wake_all = subscribers.each { |subscriber| notify(subscriber.on_wake) }

        def report(error) = subscribers.each { |subscriber| notify(subscriber.on_error, error) }

        # A callback that raises must not end the listener, which would stop every subscriber's wakes.
        def notify(callback, *arguments)
          callback.call(*arguments)
        rescue
          nil
        end
      end
    end
  end
end
