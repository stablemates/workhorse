# frozen_string_literal: true

require "fileutils"
require "tmpdir"
require_relative "runner"

# The Ruby conformance lane: every protocol/v1 fixture runs through the Ruby client, and the run
# must agree with `expected-unsupported.json`.
RSpec.describe "protocol/v1 conformance" do
  it "executes every protocol/v1 fixture and agrees with the expected-unsupported list" do
    reason = ScratchDatabase.skip_reason
    skip(reason) if reason

    runner = Conformance::Runner.new(Conformance::Catalogue.load, Conformance::Ledger.load)
    problems = runner.run
    warn runner.report
    expect(problems).to be_empty,
      "Ruby protocol conformance disagrees with its list:\n  #{problems.join("\n  ")}"
  end

  describe "the expected-unsupported list" do
    def outcome(status, reason = nil) = Conformance::Outcome.new(status: status, reason: reason)

    def listed(*pairs) = pairs.map { |fixture, issue| {"fixture" => fixture, "issue" => issue, "reason" => "tracked"} }

    def reconcile(declared, outcomes, entries) = Conformance::Ledger.reconcile(declared.to_set, outcomes, entries)

    it "fails the run for an unlisted failing fixture" do
      problems = reconcile(["requests/a"], {"requests/a" => outcome(:failed, "wrong column")}, listed)
      expect(problems).to eq(["requests/a does not pass and is not listed: wrong column"])
    end

    it "fails the run for an unlisted unsupported fixture" do
      problems = reconcile(["runtime/a"], {"runtime/a" => outcome(:unsupported, "no worker")}, listed)
      expect(problems).to eq(["runtime/a does not pass and is not listed: no worker"])
    end

    it "fails the run for a listed fixture that passes" do
      problems = reconcile(["requests/a"], {"requests/a" => outcome(:passed)}, listed(["requests/a", "SM-900"]))
      expect(problems).to eq(["requests/a now passes; remove it from the expected-unsupported list (SM-900)"])
    end

    it "accepts a listed failing fixture and a skipped fixture" do
      outcomes = {"requests/a" => outcome(:failed, "wrong column"), "scenarios/b" => outcome(:skipped, "no database")}
      expect(reconcile(["requests/a", "scenarios/b"], outcomes, listed(["requests/a", "SM-900"]))).to be_empty
    end

    it "requires each entry to name a declared fixture once with an issue" do
      entries = listed(["requests/a", "SM-900"], ["requests/a", "SM-900"], ["requests/gone", "WH-12"])
      problems = reconcile(["requests/a"], {"requests/a" => outcome(:failed, "x")}, entries)
      expect(problems).to eq([
        "requests/a is listed twice",
        "requests/gone names tracking issue \"WH-12\", not SM-<number>",
        "requests/gone is listed but no protocol/v1 fixture declares it"
      ])
    end

    it "fails the run for a declared fixture that never ran" do
      problems = reconcile(["requests/a", "requests/b"], {"requests/a" => outcome(:passed)}, listed)
      expect(problems).to eq(["requests/b was never executed"])
    end

    it "lists no fixture: every protocol/v1 fixture passes on the Ruby lane" do
      expect(Conformance::Ledger.load).to be_empty
    end
  end

  it "fails the run for an unclassified protocol file" do
    Dir.mktmpdir("workhorse-ruby-conformance") do |directory|
      FileUtils.cp(Dir.glob(File.join(Conformance::PROTOCOL, "*")), directory)
      File.write(File.join(directory, "leases.json"), "[]")
      expect { Conformance::Catalogue.load(directory) }.to raise_error(
        Conformance::Failure,
        "protocol/v1 holds files the Ruby runner does not classify: leases.json; execute them or name them as metadata"
      )
    end
  end

  it "fails the run for missing manifest coverage" do
    manifest = {"coverage" => ["enqueue", "claim"], "runtimeCoverage" => []}
    expect(Conformance::Runner.manifest_coverage(manifest, Set["enqueue"]))
      .to eq("SQL protocol fixtures lack coverage: claim")
  end

  it "rejects an interpreter step that accepts a value the fixture rejects" do
    fixture = {
      "id" => "self-test",
      "steps" => [{"id" => "reject", "expect" => {"$type" => "any"}, "actual" => true, "rejects" => true}],
      "errors" => []
    }
    expect { Conformance::Runner.run_interpreter(fixture) }
      .to raise_error(Conformance::Failure, "self-test/reject accepted a value the fixture rejects")
  end

  it "compares numbers by value" do
    expect(Conformance::Matcher.same?(1, 1.0)).to be(true)
  end
end
