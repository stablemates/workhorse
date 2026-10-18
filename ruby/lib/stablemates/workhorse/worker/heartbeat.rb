# frozen_string_literal: true

module Stablemates
  module Workhorse
    class Worker
      # Renews the leases of running attempts. Internal to the SDK.
      #
      # Every worker built on one pool shares one heartbeat, keyed by the pool object, and that
      # heartbeat holds one pool connection while it has members. So a busy pool cannot starve
      # renewal: handlers that hold every other connection never delay a lease round. With
      # +shared_heartbeats: true+ a worker has its own heartbeat, which borrows a connection from
      # the executor for each round instead.
      class Heartbeat # :nodoc:
        # One running attempt. +renew+ takes the monotonic send time of an accepted round;
        # +settle+ takes a status other than +accepted+; +fail+ takes an error +settle+ raised.
        Member = Data.define(:worker_id, :task, :lease_ms, :interval, :renew, :settle, :fail, :logger)

        # A round that did not finish within its interval.
        class RoundTimeout < StandardError; end

        STRINGS = PG::TypeMapAllStrings.new
        # Sets both server timeouts for the current transaction only. SET LOCAL cannot take a bind
        # parameter, and set_config(..., true) has the same scope.
        ROUND_TIMEOUTS = "SELECT set_config('statement_timeout', $1, true), " \
          "set_config('idle_in_transaction_session_timeout', $2, true)"
        # A round with less time than this left, in seconds, fails before it sends its heartbeat. At
        # this size every budget of +round_timeouts+ is at least 1 ms, and the budgets still fit.
        MINIMUM_REMAINING = 0.008
        private_constant :STRINGS, :ROUND_TIMEOUTS, :MINIMUM_REMAINING

        @dedicated = {}.compare_by_identity
        @dedicated_lock = Mutex.new

        # The heartbeat every worker on +pool+ shares.
        def self.dedicated(pool)
          @dedicated_lock.synchronize { @dedicated[pool] ||= new(pool, dedicated: true) }
        end

        def initialize(source, dedicated:)
          @source = source
          @dedicated = dedicated
          @lock = Mutex.new
          @members = {}
          @wake = Concurrent::Event.new
          @thread = nil
        end

        # Adds +member+ and returns a callable that removes it. Removing twice is harmless. A member
        # with a shorter interval than every other wakes the thread, which then reschedules its
        # next round from the new interval.
        def register(member)
          key = [member.worker_id, member.task.id]
          @lock.synchronize do
            shortest = @members.each_value.map(&:interval).min
            @members[key] = member
            @wake.set if shortest && member.interval < shortest
            unless @thread&.alive?
              @wake.reset
              @thread = Thread.new { run }
              @thread.name = "workhorse-heartbeats"
            end
          end
          lambda do
            @lock.synchronize do
              @members.delete(key) if @members[key].equal?(member)
              @wake.set if @members.empty?
            end
          end
        end

        private

        def run
          if @dedicated
            run_dedicated
          else
            rounds { |sql, params, _timeout| Executor.for(@source).rows(sql, params) }
          end
        end

        # Holds one connection across rounds. A round that fails or overruns discards the
        # connection, and the next round checks out a new one.
        def run_dedicated
          loop do
            finished = false
            begin
              @source.with do |connection|
                finished = rounds { |sql, params, timeout| bounded_rows(connection, sql, params, timeout) }
              rescue RoundTimeout, PG::Error
                discard(connection)
              end
            rescue
              # The pool refused a connection. The lease watchdog covers rounds that keep failing.
              finished = idle?
            end
            return if finished
          end
        end

        # Runs rounds until no member remains, and returns true then. A round falls due one shortest
        # member interval after the previous one; a wake recomputes that from the current members.
        # A failed round raises only from a dedicated connection, so the caller can replace it.
        def rounds
          previous = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          loop do
            interval = @lock.synchronize { @members.each_value.map(&:interval).min }
            return true if interval.nil? && stop_if_idle

            remaining = previous + (interval || 0) - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            if remaining.positive?
              @wake.wait(remaining)
              @wake.reset
              next
            end
            previous = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            members = @lock.synchronize { @members.values }
            return true if members.empty? && stop_if_idle

            members.group_by(&:worker_id).each do |worker_id, group|
              sent_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
              leases = group.map do |member|
                {"taskId" => member.task.id, "fenceToken" => member.task.fence_token.to_s, "leaseMs" => member.lease_ms}
              end
              params = [worker_id, JSON.generate(leases)]
              # The round's deadline started at +sent_at+, so serialization counts against it.
              timeout = round_bound(interval) - (Process.clock_gettime(Process::CLOCK_MONOTONIC) - sent_at)
              rows = begin
                yield SqlCatalogue::HEARTBEAT_MANY_V1, params, timeout
              rescue RoundTimeout, PG::Error
                raise if @dedicated

                next
              rescue
                # A skipped round is silent: the lease watchdog handles rounds that keep failing.
                next
              end
              settle(group, rows.to_h { |row| [row["task_id"], row["status"]] }, sent_at)
            end
          end
        end

        # The deadline of one round, in seconds, for the shortest member +interval+. It equals the
        # interval.
        def round_bound(interval) = interval

        def settle(group, statuses, sent_at)
          group.each do |member|
            next unless registered?(member)

            status = statuses.fetch(member.task.id, "stale")
            begin
              report(member, status)
              (status == "accepted") ? member.renew.call(sent_at) : member.settle.call(status)
            rescue => e
              member.fail.call(e)
            end
          end
        end

        def report(member, status)
          attributes = Telemetry.task_span_attributes(member.task).merge("workhorse.worker.id" => member.worker_id)
          if status == "accepted"
            Telemetry.log(member.logger, :debug, "workhorse.task.heartbeat_accepted", "Task heartbeat accepted",
              attributes)
          else
            Telemetry.add("workhorse.worker.heartbeat.failure", 1, {"workhorse.heartbeat.status" => status})
            Telemetry.log(member.logger, :info, "workhorse.task.heartbeat_rejected", "Task heartbeat rejected",
              attributes.merge("workhorse.heartbeat.status" => status))
          end
        end

        def registered?(member)
          @lock.synchronize { @members[[member.worker_id, member.task.id]].equal?(member) }
        end

        def idle? = @lock.synchronize { @members.empty? }

        # Ends the thread when no member remains. A register that races this starts a new one.
        def stop_if_idle
          @lock.synchronize do
            return false unless @members.empty?

            @thread = nil
            true
          end
        end

        # Sends one round in its own transaction, without blocking past +timeout+ seconds.
        #
        # Closing a connection does not stop its statement: PostgreSQL notices a closed client only
        # when it next writes to it. So the server must end a round that the client stopped waiting
        # for. The timeouts (+round_timeouts+) end the heartbeat, and a transaction whose client
        # stopped before COMMIT, by the deadline. A COMMIT that PostgreSQL has already started can
        # still finish later. Both settings end with the transaction, so the connection keeps no
        # session state. Any failure discards the connection, which rolls back.
        def bounded_rows(connection, sql, params, timeout)
          deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
          bounded_result(connection, "BEGIN", [], deadline).clear
          set_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          remaining = deadline - set_at
          raise RoundTimeout if remaining < MINIMUM_REMAINING

          bounded_result(connection, ROUND_TIMEOUTS, round_timeouts(remaining), deadline).clear
          # The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
          raise RoundTimeout if Process.clock_gettime(Process::CLOCK_MONOTONIC) - set_at > remaining / 4

          result = bounded_result(connection, sql, params, deadline)
          rows = begin
            result.type_map = STRINGS
            result.to_a
          ensure
            result.clear
          end
          bounded_result(connection, "COMMIT", [], deadline).clear
          # A COMMIT that ends after the deadline does not count as a renewal.
          raise RoundTimeout unless deadline > Process.clock_gettime(Process::CLOCK_MONOTONIC)

          rows
        end

        # The server budgets for the rest of a round with +remaining+ seconds left, in whole
        # milliseconds. PostgreSQL measures +statement_timeout+ for each statement and
        # +idle_in_transaction_session_timeout+ for each idle gap, and restarts both every time.
        # While the round can hold a row lock, it has one idle gap before the heartbeat, the
        # heartbeat, and one idle gap before COMMIT. So the heartbeat gets one half, each gap one
        # eighth, and the last quarter is kept for COMMIT. No setting bounds COMMIT itself.
        def round_timeouts(remaining)
          milliseconds = (remaining * 1000).floor
          [[1, milliseconds / 2].max.to_s, [1, milliseconds / 8].max.to_s]
        end

        # Sends one statement and waits for its result until +deadline+, a monotonic time. Nothing
        # is sent after the deadline.
        def bounded_result(connection, sql, params, deadline)
          raise RoundTimeout unless deadline > Process.clock_gettime(Process::CLOCK_MONOTONIC)

          connection.send_query_params(sql, params, 0, STRINGS)
          remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          raise RoundTimeout unless remaining.positive? && connection.block(remaining)

          connection.get_last_result
        end

        # A connection that overran a round can still hold its transaction until the server
        # timeouts end it, so it cannot go back to the pool. A pool without +discard_current_connection+ gets the connection back closed, and
        # its owner reconnects it before reuse.
        def discard(connection)
          if @source.respond_to?(:discard_current_connection)
            @source.discard_current_connection { |discarded| close(discarded) }
          else
            close(connection)
          end
        end

        def close(connection)
          connection.close
        rescue
          nil
        end
      end
    end
  end
end
