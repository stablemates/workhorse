# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Runs protocol statements on the connection an executor yields. Internal to the SDK.
    #
    # An executor is a PG::Connection, a ConnectionPool of them, or any object whose +with+ yields
    # one. The SDK changes no session state: it passes a type map with each call and sets one on
    # each result, so the caller's connection keeps its own type maps and +search_path+.
    class Executor
      # Yields one PG::Connection the caller owns.
      class Connection
        def initialize(connection)
          @connection = connection
        end

        def with = yield(@connection)
      end
      private_constant :Connection

      STRINGS = PG::TypeMapAllStrings.new
      private_constant :STRINGS

      def self.for(executor)
        case executor
        when Executor then executor
        when PG::Connection then new(Connection.new(executor))
        else
          unless executor.respond_to?(:with)
            raise ArgumentError, "executor must be a PG::Connection, a ConnectionPool, or respond to with"
          end

          new(executor)
        end
      end

      def initialize(source)
        @source = source
      end

      # The rows +sql+ returns, each a Hash of column name to text or nil. Every parameter is a
      # String or nil the caller already encoded.
      def rows(sql, params = [])
        @source.with do |connection|
          result = connection.exec_params(sql, params, 0, STRINGS)
          begin
            result.type_map = STRINGS
            result.to_a
          ensure
            result.clear
          end
        end
      rescue PG::Error => e
        raise Executor.translate(e)
      end

      # Maps a PG::Error to the SDK's error for its SQLSTATE.
      def self.translate(error)
        result = error.respond_to?(:result) ? error.result : nil
        sqlstate = result&.error_field(PG::PG_DIAG_SQLSTATE)
        detail = result&.error_field(PG::PG_DIAG_MESSAGE_DETAIL)
        case sqlstate
        when "P1001" then EnqueueIdempotencyConflictError.new(details(detail))
        when "P1003" then DependencyCycleError.new(details(detail))
        when "P1005" then DependencyLimitExceededError.new(details(detail))
        when "P1007"
          fields = details(detail)
          FastTierUnsupportedError.new(fields.fetch("queue", "unknown"), fields.fetch("feature", "unknown"),
            fields["ordinal"])
        else DatabaseError.new(error.message, sqlstate)
        end
      end

      def self.details(detail)
        parsed = JSON.parse(detail || "{}")
        parsed.is_a?(Hash) ? parsed : {}
      rescue JSON::ParserError
        {}
      end
      private_class_method :details
    end
  end
end
