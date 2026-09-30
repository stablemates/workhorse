# frozen_string_literal: true

module Stablemates
  module Workhorse
    class Worker
      # Wakes a worker when PostgreSQL announces claimable work. Internal to the SDK.
      #
      # The listener holds one pool connection that runs +LISTEN workhorse_tasks+. A notification
      # names a queue, or +*+ for every queue. A lost connection reconnects with a jittered backoff,
      # and the worker keeps polling meanwhile, so a notification only shortens a wait.
      class Listener # :nodoc:
        CHANNEL = "workhorse_tasks"
        INITIAL_RECONNECT = 0.1
        MAX_RECONNECT = 5.0
        READ_TIMEOUT = 0.1
        private_constant :CHANNEL, :INITIAL_RECONNECT, :MAX_RECONNECT, :READ_TIMEOUT

        def initialize(pool, queues, on_wake:, on_error:)
          @pool = pool
          @queues = queues
          @on_wake = on_wake
          @on_error = on_error
          @stop = Concurrent::Event.new
          @listening = Concurrent::AtomicBoolean.new(false)
          @thread = Thread.new { run }
          @thread.name = "workhorse-notification-listener"
        end

        def listening? = @listening.true?

        def close
          @stop.set
          @thread.join(READ_TIMEOUT * 2)
        end

        private

        def run
          backoff = INITIAL_RECONNECT
          until @stop.set?
            begin
              @pool.with do |connection|
                listen(connection) { backoff = INITIAL_RECONNECT }
              end
            rescue => e
              @on_error.call(e)
              @on_wake.call
            end
            break if @stop.wait(backoff * rand(0.9..1.1))

            backoff = [backoff * 2, MAX_RECONNECT].min
          end
        end

        def listen(connection)
          connection.exec("LISTEN #{CHANNEL}")
          yield
          @listening.make_true
          @on_wake.call
          until @stop.set?
            connection.wait_for_notify(READ_TIMEOUT) do |_channel, _pid, payload|
              @on_wake.call if payload == "*" || @queues.include?(payload)
            end
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
      end
    end
  end
end
