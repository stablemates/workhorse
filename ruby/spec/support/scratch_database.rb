# frozen_string_literal: true

require "digest"
require "uri"

# A per-process scratch PostgreSQL database for the Ruby integration tests.
#
# A database test never uses the checkout's `test` database directly. It derives a scratch
# database from `DATABASE_URL_TEST`, named after that database plus a per-process digest, installs
# `sql/schema/current.sql` into it, and `spec_helper.rb` drops it after the suite. `pnpm db:sweep`
# recognizes the same name shape if that hook never runs.
#
# A session on `postgres` holds the lease of the scratch database and of each extra database from
# before its creation until after its drop: a shared advisory lock on `hashtextextended(<name>, 0)`.
# A test can have no session on a scratch database, and `pnpm db:sweep` skips a scratch database
# under that lock. If the process stops or crashes, PostgreSQL ends the session and its locks, so
# the sweep can drop the databases again (SM-1702).
#
# The scratch database and each extra database set `synchronous_commit = off`, so a host I/O stall
# does not add a WAL flush wait to each commit of a test (SM-1809).
#
# All examples of the process share the scratch database, so `reset` runs before each example that
# uses it. Otherwise an example can see the rows, the `maintenance_state` values, and the policy
# rows that an earlier example left, and its result depends on the order (SM-1732).
#
# Without `DATABASE_URL_TEST` a local run skips with a visible reason. CI, or
# `WORKHORSE_REQUIRE_DATABASE=1`, turns that skip into a failure, and a database that is set but
# unreachable always fails.
module ScratchDatabase
  SCHEMA = File.expand_path("../../../sql/schema/current.sql", __dir__)
  LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"].freeze
  DROP_ATTEMPTS = 40
  DROP_RETRY = 0.025
  CONNECT_TIMEOUT = 10
  # Shared with `scratchLeaseStatement` in `typescript/core/test/support/schema-template.ts`.
  LEASE = "SELECT pg_advisory_lock_shared(hashtextextended($1, 0))"
  RELEASE = "SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))"

  # The statements of `reset`. They come from `createDatabaseTestHarness` in
  # `typescript/core/test/support/db.ts`, and the JVM and .NET test support use the same text. The
  # TypeScript reset keeps the three policy tables. This reset empties them and inserts the rows
  # that `POLICY_SNAPSHOT` read after the schema install.
  RESET_TABLES = <<~SQL
    SELECT format('%I.%I', namespace.nspname, relation.relname) AS table_name
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'workhorse'
       AND relation.relkind IN ('r', 'p')
       AND relation.relname <> ALL (ARRAY[
         'schema_version', 'schema_migration', 'protocol_version', 'maintenance_state',
         'task_stat_state'
       ])
       AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = relation.oid)
     ORDER BY relation.relname
  SQL
  MAINTENANCE_STATE_RESET = <<~SQL
    UPDATE workhorse.maintenance_state SET
      last_started_at = NULL,
      last_completed_at = NULL,
      last_completed_local_date = NULL,
      history_retained_before = CASE WHEN routine_name = 'history_retention'
        THEN date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          - interval '14 days'
        ELSE NULL END,
      terminal_prune_dependency_starved = false,
      terminal_prune_fast_first = false,
      terminal_cleanup_backlog_since = NULL,
      lease_recovery_started_at = NULL,
      updated_at = clock_timestamp()
  SQL
  # The columns of maintenance_state that MAINTENANCE_STATE_RESET knows.
  MAINTENANCE_COLUMNS = %w[
    history_retained_before last_completed_at last_completed_local_date last_started_at
    lease_recovery_started_at routine_name terminal_cleanup_backlog_since
    terminal_prune_dependency_starved terminal_prune_fast_first updated_at
  ].freeze
  POLICY_SNAPSHOT = <<~SQL
    SELECT jsonb_build_object(
      'maintenance_policy', (SELECT to_jsonb(policy) FROM workhorse.maintenance_policy AS policy),
      'queue_health_policy', (SELECT to_jsonb(policy) FROM workhorse.queue_health_policy AS policy),
      'retention_policy', (SELECT to_jsonb(policy) FROM workhorse.retention_policy AS policy)
    )::text
  SQL
  POLICY_RESTORE = <<~SQL
    WITH policies AS (SELECT $1::jsonb AS value),
    maintenance AS (
      INSERT INTO workhorse.maintenance_policy
      SELECT * FROM jsonb_populate_record(
        NULL::workhorse.maintenance_policy, (SELECT value -> 'maintenance_policy' FROM policies)
      )
    ),
    queue_health AS (
      INSERT INTO workhorse.queue_health_policy
      SELECT * FROM jsonb_populate_record(
        NULL::workhorse.queue_health_policy, (SELECT value -> 'queue_health_policy' FROM policies)
      )
    )
    INSERT INTO workhorse.retention_policy
    SELECT * FROM jsonb_populate_record(
      NULL::workhorse.retention_policy, (SELECT value -> 'retention_policy' FROM policies)
    )
  SQL
  LOCK_HOLDERS = <<~SQL
    SELECT pid, state, left(query, 200) AS query FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()
  SQL
  RESET_LOCK_WAIT = 30
  # 55P03 is lock_not_available, the error of an expired lock_timeout.
  LOCK_NOT_AVAILABLE = "55P03"

  class << self
    # The scratch database URL, created on first use; nil when a local run has no database.
    def url
      @mutex.synchronize do
        return @url if @created

        @created = true
        @url = create
      end
    end

    # A new connection to the scratch database. The caller closes it.
    def connect = PG.connect(url, connect_timeout: CONNECT_TIMEOUT)

    # Whether the tests that need PostgreSQL skip.
    def skip_reason
      return nil if url

      "DATABASE_URL_TEST is unset"
    end

    # Another scratch database beside the process's own, with a fresh schema its caller may
    # rewrite. Nil when a local run has no database. `drop_extra` or `drop` removes it.
    def extra(label)
      return nil unless url

      @mutex.synchronize do
        name = scratch_name(@source_name, "#{Process.pid}:#{label}")
        @extras << name
        install(name)
      end
    end

    def drop_extra(label)
      name = scratch_name(@source_name, "#{Process.pid}:#{label}")
      @mutex.synchronize { discard(name) if @extras.delete(name) }
    end

    # Return the scratch database to its install state on +connection+, a session of that database.
    #
    # The reset runs in one transaction. It empties every table apart from the version tables and
    # the routine state. It returns each maintenance_state column to its install value. Then it
    # inserts the policy rows that the harness read after the schema install.
    #
    # TRUNCATE locks each table in list order, and a worker statement of an earlier example can lock
    # the same tables in another order. PostgreSQL looks for a deadlock only after
    # `deadlock_timeout`, and the lock wait of each attempt ends before that. The reset then rolls
    # back and tries again (SM-1436). If the locks stay held, the error names the sessions.
    def reset(connection)
      deadlock_ms = Integer(connection.exec("SELECT setting FROM pg_settings WHERE name = 'deadlock_timeout'")
        .getvalue(0, 0), 10)
      lock_timeout_ms = (deadlock_ms / 5).clamp(1, 200)
      tables = connection.exec(RESET_TABLES).column_values(0)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + RESET_LOCK_WAIT
      begin
        connection.transaction do
          connection.exec("SET LOCAL lock_timeout = #{lock_timeout_ms}")
          connection.exec("TRUNCATE #{tables.join(", ")} RESTART IDENTITY CASCADE")
          connection.exec(MAINTENANCE_STATE_RESET)
          connection.exec_params(POLICY_RESTORE, [@policies])
        end
      rescue PG::Error => e
        raise unless e.result&.error_field(PG::Result::PG_DIAG_SQLSTATE) == LOCK_NOT_AVAILABLE

        if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
          raise "The reset could not lock the tables within #{RESET_LOCK_WAIT} s. " \
            "Sessions of the scratch database: #{connection.exec(LOCK_HOLDERS).to_a}"
        end
        sleep 0.02
        retry
      end
    end

    def drop
      discard(@extras.pop) until @extras.empty?
      return unless @name

      discard(@name)
    ensure
      @name = nil
      # The lease ends after the drops. If a drop failed, the sweep can drop the database.
      @lease&.close
      @lease = nil
    end

    private

    def create
      source = ENV.fetch("DATABASE_URL_TEST", "")
      if source.empty?
        if database_required?
          raise "DATABASE_URL_TEST is unset, but this run requires PostgreSQL (CI or WORKHORSE_REQUIRE_DATABASE=1)"
        end

        report("SKIPPED database tests: DATABASE_URL_TEST is unset")
        return nil
      end

      options = PG::Connection.conninfo_parse(source).to_h { |option| [option[:keyword], option[:val]] }
      hosts = options["host"].to_s.split(",")
      hosts.each do |host|
        next if host.empty? || host.start_with?("/") || LOOPBACK.include?(host)

        raise "Ruby integration tests refuse a non-loopback database: #{host}"
      end
      source_name = options["dbname"].to_s
      raise "DATABASE_URL_TEST must name a test database" unless source_name.include?("test")

      @source = source
      @source_name = source_name
      @lease = PG.connect(replace_database(source, "postgres"), connect_timeout: CONNECT_TIMEOUT)
      name = scratch_name(source_name, Process.pid)
      # Owned before it exists, so a failed schema install still drops the database.
      @name = name
      scratch_url = install(name)
      connection = PG.connect(scratch_url, connect_timeout: CONNECT_TIMEOUT)
      begin
        @policies = connection.exec(POLICY_SNAPSHOT).getvalue(0, 0)
      ensure
        connection.close
      end
      scratch_url
    end

    # Create +name+ afresh and install the current schema into it.
    #
    # A scratch database is for tests only, so its commits do not wait for the WAL flush. A host
    # I/O stall can make one flush take seconds, and a lease of a few seconds then lapses although
    # the worker is correct (SM-1809). Visibility and order do not change. Only a server crash can
    # lose such a commit, and no Ruby test restarts PostgreSQL or reads the WAL.
    def install(name)
      @lease.exec_params(LEASE, [name])
      with_admin do |admin|
        drop_database(admin, name)
        admin.exec("CREATE DATABASE #{PG::Connection.quote_ident(name)}")
        admin.exec("ALTER DATABASE #{PG::Connection.quote_ident(name)} SET synchronous_commit = off")
      end
      scratch_url = replace_database(@source, name)
      connection = PG.connect(scratch_url, connect_timeout: CONNECT_TIMEOUT)
      begin
        connection.exec(File.read(SCHEMA))
      ensure
        connection.close
      end
      report("running against scratch database #{name}")
      scratch_url
    end

    def discard(name)
      with_admin { |admin| drop_database(admin, name) }
      @lease.exec_params(RELEASE, [name])
      report("dropped scratch database #{name}")
    rescue PG::Error => e
      report("could not drop scratch database #{name}: #{e.message}; run pnpm db:sweep")
      raise
    end

    def with_admin
      admin = PG.connect(replace_database(@source, "postgres"), connect_timeout: CONNECT_TIMEOUT)
      admin.set_notice_processor { |_notice| nil }
      yield admin
    ensure
      admin&.close
    end

    # Drop +name+, waiting out short-lived sessions the test role does not own.
    #
    # `WITH (FORCE)` signals every connected role, which the local test role cannot do. Terminate
    # only this role's sessions first, and retry while foreign sessions such as autovacuum finish.
    def drop_database(admin, name)
      attempt = 1
      begin
        admin.exec_params(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " \
          "WHERE datname = $1 AND usename = current_user AND pid <> pg_backend_pid()",
          [name]
        )
        admin.exec("DROP DATABASE IF EXISTS #{PG::Connection.quote_ident(name)}")
      rescue PG::ObjectInUse
        raise if attempt >= DROP_ATTEMPTS

        sleep DROP_RETRY
        attempt += 1
        retry
      end
    end

    def database_required?
      %w[CI WORKHORSE_REQUIRE_DATABASE].any? { |key| !["", "0", "false"].include?(ENV.fetch(key, "")) }
    end

    # `<source>_rb_<digest>`, the scratch shape `pnpm db:sweep` recognizes, within 63 bytes.
    def scratch_name(source, owner)
      digest = Digest::SHA256.hexdigest("ruby:#{owner}")[0, 10]
      "#{source[0, 44]}_rb_#{digest}"
    end

    def replace_database(url, database)
      uri = URI.parse(url)
      uri.path = "/#{database}"
      uri.to_s
    end

    def report(message) = warn("[workhorse ruby db] #{message}")
  end

  @mutex = Mutex.new
  @created = false
  @extras = []
end
