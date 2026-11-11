# frozen_string_literal: true

require "connection_pool"
require "json"
require "stringio"
require "timeout"

# The bounded read of the Rack host: a broken pooled connection leaves the pool, and one
# caller-owned connection runs one procedure at a time.
RSpec.describe "Dashboard read bound" do
  before do
    reason = ScratchDatabase.skip_reason
    skip(reason) if reason
  end

  define_method(:request) do |host, procedure, input = nil|
    body = JSON.generate({"json" => input})
    status, _headers, chunks = host.call({
      "REQUEST_METHOD" => "POST", "SCRIPT_NAME" => "", "PATH_INFO" => "/workhorse/rpc/dashboard/#{procedure}",
      "rack.url_scheme" => "https", "HTTP_HOST" => "example.test", "HTTP_ORIGIN" => "https://example.test",
      "CONTENT_TYPE" => "application/json", "CONTENT_LENGTH" => body.bytesize.to_s,
      "rack.input" => StringIO.new(body)
    })
    [status, chunks.join]
  end

  define_method(:host) do |executor|
    W::Dashboard.new(executor, authorize: ->(_env) { W::Dashboard::Principal.new("operator") })
  end

  it "discards a pooled connection that a read leaves broken" do
    url = ScratchDatabase.url
    created = 0
    pool = ConnectionPool.new(size: 1, timeout: 2) do
      created += 1
      PG.connect(url)
    end
    admin = PG.connect(url)
    begin
      dashboard = host(pool)
      expect(request(dashboard, "meta").first).to eq(200)
      admin.exec_params("SELECT pg_terminate_backend($1)", [pool.with(&:backend_pid)])

      request(dashboard, "queues")
      status, body = request(dashboard, "queues")

      expect(status).to eq(200), body
      expect(created).to eq(2)
    ensure
      admin.close
      pool.shutdown(&:close)
    end
  end

  # A source whose +with+ yields the same connection to each request.
  shared_source = Class.new do
    def initialize(connection)
      @connection = connection
    end

    def with = yield(@connection)
  end

  {"a PG::Connection" => ->(connection) { connection },
   "a with source of one connection" => ->(connection) { shared_source.new(connection) }}.each do |form, wrap|
    it "runs a control after a read on #{form}, not inside the read transaction" do
      connection = ScratchDatabase.connect
      entered = Thread::Queue.new
      proceed = Thread::Queue.new
      reader = nil
      begin
        dashboard = host(wrap.call(connection))
        expect(request(dashboard, "meta").first).to eq(200)
        exec = connection.method(:exec)
        connection.define_singleton_method(:exec) do |sql, *arguments|
          result = exec.call(sql, *arguments)
          if sql == "BEGIN READ ONLY"
            entered << true
            proceed.pop
          end
          result
        end
        reader = Thread.new { request(dashboard, "queues") }
        Timeout.timeout(5) { entered.pop }
        input = {"queue" => "read-bound", "paused" => true,
                 "audit" => {"actor" => "operator", "reason" => "test", "requestId" => "request-1"}}
        # Without the lock, the control runs inside the read-only transaction and fails with 500.
        control = Thread.new { request(dashboard, "setQueuePaused", input) }
        # The control waits on the lock, or without it runs on the connection, before the read goes on.
        Timeout.timeout(5) { Thread.pass until control.status == "sleep" || !control.alive? }
        proceed << true

        expect(reader.value.first).to eq(200)
        expect(control.value.first).to eq(200)
      ensure
        proceed << true
        reader&.join(5)
        connection.close
      end
    end
  end
end
