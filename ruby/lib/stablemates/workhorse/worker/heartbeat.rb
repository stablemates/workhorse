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
      class Heartbeat
        # One running attempt. +renew+ takes the monotonic send time of an accepted round;
        # +settle+ takes a status other than +accepted+; +fail+ takes an error +settle+ raised.
        Member = Data.define(:worker_id, :task, :lease_ms, :interval, :renew, :settle, :fail, :logger)

        # A round that did not finish within its interval.
        class RoundTimeout < StandardError; end

        STRINGS = PG::TypeMapAllStrings.new
        private_constant :STRINGS

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
              rows = begin
                yield SqlCatalogue::HEARTBEAT_MANY_V1, [worker_id, JSON.generate(leases)], interval
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

        # Sends one round without blocking past +timeout+ seconds.
        def bounded_rows(connection, sql, params, timeout)
          connection.send_query_params(sql, params, 0, STRINGS)
          raise RoundTimeout unless connection.block(timeout)

          result = connection.get_last_result
          begin
            result.type_map = STRINGS
            result.to_a
          ensure
            result.clear
          end
        end

        # A connection that overran a round still runs its statement, so it cannot go back to the
        # pool. A pool without +discard_current_connection+ gets the connection back closed, and
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
