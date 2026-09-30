# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Runs Workhorse statements on the connection an Active Record model class holds.
    #
    # Inside +transaction+, +with_connection+ returns the connection that holds the transaction, and
    # +raw_connection+ materializes a lazy transaction first. So an enqueue commits and rolls back
    # with the caller's transaction. The gem does not depend on Active Record; the caller loads it.
    class ActiveRecordExecutor
      def initialize(model)
        @model = model
      end

      def with
        @model.with_connection { |connection| yield connection.raw_connection }
      end
    end
  end
end
