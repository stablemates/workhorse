# frozen_string_literal: true

require "cgi/escape"
require "json"
require "rubygems/package"
require "stringio"
require "uri"
require "zlib"

module Stablemates
  module Workhorse
    # A Rack application serving one embedded dashboard and its dashboard/v1 RPC contract.
    #
    # Mount it in any Rack stack, such as a Rails route or +Rack::Builder#map+. +path+ is the full
    # request path it answers under, so it must equal the mount point.
    #
    # +authorize+ receives the Rack env and returns a Principal, +true+ to accept with the default
    # actor, +false+ to answer 401, or a Rack response to return as-is. +allowed_hosts+ lists the
    # +host[:port]+ values the dashboard answers to. When set, a request whose +Host+ is not listed
    # receives 421 Misdirected Request before +authorize+ runs. Letter case and a default port do
    # not matter. Leave it empty when the embedding application already validates +Host+.
    class Dashboard
      # Identity established by the embedding application's authorization boundary.
      Principal = Data.define(:actor)

      # A dashboard/v1 procedure refused its request with an RPC status and code.
      class RpcError < StandardError
        attr_reader :status, :code, :data

        def initialize(status, code, message, data = nil)
          @status = status
          @code = code
          @data = data
          super(message)
        end

        def self.not_found(message) = new(404, "NOT_FOUND", message)
      end
    end
  end
end

require_relative "dashboard/v1_generated"
require_relative "dashboard/validator"
require_relative "dashboard/backend"

module Stablemates
  module Workhorse
    class Dashboard
      MUTATIONS = %w[
        enqueueTest setSchedulePaused setQueuePaused purgeQueue setWorkerPaused
        overrideMaintenancePolicy revertMaintenancePolicy overrideRetentionPolicy revertRetentionPolicy
        runTaskNow cancelTask signalTask completeHumanWait redriveTask redriveDeadLetters
      ].freeze
      OPTIONAL_MUTATIONS = %w[enqueueTest setSchedulePaused].freeze
      CONTENT_TYPES = {
        ".css" => "text/css; charset=utf-8",
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".png" => "image/png",
        ".svg" => "image/svg+xml",
        ".woff2" => "font/woff2"
      }.freeze
      JSON_TYPE = "application/json; charset=utf-8"
      # The largest RPC request body the dashboard reads, the same bound the Go and Rust hosts apply.
      MAX_REQUEST_BYTES = 2 << 20
      UNVERIFIED_COMPATIBILITY =
        "Unable to verify Workhorse schema compatibility because the database query failed."
      DEFAULT_PORTS = {"http" => ":80", "https" => ":443"}.freeze
      # Characters escaped in the runtime configuration so it cannot close its inline script.
      SCRIPT_ESCAPES = {"<" => "\\u003c", ">" => "\\u003e", "&" => "\\u0026",
                        " " => "\\u2028", " " => "\\u2029"}.freeze
      TOO_SMALL_PAGE = {
        "issues" => [{"origin" => "number", "code" => "too_small", "minimum" => 1, "inclusive" => true,
                      "path" => ["page"], "message" => "Too small: expected number to be >=1"}]
      }.freeze
      MISSING_FEATURE = {
        "issues" => [{"code" => "custom", "path" => ["feature"],
                      "message" => "The feature demo kind requires a feature family"}]
      }.freeze
      private_constant :MUTATIONS, :OPTIONAL_MUTATIONS, :CONTENT_TYPES, :JSON_TYPE, :MAX_REQUEST_BYTES,
        :UNVERIFIED_COMPATIBILITY, :DEFAULT_PORTS, :SCRIPT_ESCAPES, :TOO_SMALL_PAGE, :MISSING_FEATURE

      attr_reader :base_path

      # +executor+ is a PG::Connection, a ConnectionPool of them, or any object whose +with+
      # yields one. Each call runs on its own; the dashboard opens no transaction.
      def initialize(executor, authorize:, path: "/workhorse", environment: "development", audit_actor: nil,
        read_only: false, browser_modules: [], configured_workers: [], maintenance_loops: nil,
        enqueue_test: nil, set_schedule_paused: nil, allowed_hosts: [], procedures: {})
        raise ArgumentError, "authorize must respond to call" unless authorize.respond_to?(:call)

        @executor = Executor.for(executor)
        @base_path = Dashboard.normalize_path(path)
        @allowed_hosts = Dashboard.allowed_hosts(allowed_hosts)
        @authorize = authorize
        @audit_actor = audit_actor
        @read_only = read_only
        @browser_modules = browser_modules.dup.freeze
        backend = Backend.new(@executor, environment: environment, configured_workers: configured_workers,
          maintenance_loops: maintenance_loops || {"tickIntervalMs" => 1_000}, read_only: read_only)
        extensions = procedures.to_h { |name, handler| [name.to_s, handler] }
        extensions["enqueueTest"] = enqueue_test if enqueue_test
        extensions["setSchedulePaused"] = set_schedule_paused if set_schedule_paused
        @procedures = backend.procedures.merge(extensions).freeze
        @lock = Mutex.new
        @compatible = false
        @assets = nil
      end

      def owns?(path) = path == @base_path || path.start_with?("#{@base_path}/")

      # The Rack entry point.
      def call(env)
        path = "#{env["SCRIPT_NAME"]}#{env["PATH_INFO"]}"
        return json(404, {"error" => "Not Found"}) unless owns?(path)

        # A name the dashboard does not answer to may resolve to this listener, so its requests are
        # refused before any credential or session is consulted.
        if !@allowed_hosts.empty? &&
            !@allowed_hosts.include?(Dashboard.canonical_host(env["HTTP_HOST"].to_s, scheme(env)))
          return json(421, {"error" => "Misdirected Request"})
        end

        authorization = @authorize.call(env)
        return authorization if authorization.is_a?(Array)
        return json(401, {"error" => "Unauthorized"}) if authorization == false

        # A verified principal names the actor; the audit actor stands in only for a bare true.
        actor = (authorization == true) ? (@audit_actor || "dashboard") : authorization.actor
        begin
          assert_compatible
        rescue CompatibilityError => e
          return json(503, {"error" => e.message})
        rescue => e
          # A driver error can name the database host, user, or path, so it stays in the log.
          env["rack.errors"]&.puts("workhorse dashboard: schema compatibility check failed: #{e.class}: #{e.message}")
          return json(503, {"error" => UNVERIFIED_COMPATIBILITY})
        end

        # A mounting stack may hand over the mount point itself as SCRIPT_NAME plus a PATH_INFO of "/".
        return [302, {"location" => "#{@base_path}/tasks"}, []] if [@base_path, "#{@base_path}/"].include?(path)
        return asset(path[(@base_path.length + 1)..]) if path.start_with?("#{@base_path}/assets/")

        rpc_prefix = "#{@base_path}/rpc/dashboard/"
        return rpc(env, path.delete_prefix(rpc_prefix), actor) if path.start_with?(rpc_prefix)

        application(actor)
      end

      # "" for the root, otherwise "/" followed by the non-empty segments of +path+.
      def self.normalize_path(path) # :nodoc:
        segments = path.to_s.split("/").reject(&:empty?)
        segments.empty? ? "" : "/#{segments.join("/")}"
      end

      # Lowercase a host[:port] and drop the default port, so one address has one spelling.
      def self.canonical_host(host, scheme) # :nodoc:
        host = host.downcase
        default = DEFAULT_PORTS[scheme]
        host = host.delete_suffix(default) if default
        "#{scheme}://#{host}"
      end

      def self.allowed_hosts(entries) # :nodoc:
        entries.each_with_object(Set.new) do |entry, allowed|
          parsed = begin
            URI.parse("http://#{entry}")
          rescue URI::InvalidURIError
            nil
          end
          bare = parsed && !entry.include?("@") && parsed.userinfo.nil? && parsed.path.empty? &&
            parsed.query.nil? && parsed.fragment.nil? && !parsed.host.to_s.empty? &&
            [parsed.host, "#{parsed.host}:#{parsed.port}"].include?(entry)
          raise ArgumentError, "dashboard allowed host must be a bare host[:port]: #{entry.inspect}" unless bare

          allowed << canonical_host(entry, "http")
          allowed << canonical_host(entry, "https")
        end.freeze
      end

      private

      # A refusal is not cached, so the dashboard recovers once an operator migrates the schema.
      def assert_compatible
        return if @compatible

        @lock.synchronize do
          next if @compatible

          code = Compatibility.evaluate(@executor)
          raise CompatibilityError, code if code

          @compatible = true
        end
      end

      def rpc(env, procedure, actor)
        return rpc_error(405, "METHOD_NOT_SUPPORTED", "Method Not Supported") unless env["REQUEST_METHOD"] == "POST"

        if MUTATIONS.include?(procedure)
          return json(403, {"error" => "A same-origin mutation request is required"}) unless same_origin?(env)
          return rpc_error(403, "FORBIDDEN", "This dashboard is read-only") if @read_only
        end
        handler = @procedures[procedure]
        if handler.nil?
          return rpc_error(403, "FORBIDDEN", "This procedure is not available") if OPTIONAL_MUTATIONS.include?(procedure)

          return rpc_error(404, "NOT_FOUND", "Procedure not found")
        end

        body = read_body(env)
        return rpc_error(413, "PAYLOAD_TOO_LARGE", "Payload Too Large") if body.nil?

        input = nil
        begin
          envelope = JSON.parse(body.empty? ? "{}" : body)
          raise InputValidationError, "request envelope must be an object" unless envelope.is_a?(Hash)

          input = envelope["json"]
          Validator.validate(procedure, input)
          if procedure == "enqueueTest" && input.is_a?(Hash) && input["kind"] == "feature" && !input.key?("feature")
            raise RpcError.new(400, "BAD_REQUEST", "Input validation failed", MISSING_FEATURE)
          end

          input = input.merge("audit" => input["audit"].merge("actor" => actor)) if input.is_a?(Hash) && input["audit"].is_a?(Hash)
          result = handler.call(input, actor)
        rescue InputValidationError => e
          if procedure == "tasks" && input.is_a?(Hash) && input["page"].is_a?(Integer) && input["page"] < 1
            return rpc_error(400, "BAD_REQUEST", "Input validation failed", TOO_SMALL_PAGE)
          end

          return rpc_error(400, "BAD_REQUEST", e.message)
        rescue JSON::ParserError, ArgumentError => e
          return rpc_error(400, "BAD_REQUEST", e.message)
        rescue RpcError => e
          return rpc_error(e.status, e.code, e.message, e.data)
        rescue
          return rpc_error(500, "INTERNAL_SERVER_ERROR", "Internal server error")
        end
        json(200, result.nil? ? {} : {"json" => result})
      end

      # At most MAX_REQUEST_BYTES of the request body, or nil for a body that is larger.
      def read_body(env)
        declared = env["CONTENT_LENGTH"].to_s
        unless declared.empty?
          return nil unless declared.match?(/\A\d+\z/) && declared.to_i <= MAX_REQUEST_BYTES
        end

        body = env["rack.input"]&.read(MAX_REQUEST_BYTES + 1).to_s
        (body.bytesize > MAX_REQUEST_BYTES) ? nil : body
      end

      def same_origin?(env)
        origin = env["HTTP_ORIGIN"]
        return false unless origin.is_a?(String)

        parsed = URI.parse(origin)
        return false if parsed.scheme.nil? || parsed.host.nil? || parsed.host.empty?

        netloc = origin.delete_prefix("#{parsed.scheme}://").split(%r{[/?#]}, 2).first
        "#{parsed.scheme}://#{netloc}" == "#{scheme(env)}://#{env["HTTP_HOST"]}"
      rescue URI::InvalidURIError
        false
      end

      def scheme(env) = (env["rack.url_scheme"] || "http").to_s

      def application(actor)
        config = {
          "basePath" => @base_path,
          "rpcUrl" => "#{@base_path}/rpc",
          "auditActor" => actor,
          "workhorseVersion" => VERSION,
          "authentication" => nil,
          "demoTools" => @procedures.key?("enqueueTest"),
          "workspaces" => [],
          "workspace" => nil
        }
        modules = @browser_modules.map { |source|
          %(<script type="module" src="#{CGI.escapeHTML(source)}"></script>)
        }.join
        html = bundle_files.fetch("app/index.html").dup.force_encoding(Encoding::UTF_8)
          .sub("/*__WORKHORSE_RUNTIME_CONFIG__*/") {
            "window.workhorseDashboard = #{JSON.generate(config).gsub(/[<>&  ]/, SCRIPT_ESCAPES)}"
          }
          .sub("<!--__WORKHORSE_BROWSER_MODULES__-->") { modules }
        [200, {"content-type" => "text/html; charset=utf-8"}, [html]]
      end

      def asset(name)
        return json(404, {"error" => "Not Found"}) if name.split("/").include?("..") || name.start_with?("/")

        data = bundle_files["app/#{name}"]
        return json(404, {"error" => "Not Found"}) if data.nil?

        type = CONTENT_TYPES.fetch(File.extname(name), "application/octet-stream")
        [200, {"content-type" => type, "cache-control" => "public, max-age=31536000, immutable"}, [data]]
      end

      # The browser bundle's files by archive path, unpacked once from the gem.
      def bundle_files
        @assets || @lock.synchronize do
          @assets ||= begin
            directory = File.join(__dir__, "dashboard")
            manifest = JSON.parse(File.read(File.join(directory, "bundle.json")))
            archive = File.binread(File.join(directory, manifest.fetch("archive")))
            files = {}
            Zlib::GzipReader.wrap(StringIO.new(archive)) do |gzip|
              Gem::Package::TarReader.new(gzip) do |tar|
                tar.each { |entry| files[entry.full_name.delete_prefix("./")] = entry.read.to_s if entry.file? }
              end
            end
            files.freeze
          end
        end
      end

      def json(status, value)
        [status, {"content-type" => JSON_TYPE}, [JSON.generate(value)]]
      end

      def rpc_error(status, code, message, data = nil)
        error = {"defined" => false, "code" => code, "status" => status, "message" => message}
        error["data"] = data unless data.nil?
        json(status, {"json" => error})
      end
    end
  end
end
