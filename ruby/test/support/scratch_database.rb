# frozen_string_literal: true

require "digest"
require "uri"

# A per-process scratch PostgreSQL database for the Ruby integration tests.
#
# A database test never uses the checkout's `test` database directly. It derives a scratch
# database from `DATABASE_URL_TEST`, named after that database plus a per-process digest, installs
# `sql/schema/current.sql` into it, and drops it when the run ends. `pnpm db:sweep` recognizes the
# same name shape if a teardown never runs.
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

    def drop
      return unless @name

      with_admin { |admin| drop_database(admin, @name) }
      report("dropped scratch database #{@name}")
    rescue PG::Error => e
      report("could not drop scratch database #{@name}: #{e.message}; run pnpm db:sweep")
      raise
    ensure
      @name = nil
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
      name = scratch_name(source_name, Process.pid)
      with_admin do |admin|
        drop_database(admin, name)
        admin.exec("CREATE DATABASE #{PG::Connection.quote_ident(name)}")
      end
      # Owned from here on, so a failed schema install still drops the database.
      @name = name
      Minitest.after_run { drop }
      scratch_url = replace_database(source, name)
      connection = PG.connect(scratch_url, connect_timeout: CONNECT_TIMEOUT)
      begin
        connection.exec(File.read(SCHEMA))
      ensure
        connection.close
      end
      report("running against scratch database #{name}")
      scratch_url
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
    def scratch_name(source, process)
      digest = Digest::SHA256.hexdigest("ruby:#{process}")[0, 10]
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
end
