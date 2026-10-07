# frozen_string_literal: true

require "json"
require "stringio"

RSpec.describe W::Dashboard do
  # Reports a schema the client cannot use.
  let(:uninstalled) do
    Class.new(W::Executor) {
      def initialize = super(nil)

      def rows(_sql, _params = []) = []
    }.new
  end

  let(:audit) { {"actor" => "browser", "reason" => "Maintenance window", "requestId" => "req-1"} }

  def dashboard(executor = FakeExecutor.new, authorize: ->(_env) { W::Dashboard::Principal.new("operator") }, **options)
    described_class.new(executor, authorize: authorize, **options)
  end

  def env_for(path, method: "GET", body: nil, origin: :same, host: "dashboard.test")
    env = {
      "REQUEST_METHOD" => method, "SCRIPT_NAME" => "", "PATH_INFO" => path, "rack.url_scheme" => "http",
      "HTTP_HOST" => host, "rack.input" => StringIO.new(body.nil? ? "" : JSON.generate(body))
    }
    env["HTTP_ORIGIN"] = (origin == :same) ? "http://#{host}" : origin if origin
    env
  end

  def rpc(app, procedure, input, **options)
    status, headers, chunks = app.call(env_for("/workhorse/rpc/dashboard/#{procedure}", method: "POST",
      body: {"json" => input}, **options))
    expect(headers["content-type"]).to eq("application/json; charset=utf-8")
    [status, JSON.parse(chunks.join)]
  end

  describe "request routing" do
    it "answers 404 for a path outside its mount point" do
      status, = dashboard.call(env_for("/elsewhere"))

      expect(status).to eq(404)
    end

    it "redirects its root to the task list" do
      status, headers, = dashboard.call(env_for("/workhorse"))

      expect([status, headers["location"]]).to eq([302, "/workhorse/tasks"])
    end

    it "serves the application shell for a client-side route" do
      status, headers, chunks = dashboard(environment: "production").call(env_for("/workhorse/tasks/abc"))

      expect(status).to eq(200)
      expect(headers["content-type"]).to eq("text/html; charset=utf-8")
      expect(chunks.join).to include(%("basePath":"/workhorse"), %("auditActor":"operator"), %("demoTools":false))
    end

    it "serves a bundled asset with an immutable cache policy and refuses traversal" do
      shell = dashboard.call(env_for("/workhorse/tasks"))[2].join
      asset = shell[%r{\./assets/[^"]+\.js}].delete_prefix(".")
      status, headers, = dashboard.call(env_for("/workhorse#{asset}"))

      expect([status, headers["content-type"]]).to eq([200, "text/javascript; charset=utf-8"])
      expect(headers["cache-control"]).to eq("public, max-age=31536000, immutable")
      expect(dashboard.call(env_for("/workhorse/assets/../index.html"))[0]).to eq(404)
      expect(dashboard.call(env_for("/workhorse/assets/missing.js"))[0]).to eq(404)
    end

    it "answers under a root mount point" do
      app = dashboard(path: "/")

      expect(app.call(env_for("/"))[1]["location"]).to eq("/tasks")
      expect(app.call(env_for("/tasks"))[0]).to eq(200)
    end
  end

  describe "the runtime configuration" do
    it "cannot close its inline script and escapes browser module sources" do
      app = dashboard(authorize: ->(_env) { true }, audit_actor: "</script><b>",
        browser_modules: [%(/ext.js?a=1&b="2")])
      html = app.call(env_for("/workhorse/tasks"))[2].join

      expect(html).not_to include("</script><b>")
      expect(html).to include(%("auditActor":"\\u003c/script\\u003e\\u003cb\\u003e"))
      expect(html).to include(%(<script type="module" src="/ext.js?a=1&amp;b=&quot;2&quot;"></script>))
    end

    it "advertises demo tools when enqueueTest is registered" do
      app = dashboard(enqueue_test: ->(_input, _actor) { {"taskId" => "x"} })

      expect(app.call(env_for("/workhorse/tasks"))[2].join).to include(%("demoTools":true))
    end
  end

  describe "authorization" do
    it "refuses a Host outside allowed_hosts before authorizing" do
      calls = 0
      app = described_class.new(FakeExecutor.new, authorize: ->(_env) { (calls += 1).positive? },
        allowed_hosts: ["Dashboard.Test:80"])

      expect(app.call(env_for("/workhorse/tasks", host: "attacker.test"))[0]).to eq(421)
      expect(calls).to eq(0)
      expect(app.call(env_for("/workhorse/tasks", host: "dashboard.test"))[0]).to eq(200)
    end

    it "rejects an allowed host that is not a bare host and port" do
      ["https://dashboard.test", "dashboard.test/path", "user@dashboard.test", ""].each do |entry|
        expect { dashboard(allowed_hosts: [entry]) }.to raise_error(ArgumentError, /bare host\[:port\]/)
      end
    end

    it "answers 401 when authorize refuses and passes a Rack response through" do
      refused = described_class.new(FakeExecutor.new, authorize: ->(_env) { false })
      custom = described_class.new(FakeExecutor.new, authorize: ->(_env) { [302, {"location" => "/login"}, []] })

      expect(refused.call(env_for("/workhorse/tasks"))[0]).to eq(401)
      expect(custom.call(env_for("/workhorse/tasks"))[0..1]).to eq([302, {"location" => "/login"}])
    end

    it "answers 503 with the refusal while the schema is not usable" do
      status, _, chunks = dashboard(uninstalled).call(env_for("/workhorse/tasks"))

      expect(status).to eq(503)
      expect(JSON.parse(chunks.join)).to eq({"error" => "workhorse compatibility check refused: schema-not-installed"})
    end

    it "answers 503 with a generic message and logs an unexpected compatibility failure" do
      failing = Class.new(W::Executor) {
        def initialize = super(nil)

        def rows(_sql, _params = []) = raise(PG::ConnectionBad, "could not connect to db.internal:5432")
      }.new
      env = env_for("/workhorse/tasks").merge("rack.errors" => StringIO.new)

      status, _, chunks = dashboard(failing).call(env)

      expect(status).to eq(503)
      expect(JSON.parse(chunks.join)).to eq(
        {"error" => "Unable to verify Workhorse schema compatibility because the database query failed."}
      )
      expect(env["rack.errors"].string).to include("PG::ConnectionBad: could not connect to db.internal:5432")
    end
  end

  describe "procedure calls" do
    it "replaces the browser's audit actor with the authenticated actor" do
      received = nil
      app = dashboard(procedures: {setQueuePaused: ->(input, actor) {
        received = [input, actor]
        {"paused" => true}
      }})

      status, body = rpc(app, "setQueuePaused", {"queue" => "mail", "paused" => true, "audit" => audit})

      expect([status, body]).to eq([200, {"json" => {"paused" => true}}])
      expect(received).to eq([{"queue" => "mail", "paused" => true, "audit" => audit.merge("actor" => "operator")},
        "operator"])
    end

    it "uses the audit actor only when authorization names no principal" do
      actor = ->(**options) {
        received = nil
        app = dashboard(procedures: {setQueuePaused: ->(_input, given) { received = given }}, **options)
        rpc(app, "setQueuePaused", {"queue" => "mail", "paused" => true, "audit" => audit})
        received
      }

      expect(actor.call(audit_actor: "service-account")).to eq("operator")
      expect(actor.call(authorize: ->(_env) { true }, audit_actor: "service-account")).to eq("service-account")
      expect(actor.call(authorize: ->(_env) { true })).to eq("dashboard")
    end

    it "refuses a mutation without a same-origin request" do
      status, body = rpc(dashboard, "setQueuePaused", {"queue" => "mail", "paused" => true, "audit" => audit},
        origin: "http://attacker.test")

      expect([status, body]).to eq([403, {"error" => "A same-origin mutation request is required"}])
      expect(rpc(dashboard, "setQueuePaused", {}, origin: nil)[0]).to eq(403)
    end

    it "refuses a mutation on a read-only dashboard" do
      status, body = rpc(dashboard(read_only: true), "setQueuePaused",
        {"queue" => "mail", "paused" => true, "audit" => audit})

      expect(status).to eq(403)
      expect(body.dig("json", "message")).to eq("This dashboard is read-only")
    end

    it "refuses an optional mutation the host did not register and an unknown procedure" do
      expect(rpc(dashboard, "enqueueTest", {"kind" => "success"})[1].dig("json", "code")).to eq("FORBIDDEN")
      expect(rpc(dashboard, "noSuchProcedure", nil)).to eq([404, {"json" => {"defined" => false,
                                                                             "code" => "NOT_FOUND", "status" => 404, "message" => "Procedure not found"}}])
    end

    it "answers 405 for a method other than POST" do
      status, = dashboard.call(env_for("/workhorse/rpc/dashboard/queues"))

      expect(status).to eq(405)
    end

    it "answers 400 for a malformed envelope or an input outside the schema" do
      env = env_for("/workhorse/rpc/dashboard/queues", method: "POST")
      env["rack.input"] = StringIO.new("{")

      expect(dashboard.call(env)[0]).to eq(400)
      expect(rpc(dashboard, "setQueuePaused", {"queue" => "", "paused" => true, "audit" => audit})[0]).to eq(400)
      expect(rpc(dashboard, "queues", {"unexpected" => true})[0]).to eq(400)
    end

    it "answers 413 before reading a body whose declared length is too large or malformed" do
      too_large = {"json" => {"defined" => false, "code" => "PAYLOAD_TOO_LARGE", "status" => 413,
                              "message" => "Payload Too Large"}}
      [((2 << 20) + 1).to_s, "12abc", "-1"].each do |declared|
        input = StringIO.new(JSON.generate({"json" => nil}))
        env = env_for("/workhorse/rpc/dashboard/queues", method: "POST")
          .merge("CONTENT_LENGTH" => declared, "rack.input" => input)

        status, _, chunks = dashboard.call(env)

        expect(status).to eq(413)
        expect(JSON.parse(chunks.join)).to eq(too_large)
        expect(input.pos).to eq(0)
      end
    end

    it "reads at most one byte past the bound of an undeclared body" do
      input = StringIO.new(" " * ((2 << 20) + 10))
      env = env_for("/workhorse/rpc/dashboard/queues", method: "POST").merge("rack.input" => input)

      expect(dashboard.call(env)[0]).to eq(413)
      expect(input.pos).to eq((2 << 20) + 1)
    end

    it "answers 500 without detail when a procedure fails" do
      app = dashboard(procedures: {queues: ->(_input, _actor) { raise "secret detail" }})

      status, body = rpc(app, "queues", nil)

      expect(status).to eq(500)
      expect(body.dig("json", "message")).to eq("Internal server error")
    end
  end
end
