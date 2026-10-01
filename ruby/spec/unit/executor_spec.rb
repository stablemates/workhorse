# frozen_string_literal: true

require "spec_helper"
require "connection_pool"

# A pooled connection that PostgreSQL dropped stays unusable, so the executor discards it while it
# is still checked out, and the pool builds a fresh one for the next statement.
RSpec.describe W::Executor do
  # Stands in for a PG::Connection. +failure+ is what its next statement raises, and +status+
  # reports whether the connection survived that failure.
  fake = Struct.new(:id, :failure, :status, :closed, :statements) do
    def exec_params(sql, params, _format, _type_map)
      statements << [sql, params]
      error = failure
      self.failure = nil
      raise error if error

      FakeResult.new
    end

    def close = self.closed = true
  end

  result_class = Class.new do
    attr_writer :type_map

    def to_a = [{"ok" => "t"}]

    def clear = nil
  end

  before { stub_const("FakeResult", result_class) }

  let(:built) { [] }
  let(:pool) do
    ConnectionPool.new(size: 1, timeout: 1) do
      fake.new(built.size + 1, nil, PG::CONNECTION_OK, false, []).tap { |connection| built << connection }
    end
  end
  let(:executor) { described_class.for(pool) }

  def checked_out = pool.with { |connection| connection }

  [
    ["PG::ConnectionBad", PG::ConnectionBad.new("server closed the connection unexpectedly"), PG::CONNECTION_OK],
    ["PG::UnableToSend", PG::UnableToSend.new("no connection to the server"), PG::CONNECTION_OK],
    ["a server error that left the connection bad", PG::AdminShutdown.new("terminating connection"),
      PG::CONNECTION_BAD]
  ].each do |label, error, status|
    it "discards the connection after #{label} and builds a fresh one for the next call" do
      broken = checked_out
      broken.failure = error
      broken.status = status

      expect { executor.rows("SELECT 1") }.to raise_error(W::DatabaseError)
      expect(broken.closed).to be(true)
      expect(executor.rows("SELECT 1")).to eq([{"ok" => "t"}])
      expect(built.map(&:id)).to eq([1, 2])
      expect(built.last.statements.size).to eq(1)
    end
  end

  it "keeps the connection after an ordinary SQL error" do
    connection = checked_out
    connection.failure = PG::UniqueViolation.new("duplicate key value violates unique constraint")

    expect { executor.rows("INSERT") }.to raise_error(W::DatabaseError)
    expect(executor.rows("SELECT 1")).to eq([{"ok" => "t"}])
    expect(built.map(&:id)).to eq([1])
    expect(connection.closed).to be(false)
  end

  it "keeps the connection after an idempotency conflict" do
    connection = checked_out
    connection.failure = PG::RaiseException.new("idempotency conflict")

    expect { executor.rows("SELECT enqueue") }.to raise_error(W::DatabaseError)
    expect(checked_out).to equal(connection)
    expect(connection.closed).to be(false)
  end

  it "closes a broken connection only when the caller's own checkout ends" do
    pool.with do |connection|
      connection.failure = PG::ConnectionBad.new("server closed the connection unexpectedly")

      expect { executor.rows("SELECT 1") }.to raise_error(W::DatabaseError)
      expect(connection.closed).to be(false)
    end
    expect(built.first.closed).to be(true)
    expect(checked_out).not_to equal(built.first)
  end

  it "never resends a fenced write whose connection broke" do
    connection = checked_out
    connection.failure = PG::ConnectionBad.new("server closed the connection unexpectedly")

    expect { executor.fenced_rows("SELECT complete") }.to raise_error(W::DatabaseError)
    expect(built.flat_map(&:statements)).to eq([["SELECT complete", []]])
  end

  it "leaves a source without discard_current_connection to its owner" do
    connection = fake.new(1, PG::ConnectionBad.new("server closed the connection unexpectedly"),
      PG::CONNECTION_BAD, false, [])
    source = Struct.new(:connection) { def with = yield(connection) }.new(connection)

    expect { described_class.for(source).rows("SELECT 1") }.to raise_error(W::DatabaseError)
    expect(connection.closed).to be(false)
  end
end
