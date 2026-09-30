# frozen_string_literal: true

require "json"

module Conformance
  # What one fixture did when the runner tried it. +status+ is :passed, :failed (the Ruby adapter
  # ran and disagreed), :unsupported (no Ruby adapter can express the fixture yet), or :skipped (the
  # runner could not reach the database the fixture needs).
  Outcome = Data.define(:status, :reason) do
    def self.passed = new(status: :passed, reason: nil)
    def self.failed(reason) = new(status: :failed, reason: reason)
    def self.unsupported(reason) = new(status: :unsupported, reason: reason)
    def self.skipped(reason) = new(status: :skipped, reason: reason)
  end

  # The reconciliation between fixture outcomes and the expected-unsupported list.
  #
  # Every fixture must pass through a Ruby adapter or appear on the list with the Issue that owns
  # the gap. A listed fixture that passes also fails the run, so the list cannot outlive its fix.
  module Ledger
    PATH = File.expand_path("expected-unsupported.json", __dir__)
    ENTRY_KEYS = %w[fixture issue reason].freeze

    module_function

    # The list's entries, each a Hash with "fixture", "issue", and "reason".
    def load(path = PATH)
      document = JSON.parse(File.read(path))
      raise "#{path} must hold exactly $comment and fixtures" unless document.keys.sort == %w[$comment fixtures]

      document.fetch("fixtures").each do |entry|
        raise "#{path} entry #{entry.inspect} must hold exactly #{ENTRY_KEYS}" unless entry.keys.sort == ENTRY_KEYS
      end
    end

    # Name every disagreement between the outcomes and the list. An empty result is a clean run.
    #
    # +declared+ holds every fixture the protocol files define, so a list entry for a fixture that
    # no longer exists is reported too.
    def reconcile(declared, outcomes, entries)
      problems = []
      listed = {}
      entries.each do |entry|
        fixture = entry.fetch("fixture")
        issue = entry.fetch("issue")
        problems << "#{fixture} names tracking issue #{JSON.generate(issue)}, not SM-<number>" unless issue.match?(/\ASM-\d+\z/)
        problems << "#{fixture} records no reason" if entry.fetch("reason").strip.empty?
        problems << "#{fixture} is listed but no protocol/v1 fixture declares it" unless declared.include?(fixture)
        problems << "#{fixture} is listed twice" if listed.key?(fixture)
        listed[fixture] = entry
      end
      declared.sort.each do |fixture|
        problems << "#{fixture} was never executed" unless outcomes.key?(fixture)
      end
      outcomes.sort.each do |fixture, outcome|
        problems << "#{fixture} was executed but no protocol/v1 fixture declares it" unless declared.include?(fixture)
        entry = listed[fixture]
        case outcome.status
        when :passed
          problems << "#{fixture} now passes; remove it from the expected-unsupported list (#{entry["issue"]})" if entry
        when :failed, :unsupported
          problems << "#{fixture} does not pass and is not listed: #{outcome.reason}" unless entry
        end
      end
      problems
    end
  end
end
