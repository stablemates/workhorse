# frozen_string_literal: true

# A host I/O stall can make a WAL flush take seconds, so a commit in a test does not wait for it
# (SM-1809). A new session of the scratch database and of an extra database takes the setting.
RSpec.describe "The scratch databases of the Ruby tests" do
  include_context "with a scratch database"

  def synchronous_commit(connection) = connection.exec("SHOW synchronous_commit").getvalue(0, 0)

  it "commits without waiting for the WAL flush" do
    expect(synchronous_commit(@connection)).to eq("off")

    extra = PG.connect(ScratchDatabase.extra("synchronous_commit"))
    begin
      expect(synchronous_commit(extra)).to eq("off")
    ensure
      extra.close
      ScratchDatabase.drop_extra("synchronous_commit")
    end
  end

  # `pnpm db:sweep` takes this lock with no wait before it drops a scratch database. A test can have
  # no session on a scratch database, so only the lease keeps the sweep away (SM-1702).
  def sweep_locks?(sweep, url)
    name = URI.parse(url).path.delete_prefix("/")
    locked = sweep.exec_params("SELECT pg_try_advisory_lock(hashtextextended($1, 0))", [name]).getvalue(0, 0) == "t"
    sweep.exec_params("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [name]) if locked
    locked
  end

  it "keeps the sweep away from the scratch database and an extra database until their drop" do
    admin = URI.parse(ScratchDatabase.url)
    admin.path = "/postgres"
    sweep = PG.connect(admin.to_s)
    begin
      expect(sweep_locks?(sweep, ScratchDatabase.url)).to be(false)

      extra = ScratchDatabase.extra("sweep_lease")
      expect(sweep_locks?(sweep, extra)).to be(false)
      ScratchDatabase.drop_extra("sweep_lease")
      expect(sweep_locks?(sweep, extra)).to be(true)
    ensure
      sweep.close
    end
  end

  # All examples share one scratch database, so a reset before each example returns it to its
  # install state (SM-1732).
  describe "the reset before each example" do
    def maintenance_state
      @connection.exec(<<~SQL).to_a
        SELECT routine_name, last_started_at, last_completed_at, last_completed_local_date,
               CASE WHEN routine_name = 'history_retention'
                 THEN history_retained_before IN (
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - interval '14 days',
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - interval '15 days')
                 ELSE history_retained_before IS NULL
               END AS history_retained_before_is_default,
               terminal_prune_dependency_starved, terminal_prune_fast_first,
               terminal_cleanup_backlog_since, lease_recovery_started_at,
               updated_at > timestamptz '2001-01-01 00:00:00+00' AS updated_at_is_reset
          FROM workhorse.maintenance_state ORDER BY routine_name
      SQL
    end

    def policies = JSON.parse(@connection.exec(ScratchDatabase::POLICY_SNAPSHOT).getvalue(0, 0))

    def without_updated_at(policies) = policies.transform_values { |row| row.except("updated_at") }

    it "empties the rows and returns the routine state and the policy rows to the install values" do
      installed = policies
      queue.enqueue("leftover", {})
      @connection.exec("INSERT INTO workhorse.queue_control(queue_name, paused) VALUES ('rb-leftover', true)")
      @connection.exec(<<~SQL)
        UPDATE workhorse.maintenance_state SET
          last_started_at = clock_timestamp(),
          last_completed_at = clock_timestamp(),
          last_completed_local_date = CASE WHEN routine_name = 'history_retention' THEN current_date END,
          history_retained_before = CASE WHEN routine_name = 'history_retention' THEN clock_timestamp() END,
          terminal_prune_dependency_starved = routine_name = 'terminal_storage',
          terminal_prune_fast_first = true,
          terminal_cleanup_backlog_since = clock_timestamp(),
          lease_recovery_started_at = clock_timestamp(),
          updated_at = timestamptz '2000-01-01 00:00:00+00'
      SQL
      @connection.exec("UPDATE workhorse.maintenance_policy SET timezone = 'Europe/Berlin'")
      @connection.exec("UPDATE workhorse.queue_health_policy SET promotion_lag_ms = 1")
      @connection.exec("UPDATE workhorse.retention_policy SET terminal_task_prune_limit = 1")

      ScratchDatabase.reset(@connection)

      expect(@connection.exec("SELECT count(*) FROM workhorse.task").getvalue(0, 0)).to eq("0")
      expect(@connection.exec("SELECT count(*) FROM workhorse.queue_control").getvalue(0, 0)).to eq("0")
      expect(maintenance_state).to eq(%w[history_partitions history_retention terminal_storage tick].map do |routine|
        {
          "routine_name" => routine, "last_started_at" => nil, "last_completed_at" => nil,
          "last_completed_local_date" => nil, "history_retained_before_is_default" => "t",
          "terminal_prune_dependency_starved" => "f", "terminal_prune_fast_first" => "f",
          "terminal_cleanup_backlog_since" => nil, "lease_recovery_started_at" => nil,
          "updated_at_is_reset" => "t"
        }
      end)
      expect(policies).to eq(installed)
      expect([
        policies.dig("maintenance_policy", "timezone"),
        policies.dig("queue_health_policy", "promotion_lag_ms"),
        policies.dig("retention_policy", "terminal_task_prune_limit")
      ]).to eq(["UTC", 10_000, 1000])
    end

    describe "in a fixed order", order: :defined do
      it "leaves a task and routine state behind" do
        queue.enqueue("leftover", {})
        @connection.exec("UPDATE workhorse.maintenance_state SET terminal_prune_fast_first = true")
        expect(task_count).to eq(1)
      end

      it "starts the next example without them" do
        expect(@connection.exec("SELECT count(*) FROM workhorse.task").getvalue(0, 0)).to eq("0")
        expect(@connection.exec("SELECT bool_or(terminal_prune_fast_first) FROM workhorse.maintenance_state")
          .getvalue(0, 0)).to eq("f")
      end
    end

    it "knows every column of maintenance_state" do
      columns = @connection.exec(<<~SQL).column_values(0)
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'workhorse' AND table_name = 'maintenance_state'
         ORDER BY column_name
      SQL
      expect(columns).to eq(ScratchDatabase::MAINTENANCE_COLUMNS)
    end
  end
end
