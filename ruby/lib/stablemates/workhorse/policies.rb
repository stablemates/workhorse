# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Decodes the rows the policy list statements return. Internal to the SDK.
    module Policies # :nodoc:
      module_function

      def concurrency_policy(row)
        ConcurrencyPolicy.new(
          namespace: row.fetch("namespace"),
          queue: row.fetch("queue_name"),
          max_active: Values.parse_integer(row.fetch("max_active")),
          max_active_per_key: Values.parse_integer(row.fetch("max_active_per_key")),
          updated_at: Values.parse_time(row.fetch("updated_at"))
        )
      end

      def rate_limit_policy(row)
        RateLimitPolicy.new(
          namespace: row.fetch("namespace"),
          queue: row.fetch("queue_name"),
          rate: rate_limit(row, "rate_", "rate_limit"),
          per_key: rate_limit(row, "per_key_", "per_key_limit"),
          updated_at: Values.parse_time(row.fetch("updated_at"))
        )
      end

      def budget(row)
        Budget.new(
          namespace: row.fetch("namespace"),
          name: row.fetch("budget_name"),
          max_active: Values.parse_integer(row.fetch("max_active")),
          rate: rate_limit(row, "rate_", "rate_limit"),
          updated_at: Values.parse_time(row.fetch("updated_at"))
        )
      end

      # The RateLimit whose columns share +prefix+, or nil when its +limit+ column is null.
      def rate_limit(row, prefix, limit)
        limit = Values.parse_integer(row.fetch(limit))
        return nil if limit.nil?

        RateLimit.new(
          limit: limit,
          interval: Values.seconds(Values.parse_integer(row.fetch("#{prefix}interval_ms"))),
          burst: Values.parse_integer(row.fetch("#{prefix}burst"))
        )
      end
    end
  end
end
