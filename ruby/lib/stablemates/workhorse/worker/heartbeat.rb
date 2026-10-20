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
        # +settle+ takes a status other than +accepted+ and +busy+; +fail+ takes an error +settle+
        # raised. +lease_ends_at+ returns the monotonic end of the local lease window, or nil once
        # the window is closed. A busy retry never runs past it.
        Member = Data.define(:worker_id, :task, :lease_ms, :interval, :renew, :settle, :fail, :logger,
          :lease_ends_at)

        # A round that did not finish by its deadline.
        class RoundTimeout < StandardError; end

        # A round that stopped before it sent its heartbeat statement, and left its connection clean:
        # it sent nothing, or its transaction rolled back. The worker keeps the connection.
        class RoundExpired < StandardError; end

        STRINGS = PG::TypeMapAllStrings.new
        # Sets both server timeouts for the current transaction only. SET LOCAL cannot take a bind
        # parameter, and set_config(..., true) has the same scope.
        ROUND_TIMEOUTS = "SELECT set_config('statement_timeout', $1, true), " \
          "set_config('idle_in_transaction_session_timeout', $2, true)"
        # A round with less time than this left, in seconds, fails before it sends its heartbeat. At
        # this size every budget of +round_timeouts+ is at least 1 ms, and the budgets still fit.
        MINIMUM_REMAINING = 0.008
        # The longest base delay before a busy retry, in seconds (Heartbeat.busy_retry_delay).
        BUSY_RETRY_BASE = 0.1
        # A bounded busy retry with less time than BUSY_RETRY_MINIMUM left does not run, and the next
        # regular round renews its leases. The minimum is the time a round needs at the settings
        # statement, plus a margin for the payload, the wait for the connection, and BEGIN.
        BUSY_RETRY_MARGIN = 0.012
        BUSY_RETRY_MINIMUM = MINIMUM_REMAINING + BUSY_RETRY_MARGIN
        # The wait after a shared round raised an unexpected error, in seconds, so that an error that
        # repeats cannot keep the thread busy.
        FAILED_ROUND_DELAY = 0.1
        # heartbeat_many_v2 raises an error for more leases than this in one statement.
        STATEMENT_LEASE_LIMIT = 100
        private_constant :STRINGS, :ROUND_TIMEOUTS, :MINIMUM_REMAINING, :BUSY_RETRY_BASE, :BUSY_RETRY_MARGIN,
          :BUSY_RETRY_MINIMUM, :FAILED_ROUND_DELAY, :STATEMENT_LEASE_LIMIT

        # The deadline of one round, in seconds, for an +interval+ in seconds. It is three quarters
        # of the interval, so that one timed-out round leaves a renewal margin when 2 × interval +
        # bound < lease. Below an interval of 200 ms the bound is at least min(50 ms, interval). Up
        # to 50 ms the bound thus equals the interval, as before SM-1444, and a timed-out round
        # leaves about no margin. It is at least 1 ms. Every SDK uses the same formula.
        def self.round_bound(interval)
          milliseconds = (interval * 1000).round
          [1, milliseconds * 3 / 4, [50, milliseconds].min].max / 1000.0
        end

        # The delay before a busy retry, in seconds, for the shortest member +interval+ in seconds:
        # base × (1 + +random+), with base = min(100 ms, interval / 8). The jitter keeps two workers
        # from meeting the same lock holder in step. Every SDK uses the same formula.
        def self.busy_retry_delay(interval, random = rand)
          [BUSY_RETRY_BASE, interval / 8.0].min * (1 + random)
        end

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
          # The worker that the next dedicated round sends first. Only the heartbeat thread uses it.
          @rotation = 0
          # The busy members of the latest round, which a retry renews before the next regular
          # round, and the monotonic time when that retry falls due. A round of either kind
          # replaces both. Only the heartbeat thread uses them.
          @busy = nil
          @busy_at = 0
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
          # The start of the latest round, on the monotonic clock. A new connection keeps it, so a
          # failed round does not start a new schedule.
          @previous = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          @busy = nil
          @dedicated ? run_dedicated : run_shared
        end

        # Runs the rounds of a borrowing heartbeat. An unexpected error does not end the thread while
        # a member remains: the thread ends only through +stop_if_idle+, so a register that races
        # the end starts a new thread.
        def run_shared
          loop do
            return if rounds { |sql, params, _timeout| Executor.for(@source).rows(sql, params) }
          rescue
            @busy = nil
            return if stop_if_idle

            @wake.wait(FAILED_ROUND_DELAY)
            @wake.reset
          end
        end

        # Holds one connection across rounds. A round that fails or overruns discards the
        # connection, and the next round checks out a new one. A round that expires before its
        # heartbeat statement keeps the connection (+bounded_rows+).
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
              finished = stop_if_idle
            end
            return if finished
          end
        end

        # Runs rounds until no member remains, and returns true then. A round falls due one shortest
        # member interval after the previous regular round started; a wake recomputes that from the
        # current members. A round that ends after its next slot starts one overdue round at once,
        # and the interval after it counts from that start, so missed slots are never replayed. A
        # failed round raises only from a dedicated connection, so the caller can replace it.
        #
        # Between two regular rounds, a busy retry (+take_busy_retry+) sends only the members that
        # the latest round reported busy. It runs on the same thread, so it is a round for the
        # one-round-in-flight rule, and it never moves the regular slot.
        def rounds(&)
          loop do
            interval = shortest_interval_or_stop
            if interval.nil?
              @busy = nil
              return true
            end

            regular_at = @previous + interval
            retrying = !@busy.nil? && @busy_at < regular_at
            remaining = (retrying ? @busy_at : regular_at) - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            if remaining.positive?
              @wake.wait(remaining)
              @wake.reset
              next
            end
            if retrying
              selection = take_busy_retry(regular_at)
              # With nothing left to retry, the next regular round waits for its slot.
              next if selection.nil?

              started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
              deadline = retry_deadline(selection, interval, regular_at, started)
              # A bounded retry with too little time left would fail before its heartbeat statement.
              # It sends nothing, and the next regular round renews every lease, the busy ones too.
              next if @dedicated && deadline - started < BUSY_RETRY_MINIMUM

              send_round(selection, deadline, interval, rotate: false, &)
              next
            end
            @previous = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            # The deadline starts before the payloads are built, so serialization counts against it.
            deadline = @previous + round_bound(interval)
            members = members_or_stop
            return true if members.nil?

            send_round(members, deadline, interval, rotate: true, &)
          end
        end

        # Sends one round for +members+. A round sends one statement for each worker, and more for a
        # worker with more than +STATEMENT_LEASE_LIMIT+ members (+statements+). On the
        # dedicated connection, all of them share one +deadline+. A statement that would start after
        # it waits for the next round, so a slow statement of one worker cannot delay the renewal of
        # another past it. Each regular round starts with the next worker (+ordered_groups+), so a
        # worker whose statement is always slow cannot keep another from its turn. A borrowing
        # heartbeat has no deadline, and sends every statement.
        #
        # A round replaces the pending busy retry. If one or more members are busy, it schedules one
        # retry for them. A round that raises schedules none, and the next regular round tries again.
        #
        # A statement that expires before its heartbeat (+RoundExpired+) stops the round on its
        # connection. The statements before it still count, and the next round sends the rest. A
        # busy retry that stops this way schedules no other retry.
        def send_round(members, deadline, interval, rotate:)
          @busy = nil
          busy = []
          expired = false
          statements(members, rotate:).each do |worker_id, group|
            sent_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            leases = group.map do |member|
              {"taskId" => member.task.id, "fenceToken" => member.task.fence_token.to_s, "leaseMs" => member.lease_ms}
            end
            params = [worker_id, JSON.generate(leases)]
            timeout = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            break if @dedicated && !timeout.positive?

            rows = begin
              yield SqlCatalogue::HEARTBEAT_MANY_V2, params, timeout
            rescue RoundExpired
              expired = true
              break
            rescue RoundTimeout, PG::Error
              raise if @dedicated

              next
            rescue
              # A skipped round is silent: the lease watchdog handles rounds that keep failing.
              next
            end
            busy.concat(settle(group, rows.to_h { |row| [row["task_id"], row["status"]] }, sent_at))
          end
          return if busy.empty? || (expired && !rotate)

          @busy = busy
          @busy_at = Process.clock_gettime(Process::CLOCK_MONOTONIC) + Heartbeat.busy_retry_delay(interval)
        end

        # Takes the pending busy retry, and returns the members it can still renew, or nil. Each
        # member must still be registered as the same object, so a member that completed, left, or
        # was replaced is gone, and its local lease window must not have ended. At or after
        # +regular_at+ the retry is dropped, and the regular round takes every member.
        def take_busy_retry(regular_at)
          busy = @busy
          @busy = nil
          now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          return nil if busy.nil? || now >= regular_at

          selection = busy.select do |member|
            ends_at = member.lease_ends_at.call
            ends_at && ends_at > now && registered?(member)
          end
          selection.empty? ? nil : selection
        end

        # A busy retry ends by its own round bound, by the next regular slot, and by the end of the
        # earliest local lease window in it, so it never renews a lease that the worker has already
        # given up. A borrowing heartbeat ignores the deadline, as in its regular rounds. +started+ is
        # the monotonic start of the retry.
        def retry_deadline(selection, interval, regular_at, started)
          ends = selection.map { |member| member.lease_ends_at.call || started }
          [started + round_bound(interval), regular_at, *ends].min
        end

        # The statements of one round, as [worker_id, members] pairs: the +ordered_groups+, each
        # split into slices of at most +STATEMENT_LEASE_LIMIT+ members. A fused completion claim
        # registers its tasks before the completing attempts unregister, so a worker can hold more
        # members than its concurrency.
        def statements(members, rotate:)
          ordered_groups(members, rotate:).flat_map do |worker_id, group|
            group.each_slice(STATEMENT_LEASE_LIMIT).map { |slice| [worker_id, slice] }
          end
        end

        # The members of one round, one group for each worker, as [worker_id, members] pairs. On the
        # dedicated connection, each regular round starts one worker later than the round before
        # it. A busy retry (+rotate+ false) keeps the order and does not move the rotation.
        def ordered_groups(members, rotate: true)
          groups = members.group_by(&:worker_id).to_a
          return groups unless rotate && @dedicated && groups.size > 1

          first = @rotation % groups.size
          @rotation = first + 1
          groups.rotate(first)
        end

        # The deadline of one round, in seconds, for the shortest member +interval+
        # (Heartbeat.round_bound).
        def round_bound(interval) = Heartbeat.round_bound(interval)

        # Delivers each status to its member, and returns the busy members. A result counts only
        # for the member object that the round sent, so a member that left or was replaced while
        # the round ran gets nothing from it. A busy member got no renewal and no ownership verdict:
        # its lease watchdog keeps its window, and the member stays registered.
        def settle(group, statuses, sent_at)
          group.filter_map do |member|
            next unless registered?(member)

            status = statuses.fetch(member.task.id, "stale")
            begin
              report(member, status)
              case status
              when "accepted" then member.renew.call(sent_at)
              when "busy" then next member
              else member.settle.call(status)
              end
            rescue => e
              member.fail.call(e)
            end
            nil
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

        # Ends the thread when no member remains, and returns true then. A register that races this
        # starts a new one.
        def stop_if_idle
          @lock.synchronize do
            @thread = nil if @members.empty?
            @members.empty?
          end
        end

        # The shortest member interval, or nil when no member remains. Nil also ends the thread. The
        # read and the end take one lock, so a register between them cannot find a thread that is
        # about to end.
        def shortest_interval_or_stop
          @lock.synchronize do
            @thread = nil if @members.empty?
            @members.each_value.map(&:interval).min
          end
        end

        # The current members, or nil when none remains. Nil also ends the thread, under the same
        # lock as the read (+shortest_interval_or_stop+).
        def members_or_stop
          @lock.synchronize do
            @thread = nil if @members.empty?
            @members.values unless @members.empty?
          end
        end

        # Sends one round in its own transaction, without blocking past +timeout+ seconds.
        #
        # Closing a connection does not stop its statement: PostgreSQL notices a closed client only
        # when it next writes to it. So the server must end a round that the client stopped waiting
        # for. The timeouts (+round_timeouts+) end the heartbeat, and a transaction whose client
        # stopped before COMMIT, by the deadline. A COMMIT that PostgreSQL has already started can
        # still finish later. Both settings end with the transaction, so the connection keeps no
        # session state.
        #
        # A round that expires before its heartbeat statement, while no statement is in flight,
        # raises RoundExpired: with less than MINIMUM_REMAINING left before BEGIN it sends nothing,
        # and after BEGIN it rolls back first (+expire+). Any other failure raises RoundTimeout or
        # PG::Error, and the caller discards the connection, which rolls back.
        def bounded_rows(connection, sql, params, timeout)
          deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
          raise RoundExpired if timeout < MINIMUM_REMAINING

          bounded_result(connection, "BEGIN", [], deadline).clear
          set_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          remaining = deadline - set_at
          expire(connection, deadline) if remaining < MINIMUM_REMAINING

          bounded_result(connection, ROUND_TIMEOUTS, round_timeouts(remaining), deadline).clear
          # The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
          expire(connection, deadline) if Process.clock_gettime(Process::CLOCK_MONOTONIC) - set_at > remaining / 4

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

        # Rolls back a round that expired before its heartbeat statement, and raises RoundExpired. The
        # ROLLBACK has the round's deadline, so it is not sent after it. If the ROLLBACK cannot be
        # sent, fails, or does not end by the deadline, RoundTimeout or PG::Error goes to the
        # caller, which discards the connection.
        def expire(connection, deadline)
          bounded_result(connection, "ROLLBACK", [], deadline).clear
          raise RoundExpired
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
