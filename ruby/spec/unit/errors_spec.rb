# frozen_string_literal: true

RSpec.describe "Workhorse errors" do
  diagnostics = Struct.new(:sqlstate, :detail) do
    def error_field(field)
      {PG::PG_DIAG_SQLSTATE => sqlstate, PG::PG_DIAG_MESSAGE_DETAIL => detail}[field]
    end
  end

  define_method(:pg_error) do |sqlstate, detail = nil|
    error = PG::Error.new("boom")
    result = diagnostics.new(sqlstate, detail)
    error.define_singleton_method(:result) { result }
    error
  end

  it "maps diagnosed SQLSTATEs to their errors" do
    conflict = W::Executor.translate(pg_error("P1001", '{"existingTaskId":"x","conflictingFields":["payload"]}'))
    expect(conflict).to be_an_instance_of(W::EnqueueIdempotencyConflictError)
    expect(conflict.details).to eq({"existingTaskId" => "x", "conflictingFields" => ["payload"]})
    expect(W::Executor.translate(pg_error("P1002", "{}"))).to be_an_instance_of(W::RedriveIdempotencyConflictError)
    expect(W::Executor.translate(pg_error("P1003", "{}"))).to be_an_instance_of(W::DependencyCycleError)
    expect(W::Executor.translate(pg_error("P1005", "not json"))).to be_an_instance_of(W::DependencyLimitExceededError)
    expect(W::Executor.translate(pg_error("P1006", "{}"))).to be_an_instance_of(W::PurgeIdempotencyConflictError)

    fast = W::Executor.translate(pg_error("P1007", '{"queue":"q","feature":"dependencies","ordinal":2}'))
    expect([fast.queue, fast.feature, fast.ordinal]).to eq(["q", "dependencies", 2])
  end

  it "turns other errors into database errors with their SQLSTATE" do
    error = W::Executor.translate(pg_error("23505"))
    expect(error).to be_an_instance_of(W::DatabaseError)
    expect(error.sqlstate).to eq("23505")
    expect(W::Executor.translate(PG::Error.new("no result")).sqlstate).to be_nil
  end

  it "roots every error at Workhorse::Error" do
    errors = W.constants.map { |name| W.const_get(name) }.select { |value| value.is_a?(Class) && value < Exception }
    expect(errors.length).to be >= 21
    expect(errors).to all(be <= W::Error)
  end

  it "reports compatibility codes" do
    max = W::SqlCatalogue::MAXIMUM_SCHEMA_VERSION
    protocol = W::SqlCatalogue::CLIENT_PROTOCOL_VERSION
    expect(W::Compatibility.check(nil, protocol, [])).to eq(:schema_not_installed)
    expect(W::Compatibility.check(W::SqlCatalogue::MINIMUM_SCHEMA_VERSION - 1, protocol, [])).to eq(:schema_too_old)
    expect(W::Compatibility.check(max, protocol - 1, [])).to eq(:client_protocol_too_old)
    expect(W::Compatibility.check(max, protocol + 1, [])).to eq(:client_protocol_too_new)
    expect(W::Compatibility.check(max, protocol, [protocol])).to be_nil
    expect(W::Compatibility.check(max, protocol, [protocol + 1])).to eq(:schema_too_new)
    expect(W::Compatibility.check(max, protocol, [protocol - 1])).to eq(:schema_too_old)
    expect(W::CompatibilityError.new(:schema_too_new).message)
      .to eq("workhorse compatibility check refused: schema-too-new")
  end
end
