# frozen_string_literal: true

module Stablemates
  module Workhorse
    class Worker
      # Renews the leases of running attempts. Internal to the SDK.
      #
      # Every worker built on one pool shares one heartbeat, keyed by the pool object, and that
      # heartbeat holds one pool connection while a worker on the pool runs (+reserve+) or a member
      # remains. So a busy pool cannot starve renewal: handlers that hold every other connection
      # never delay a lease round. A checkout thread borrows that connection (+Acquisition+), and the
      # heartbeat thread waits for it at most one round bound. The heartbeat replaces a lost
      # connection at once, with a backoff capped at the interval. A connection that arrives late
      # has one owner, which hands it over or returns it to the pool. With
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

        # One running worker on the pool. +on_ready+ runs each time the heartbeat has a usable
        # connection again.
        User = Data.define(:interval, :on_ready)

        # A worker's hold on the dedicated heartbeat connection (+Heartbeat#reserve+), and the claim
        # gate of one run. +close+ closes the gate, and closing twice is harmless. A closed
        # reservation never reads ready again, so a claim of an ended run cannot use the reservation
        # of a later run.
        #
        # A claim statement holds a permit (+enter+ and +leave+) from the gate check after its
        # checkout until its SQL settles. The reservation goes back to the heartbeat only when it is
        # closed and no permit is active. Thus a stop that stops waiting for a claim does not take
        # the heartbeat connection away from that claim's leases.
        class Reservation
          def initialize(heartbeat, user)
            @heartbeat = heartbeat
            @user = user
            @lock = Mutex.new
            @closed = false
            @permits = 0
            @released = false
          end

          # Whether this reservation is open and the heartbeat holds a usable connection now.
          def ready? = !@closed && @heartbeat.ready?

          # Waits up to +timeout+ seconds for a usable connection, and returns whether one is ready.
          def wait(timeout) = @heartbeat.wait_ready(timeout) && ready?

          # Takes a claim permit and returns true if the gate is open, and false otherwise.
          def enter
            @lock.synchronize do
              next false unless ready?

              @permits += 1
              true
            end
          end

          # Gives a claim permit back. The last permit of a closed reservation releases it.
          def leave
            release = @lock.synchronize do
              @permits -= 1
              release?
            end
            @heartbeat.release(@user, 0) if release
            nil
          end

          # Closes the gate. Without an active permit, this waits at most +timeout+ seconds, and at
          # most RELEASE_WAIT, for the connection to go back to the pool when this was the last
          # reservation. With one, the last +leave+ releases it, and this does not wait.
          def close(timeout = RELEASE_WAIT)
            release = @lock.synchronize do
              @closed = true
              release?
            end
            @heartbeat.release(@user, timeout) if release
            nil
          end

          private

          # Whether the reservation goes back now, at most once. The caller holds @lock.
          def release?
            return false unless @closed && @permits.zero? && !@released

            @released = true
          end
        end

        # One cycle of the heartbeat connection: checkout, hand-over or disposal, and the return to
        # the pool. Its checkout thread is the one owner of the cycle. The heartbeat waits for
        # +arrived+ at most one round bound. A connection that arrives later stays with the
        # checkout thread, which hands it over if the heartbeat still needs one, and gives it back
        # to the pool otherwise. The cycle stays the current one of its heartbeat until +returned+,
        # so the pool never holds two heartbeat checkouts.
        class Acquisition
          attr_accessor :connection, :error, :adopted
          attr_reader :arrived, :returned, :discard

          def initialize
            @connection = nil
            @error = nil
            @discard = false
            @adopted = false
            @arrived = Concurrent::Event.new
            @finished = Concurrent::Event.new
            @returned = Concurrent::Event.new
          end

          # Ends the checkout. The checkout thread discards the connection if +discard+, and the
          # pool then has its slot back.
          def finish(discard:)
            @discard = discard
            @finished.set
          end

          # Whether the cycle ends: no hand-over can happen any more.
          def finished? = @finished.set?

          def wait_finish = @finished.wait
        end

        # One readiness query on one borrowed connection (+Heartbeat#readiness+). +lent+ is true
        # once the pool lent the connection, so an error after it is an error of the query.
        class Probe
          attr_accessor :result, :error, :lent
          attr_reader :done

          def initialize
            @result = nil
            @error = nil
            @lent = false
            @done = Concurrent::Event.new
          end
        end

        # The rounds of a heartbeat that holds its connection for workers but has no member.
        Idle = Data.define(:interval)

        STRINGS = PG::TypeMapAllStrings.new
        # Sets both server timeouts for the current transaction only. SET LOCAL cannot take a bind
        # parameter, and set_config(..., true) has the same scope.
        ROUND_TIMEOUTS = "SELECT set_config('statement_timeout', $1, true), " \
          "set_config('idle_in_transaction_session_timeout', $2, true)"
        # A round with less time than this left, in seconds, fails before it sends its heartbeat. At
        # this size every budget of +round_timeouts+ is at least 1 ms, and the budgets still fit.
        MINIMUM_REMAINING = 0.008
        # The first delay before the heartbeat asks again for a connection the pool refused, in
        # seconds. The delay doubles up to the interval.
        REACQUIRE_BASE = 0.1
        # The longest wait, in seconds, before the heartbeat thread checks again that its held
        # connection is still usable. A connection that PostgreSQL ended thus closes the claim gate
        # soon, also between rounds and when no member remains.
        PROBE_INTERVAL = 0.1
        # The longest wait, in seconds, of the last worker that leaves for the heartbeat thread to
        # return its connection.
        RELEASE_WAIT = 2 * PROBE_INTERVAL
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
        # heartbeat_many_v2 raises an error for more leases than this in one call, so a batch of
        # heartbeat_pool_v1 holds at most this many leases too.
        STATEMENT_LEASE_LIMIT = 100
        private_constant :STRINGS, :ROUND_TIMEOUTS, :MINIMUM_REMAINING, :REACQUIRE_BASE, :PROBE_INTERVAL, :RELEASE_WAIT,
          :BUSY_RETRY_BASE, :BUSY_RETRY_MARGIN, :BUSY_RETRY_MINIMUM, :FAILED_ROUND_DELAY, :STATEMENT_LEASE_LIMIT

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

        # The delay before the heartbeat asks again for a connection, after +failures+ refused
        # attempts in a row, in seconds: REACQUIRE_BASE doubled for each earlier failure, with
        # jitter, and at most +interval+.
        def self.reacquire_delay(failures, interval, random = rand(0.9..1.1))
          [[REACQUIRE_BASE, interval].min * (2**[failures - 1, 16].min) * random, interval].min
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
          @users = {}.compare_by_identity
          @wake = Concurrent::Event.new
          @thread = nil
          # The heartbeat thread that holds a usable connection, or nil. A thread that loses its
          # connection clears only its own mark, so an ending thread cannot clear the mark of the
          # thread that replaced it.
          @holder = Concurrent::AtomicReference.new
          @ready = Concurrent::Event.new
          # The current Acquisition: pending, arrived, held, or still on its way back to the pool.
          # At most one exists, so repeated timeouts start no second checkout. Only its checkout
          # thread clears it, after the pool has the connection back. Guarded by @lock.
          @acquisition = nil
          # The Acquisition the heartbeat thread runs its rounds on. Only that thread uses it.
          @held = nil
          # The current readiness Probe. Guarded by @lock.
          @probe = nil
          # The busy members of the latest round, which a retry renews before the next regular
          # round, and the monotonic time when that retry falls due. A round of either kind
          # replaces both. Only the heartbeat thread uses them.
          @busy = nil
          @busy_at = 0
        end

        # Adds +member+ and returns a callable that removes it. Removing twice is harmless. A member
        # with a shorter interval than every other wakes the thread, which then reschedules its
        # next round from the new interval. The first member wakes a thread that holds its
        # connection for workers only.
        def register(member)
          key = [member.worker_id, member.task.id]
          @lock.synchronize do
            shortest = @members.each_value.map(&:interval).min
            @members[key] = member
            @wake.set if shortest.nil? || member.interval < shortest
            start
          end
          lambda do
            @lock.synchronize do
              @members.delete(key) if @members[key].equal?(member)
              @wake.set if @members.empty?
            end
          end
        end

        # Adds a running worker with the heartbeat +interval+ in seconds, and returns its
        # Reservation. The heartbeat then holds its connection until the last worker closes its
        # reservation and no member remains. +on_ready+ runs each time a connection is ready
        # again. A thread that waits before its next attempt tries again at once.
        def reserve(interval, on_ready)
          user = User.new(interval, on_ready)
          @lock.synchronize do
            @users[user] = true
            @wake.set
            start
          end
          Reservation.new(self, user)
        end

        # Removes +user+. The last user wakes the heartbeat thread, which returns the connection when
        # no member remains either. That user waits for the thread at most +timeout+ seconds, and at
        # most RELEASE_WAIT, so a stop never waits for a round in flight or past its deadline.
        def release(user, timeout = RELEASE_WAIT)
          thread = @lock.synchronize do
            next unless @users.delete(user) && @users.empty?

            @wake.set
            @thread if @members.empty?
          end
          wait = timeout.clamp(0, RELEASE_WAIT)
          begin
            thread&.join(wait) unless Thread.current.equal?(thread) || !wait.positive?
          rescue Exception # rubocop:disable Lint/RescueException
            # A heartbeat thread that ended with an error must not fail the stop of a worker.
            nil
          end
          nil
        end

        # Borrows one connection that is not the heartbeat connection, on a probe thread, yields it
        # to +query+, and waits until +deadline+, a monotonic time. Returns the Probe, which is done
        # when the query ended in time. One probe runs at a time for each pool: a start that finds a
        # probe still running waits for that probe, so repeated timeouts start no second borrow. The
        # probe thread owns a connection that it gets late, and returns it when its query ends.
        def readiness(deadline, &query)
          probe = @lock.synchronize do
            @probe = nil if @probe&.done&.set?
            @probe ||= start_probe(deadline, query)
          end
          remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          probe.done.wait(remaining) if remaining.positive?
          probe
        end

        # Whether a live heartbeat thread holds a usable connection. After a fork, the mark of a
        # thread of the parent process reads as not ready.
        def ready?
          holder = @holder.get
          !holder.nil? && holder.alive?
        end

        def wait_ready(timeout)
          @ready.wait(timeout)
          ready?
        end

        private

        # Starts the heartbeat thread unless it runs. The caller holds @lock.
        def start
          return if @thread&.alive?

          @wake.reset
          # The thread names itself before its first checkout, so a pool can tell its checkouts apart.
          @thread = Thread.new do
            Thread.current.name = "workhorse-heartbeats"
            run
          end
        end

        def run
          # The start of the latest round, on the monotonic clock. A new connection keeps it, so a
          # failed round does not start a new schedule.
          @previous = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          @busy = nil
          @dedicated ? run_dedicated : run_shared
        ensure
          lost
        end

        # Starts the readiness Probe. The caller holds @lock. A ConnectionPool lends the connection
        # within the time left before +deadline+.
        def start_probe(deadline, query)
          probe = Probe.new
          Thread.new do
            Thread.current.name = "workhorse-readiness"
            remaining = [deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), MINIMUM_REMAINING].max
            borrow = lambda do |connection|
              probe.lent = true
              probe.result = query.call(connection)
            end
            @source.is_a?(::ConnectionPool) ? @source.with(timeout: remaining, &borrow) : @source.with(&borrow)
          rescue => e
            probe.error = e
          ensure
            probe.done.set
          end
          probe
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

        # Holds one connection across rounds, also while no member remains and a worker still
        # runs. Each attempt waits at most one round bound for its checkout (+acquire+). A round
        # that fails or overruns discards the connection, and so does a probe that finds it unusable
        # (+usable?+). The thread then asks for a new one at once. A refused or late attempt waits
        # +Heartbeat.reacquire_delay+ before the next. A +reserve+, and a connection that arrives,
        # end that wait. A round that expires before its heartbeat statement keeps the connection
        # (+bounded_rows+).
        #
        # The claim gate opens when a checkout passes +usable?+. It closes before the thread ends
        # a checkout, so it is closed whenever the thread has no usable connection. The thread stays
        # registered until the pool has the connection back. Only then does it read whether a
        # worker or a member arrived meanwhile, and it ends only if none did.
        def run_dedicated
          failures = 0
          loop do
            interval = @lock.synchronize { interval_or_stop }
            return if interval.nil?

            acquisition = acquire(interval)
            if acquisition.nil?
              lost
              failures += 1
            else
              @held = acquisition
              failures = hold_rounds(acquisition, failures)
              @held = nil
            end
            next if failures.zero?

            @wake.wait(Heartbeat.reacquire_delay(failures, interval))
            @wake.reset
          end
        ensure
          held = @held
          @held = nil
          held&.finish(discard: true)
        end

        # The shortest interval of the members and the workers. When none remains, a connection
        # that arrived but was not taken goes back to the pool, the thread unregisters, and this
        # returns nil. The cycle stays current until its checkout thread has returned the
        # connection, so a later heartbeat thread waits for it (+acquire+). The caller holds @lock.
        def interval_or_stop
          interval = shortest_of_all
          return interval if interval

          acquisition = @acquisition
          acquisition.finish(discard: false) if acquisition&.arrived&.set? && !acquisition.adopted
          @thread = nil
          clear_mark
          nil
        end

        # Returns the arrived Acquisition with its connection, or nil when none is ready within the
        # round bound of +interval+. A checkout that is still pending stays the current one, so the
        # next attempt waits for it again and starts no second checkout. A cycle that ends, or whose
        # checkout failed, also stays current until its checkout thread has settled the return. This
        # waits for that at most one round bound, and starts no checkout meanwhile.
        def acquire(interval)
          bound = round_bound(interval)
          acquisition = @lock.synchronize { @acquisition ||= start_acquisition(interval) }
          if acquisition.finished?
            acquisition.returned.wait(bound)
            return nil
          end

          acquisition.arrived.wait(bound)
          @lock.synchronize do
            next nil unless acquisition.arrived.set? && acquisition.connection && !acquisition.finished?

            acquisition.adopted = true
            acquisition
          end
        end

        # Starts the checkout thread of +acquisition+. The caller holds @lock. The thread runs the
        # whole cycle in order: the checkout, the hand-over or the disposal, and the return. Only
        # after the pool has the connection back does it clear the current cycle and set
        # +returned+, under one lock.
        def start_acquisition(interval)
          acquisition = Acquisition.new
          Thread.new do
            Thread.current.name = "workhorse-heartbeat-checkout"
            checkout(interval) { |connection| offer(acquisition, connection) }
          rescue => e
            # The pool refused a connection. The lease watchdog covers rounds that keep failing.
            @lock.synchronize do
              acquisition.error = e
              acquisition.finish(discard: false)
              acquisition.arrived.set
            end
          ensure
            @lock.synchronize do
              @acquisition = nil if @acquisition.equal?(acquisition)
              acquisition.returned.set
            end
            @wake.set
          end
          acquisition
        end

        # Runs on the checkout thread with the lent +connection+. If no worker and no member
        # remains, the cycle ends here, and the connection goes back to the pool. Otherwise the
        # thread hands it over, wakes the heartbeat, and holds the checkout until the heartbeat
        # finishes it.
        def offer(acquisition, connection)
          offered = @lock.synchronize do
            if @users.empty? && @members.empty?
              acquisition.finish(discard: false)
              next false
            end
            acquisition.connection = connection
            acquisition.arrived.set
            true
          end
          return unless offered

          @wake.set
          acquisition.wait_finish
          # The checkout belongs to this thread, so the discard of a pool runs here too.
          discard(connection) if acquisition.discard
        end

        # Runs rounds on the connection of +acquisition+ until nothing remains or the connection is
        # lost, and then ends the checkout (+end_checkout+). Returns the failure count for the
        # backoff. A connection that PostgreSQL already ended counts as a refused attempt, so a pool
        # that lends only such connections gets the backoff.
        def hold_rounds(acquisition, failures)
          connection = acquisition.connection
          unless usable?(connection)
            end_checkout(acquisition, discard: true)
            return failures + 1
          end

          ready
          rounds(probe: connection) { |sql, params, timeout| bounded_rows(connection, sql, params, timeout) }
          end_checkout(acquisition, discard: false)
          0
        rescue RoundTimeout, PG::Error
          end_checkout(acquisition, discard: true)
          0
        rescue
          # Any other error ends this connection too, and counts as a failed attempt, so the thread
          # keeps serving its workers and members with the backoff.
          end_checkout(acquisition, discard: true)
          failures + 1
        end

        # Closes the claim gate, ends the checkout, and waits until the pool has the connection
        # back. Only the checkout thread returns it, and it does nothing else first. The heartbeat
        # thread thus stays registered meanwhile, so a worker that reserves now cannot start a
        # second heartbeat thread or a second checkout.
        def end_checkout(acquisition, discard:)
          lost
          acquisition.finish(discard: discard)
          acquisition.returned.wait
        end

        # Checks out the heartbeat connection on the checkout thread. A ConnectionPool also ends
        # its queue wait at the round bound of +interval+, so a pending checkout does not wait much
        # longer than the heartbeat does.
        def checkout(interval, &)
          if @source.is_a?(::ConnectionPool)
            @source.with(timeout: round_bound(interval), &)
          else
            @source.with(&)
          end
        end

        # Marks the connection of this thread usable, and wakes each worker.
        def ready
          callbacks = @lock.synchronize do
            @holder.set(Thread.current)
            @ready.set
            @users.keys.map(&:on_ready)
          end
          callbacks.each do |callback|
            callback.call
          rescue
            nil
          end
        end

        # Clears the mark of this thread. The claim gate of every worker on the pool closes.
        def lost
          @lock.synchronize { clear_mark }
        end

        # Clears the mark of this thread. The caller holds @lock.
        def clear_mark
          @ready.reset if @holder.compare_and_set(Thread.current, nil)
        end

        # Whether +connection+ can still run a round. Between rounds the connection has no
        # statement in flight, so any input there is an error or the end of the session. A
        # terminated backend thus reads as unusable here, before the next round sends on it.
        def usable?(connection)
          return false unless connection.status == PG::CONNECTION_OK

          2.times do
            break unless IO.select([connection.socket_io], nil, nil, 0)

            connection.consume_input
          end
          connection.status == PG::CONNECTION_OK
        rescue PG::Error, IOError, SystemCallError
          false
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
        #
        # With a +probe+ connection, the thread holds that connection while a worker runs and no
        # member remains, and it checks the connection at least every PROBE_INTERVAL. An unusable
        # connection raises PG::ConnectionBad. The first member after such an idle hold has its
        # first round one interval after it arrived.
        def rounds(probe: nil, &)
          loop do
            interval = shortest_interval_or_stop
            if interval.nil?
              @busy = nil
              return true
            end
            raise PG::ConnectionBad, "heartbeat connection lost" if probe && !usable?(probe)

            if interval.is_a?(Idle)
              @busy = nil
              @previous = nil
              @wake.wait(PROBE_INTERVAL)
              @wake.reset
              next
            end
            @previous ||= Process.clock_gettime(Process::CLOCK_MONOTONIC)

            regular_at = @previous + interval
            retrying = !@busy.nil? && @busy_at < regular_at
            remaining = (retrying ? @busy_at : regular_at) - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            if remaining.positive?
              @wake.wait(probe ? [remaining, PROBE_INTERVAL].min : remaining)
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

              send_round(selection, deadline, interval, &)
              next
            end
            @previous = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            # The deadline starts before the payloads are built, so serialization counts against it.
            deadline = @previous + round_bound(interval)
            members = members_or_stop
            return true if members.nil?
            next if members.empty?

            send_round(members, deadline, interval, &)
          end
        end

        # Sends one round for +members+. The members of each worker form batches of at most
        # +STATEMENT_LEASE_LIMIT+ leases (+batches+). A worker can hold more members than its
        # concurrency, because a fused completion claim registers its tasks before the completing
        # attempts unregister.
        #
        # On the dedicated connection, one heartbeat_pool_v1 statement in one transaction renews
        # every batch of every worker, by the one +deadline+ (+send_pooled+). The round is
        # all-or-nothing: if the statement or COMMIT fails, no lease of the round counts. A
        # borrowing heartbeat has no deadline, and sends one heartbeat_many_v2 statement for each
        # batch (+send_each+).
        #
        # A round replaces the pending busy retry. If one or more members are busy, it schedules one
        # retry for them. A round that raises or expires schedules none, and the next regular round
        # tries again.
        def send_round(members, deadline, interval, &)
          @busy = nil
          batches = batches(members)
          busy = @dedicated ? send_pooled(batches, deadline, &) : send_each(batches, deadline, &)
          return if busy.empty?

          @busy = busy
          @busy_at = Process.clock_gettime(Process::CLOCK_MONOTONIC) + Heartbeat.busy_retry_delay(interval)
        end

        # Sends every batch in one heartbeat_pool_v1 statement, and returns the busy members. Each
        # row names its batch by its 1-based position in the payload, so the statuses go back to
        # the members of that batch. A round that expires before its heartbeat statement
        # (+RoundExpired+) renews nothing, and the caller keeps the connection. RoundTimeout and
        # PG::Error go to the caller, which discards the connection. Each round that gets no
        # statuses, also one with no time left after serialization, counts once in
        # +workhorse.worker.heartbeat.round_failure+.
        def send_pooled(batches, deadline)
          sent_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          payload = batches.map { |worker_id, group| {"workerId" => worker_id, "leases" => leases(group)} }
          params = [JSON.generate(payload)]
          timeout = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          unless timeout.positive?
            Telemetry.record_heartbeat_round_failure(RoundExpired.new)
            return []
          end

          rows = begin
            yield SqlCatalogue::HEARTBEAT_POOL_V1, params, timeout
          rescue RoundExpired => e
            Telemetry.record_heartbeat_round_failure(e)
            return []
          rescue RoundTimeout, PG::Error => e
            Telemetry.record_heartbeat_round_failure(e)
            raise
          rescue => e
            # A skipped round sends no log record: the lease watchdog handles rounds that keep failing.
            Telemetry.record_heartbeat_round_failure(e)
            return []
          end
          statuses = Array.new(batches.size) { {} }
          rows.each do |row|
            batch = Integer(row["batch"], 10) - 1
            statuses[batch][row["task_id"]] = row["status"] if batch.between?(0, batches.size - 1)
          end
          batches.each_with_index.flat_map { |(_worker_id, group), index| settle(group, statuses[index], sent_at) }
        end

        # Sends one heartbeat_many_v2 statement for each batch through the executor, and returns the
        # busy members. A batch whose statement fails gets nothing, and the other batches still go.
        # A round with one or more failed statements counts once in
        # +workhorse.worker.heartbeat.round_failure+, with the reason of its first failure. The count
        # occurs when that failure occurs, so a later batch that stalls does not delay it.
        def send_each(batches, deadline)
          failed = false
          batches.flat_map do |worker_id, group|
            sent_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            params = [worker_id, JSON.generate(leases(group))]
            rows = begin
              yield SqlCatalogue::HEARTBEAT_MANY_V2, params, deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            rescue => e
              # A skipped round sends no log record: the lease watchdog handles rounds that keep failing.
              Telemetry.record_heartbeat_round_failure(e) unless failed
              failed = true
              next []
            end
            settle(group, rows.to_h { |row| [row["task_id"], row["status"]] }, sent_at)
          end
        end

        # The lease objects of heartbeat_many_v2 for the members of one batch.
        def leases(group)
          group.map do |member|
            {"taskId" => member.task.id, "fenceToken" => member.task.fence_token.to_s, "leaseMs" => member.lease_ms}
          end
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

        # The batches of one round, as [worker_id, members] pairs: the members of each worker, split
        # into slices of at most +STATEMENT_LEASE_LIMIT+ members.
        def batches(members)
          members.group_by(&:worker_id).flat_map do |worker_id, group|
            group.each_slice(STATEMENT_LEASE_LIMIT).map { |slice| [worker_id, slice] }
          end
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

        # Ends a borrowing heartbeat thread when no member and no worker remains, and returns true
        # then. A register that races this starts a new one.
        def stop_if_idle
          @lock.synchronize do
            unused = @members.empty? && @users.empty?
            if unused
              @thread = nil
              clear_mark
            end
            unused
          end
        end

        # The shortest member interval; an Idle with the shortest worker interval when only workers
        # remain; or nil when nothing remains. Nil also ends a borrowing heartbeat thread. The read
        # and the end take one lock, so a register between them cannot find a thread that is about
        # to end. A dedicated thread ends later, in +interval_or_stop+, after the pool has its
        # connection back.
        def shortest_interval_or_stop
          @lock.synchronize do
            next @members.each_value.map(&:interval).min unless @members.empty?
            next Idle.new(@users.each_key.map(&:interval).min) unless @users.empty?

            @thread = nil unless @dedicated
            nil
          end
        end

        # The current members; an empty Array when only workers remain; or nil when nothing
        # remains. Nil also ends a borrowing heartbeat thread, under the same lock as the read
        # (+shortest_interval_or_stop+).
        def members_or_stop
          @lock.synchronize do
            next @members.values unless @members.empty?
            next [] unless @users.empty?

            @thread = nil unless @dedicated
            nil
          end
        end

        # The shortest interval of the members and the workers, or nil when nothing remains.
        def current_interval = @lock.synchronize { shortest_of_all }

        # The same as +current_interval+. The caller holds @lock.
        def shortest_of_all = [*@members.each_value.map(&:interval), *@users.each_key.map(&:interval)].min

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
        # heartbeat, and one idle gap before COMMIT. So the heartbeat gets one quarter, each gap one
        # quarter, and the last quarter is kept for the settings statement and COMMIT. No setting
        # bounds COMMIT itself.
        def round_timeouts(remaining)
          milliseconds = (remaining * 1000).floor
          [[1, milliseconds / 4].max.to_s, [1, milliseconds / 4].max.to_s]
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
