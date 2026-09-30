# frozen_string_literal: true

require "json"
require "logger"
require "rack"
require "rack/mock"
require "action_controller/railtie"

# A mounting stack splits the request path into SCRIPT_NAME and PATH_INFO. The dashboard answers
# under its full path however the stack splits it.
RSpec.describe "Mounting the dashboard" do
  dashboard = W::Dashboard.new(FakeExecutor.new, authorize: ->(_env) { W::Dashboard::Principal.new("operator") },
    procedures: {queues: ->(_input, _actor) { {"queues" => []} }})

  # A Rails application exists once per process, so this file defines the only one.
  rails = Class.new(Rails::Application) {
    config.eager_load = false
    config.logger = Logger.new(IO::NULL)
    config.secret_key_base = "dashboard-mount-spec"
    config.hosts.clear
  }
  rails.initialize!
  rails.routes.draw do
    mount dashboard, at: "/workhorse"
    get "/up", to: ->(_env) { [200, {"content-type" => "text/plain"}, ["host"]] }
  end

  builder = Rack::Builder.new do
    map("/workhorse") { run dashboard }
    run ->(_env) { [200, {"content-type" => "text/plain"}, ["host"]] }
  end

  {"a Rails route" => rails, "Rack::Builder#map" => builder.to_app}.each do |stack, app|
    describe "in #{stack}" do
      let(:request) { Rack::MockRequest.new(app) }

      it "redirects the mount point to the task list" do
        response = request.get("/workhorse")

        expect([response.status, response.location]).to eq([302, "/workhorse/tasks"])
      end

      it "serves the application shell for a client-side route" do
        response = request.get("/workhorse/tasks/abc")

        expect(response.status).to eq(200)
        expect(response.body).to include(%("basePath":"/workhorse"), %("rpcUrl":"/workhorse/rpc"))
      end

      it "answers a procedure call" do
        response = request.post("/workhorse/rpc/dashboard/queues", :input => JSON.generate({"json" => nil}),
          "CONTENT_TYPE" => "application/json")

        expect([response.status, JSON.parse(response.body)]).to eq([200, {"json" => {"queues" => []}}])
      end

      it "leaves other paths to the host application" do
        expect(request.get(stack.include?("Rails") ? "/up" : "/elsewhere").body).to eq("host")
      end
    end
  end
end
