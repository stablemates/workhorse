# frozen_string_literal: true

module Stablemates
  module Workhorse
    # The startup check every SDK runs before its first mutation. Internal to the SDK.
    module Compatibility # :nodoc:
      NOT_INSTALLED = %w[42P01 3F000].freeze
      private_constant :NOT_INSTALLED

      module_function

      # The refusal code for observed state, or nil when the client may proceed.
      def check(installed_schema_version, client_protocol_version, served_protocol_versions)
        return :schema_not_installed if installed_schema_version.nil?
        return :schema_too_old if installed_schema_version < SqlCatalogue::MINIMUM_SCHEMA_VERSION
        return :client_protocol_too_old if client_protocol_version < SqlCatalogue::MINIMUM_PROTOCOL_VERSION
        return :client_protocol_too_new if client_protocol_version > SqlCatalogue::MAXIMUM_PROTOCOL_VERSION
        return nil if served_protocol_versions.empty? || served_protocol_versions.include?(client_protocol_version)

        (client_protocol_version < served_protocol_versions.min) ? :schema_too_new : :schema_too_old
      end

      # [installed schema version or nil, served protocol versions]. A missing schema reads as not
      # installed, and an ambiguous schema version table reads as no version.
      def read_state(executor)
        rows = executor.rows(SqlCatalogue::COMPATIBILITY_STATE)
        schemas = rows.select { |row| row["kind"] == "schema" }.map { |row| Integer(row["version"], 10) }
        served = rows.select { |row| row["kind"] == "protocol" }.map { |row| Integer(row["version"], 10) }
        [schemas.one? ? schemas.first : nil, served]
      rescue DatabaseError => e
        raise unless NOT_INSTALLED.include?(e.sqlstate)

        [nil, []]
      end

      # The refusal code for the database +executor+ reaches, or nil.
      def evaluate(executor)
        installed, served = read_state(executor)
        check(installed, SqlCatalogue::CLIENT_PROTOCOL_VERSION, served)
      end
    end
  end
end
