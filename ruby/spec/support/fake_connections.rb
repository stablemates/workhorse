# frozen_string_literal: true

# A connection that answers each statement after +delay+ seconds. +delay+ receives the kind of
# the statement and how many statements of that kind the connection sent before. A heartbeat
# statement accepts every lease, and the compatibility query reports a compatible schema. Each
# statement the heartbeat sends is recorded in +sent+ as [kind, workers]: the worker ID of a
# heartbeat_many_v2 statement, or the worker IDs of the batches of a heartbeat_pool_v1 statement. +lose+ makes the
# connection unusable, as a terminated backend does.
class FakeHeartbeatConnection
  Result = Struct.new(:rows) do
    def type_map=(_map)
      nil
    end

    def to_a = rows

    def clear = nil
  end

  attr_reader :sent, :probes

  def initialize(&delay)
    @delay = delay || ->(_kind, _count) { 0 }
    @sent = Concurrent::Array.new
    @closed = false
    @lost = false
    @probes = Concurrent::AtomicFixnum.new
    # A socket that never has input: the heartbeat probes it between rounds.
    @reader, @writer = IO.pipe
    FakeHeartbeatConnection.opened << self
  end

  # Every connection an example created. spec_helper closes them after each example.
  def self.opened = (@opened ||= Concurrent::Array.new)

  def self.close_all
    opened.each(&:close)
    opened.clear
  end

  def closed? = @closed

  def lose
    @lost = true
  end

  # Makes each later heartbeat statement take 1 s, so a round passes its bound on an open session.
  def slow_heartbeats!
    @delay = ->(kind, _count) { (kind == :heartbeat) ? 1 : 0 }
  end

  def status = (@closed || @lost) ? PG::CONNECTION_BAD : PG::CONNECTION_OK

  # The heartbeat reads the socket on each probe between rounds. +probes+ counts the reads.
  def socket_io
    @probes.increment
    @reader
  end

  def consume_input = nil

  def exec_params(sql, _params = [], _format = 0, _type_map = nil)
    raise PG::ConnectionBad, "connection lost" unless status == PG::CONNECTION_OK

    Result.new((sql == W::SqlCatalogue::COMPATIBILITY_STATE) ? FakeExecutor::COMPATIBLE.map(&:dup) : [])
  end

  def send_query_params(sql, params, _format, _type_map)
    raise PG::ConnectionBad, "connection lost" unless status == PG::CONNECTION_OK

    kind = if sql == W::SqlCatalogue::HEARTBEAT_MANY_V2 || sql == W::SqlCatalogue::HEARTBEAT_POOL_V1 then :heartbeat
    elsif sql.start_with?("SELECT set_config") then :settings
    else sql.downcase.to_sym
    end
    @pending = [kind, params, sql]
    @sent << [kind, (kind == :heartbeat) ? heartbeat_workers(sql, params) : nil]
  end

  # The worker of a heartbeat_many_v2 statement, or the worker of each batch of a
  # heartbeat_pool_v1 statement.
  def heartbeat_workers(sql, params)
    return params[0] if sql == W::SqlCatalogue::HEARTBEAT_MANY_V2

    JSON.parse(params[0]).map { |batch| batch["workerId"] }
  end

  def block(timeout)
    kind, = @pending
    took = @delay.call(kind, @sent.count { |entry| entry[0] == kind } - 1)
    sleep [took, timeout].min
    took <= timeout
  end

  def get_last_result
    kind, params, sql = @pending
    return Result.new([]) unless kind == :heartbeat
    return Result.new(JSON.parse(params[1]).map { |lease| {"task_id" => lease["taskId"], "status" => "accepted"} }) if
      sql == W::SqlCatalogue::HEARTBEAT_MANY_V2

    rows = JSON.parse(params[0]).each_with_index.flat_map do |batch, index|
      batch["leases"].map { |lease| {"batch" => (index + 1).to_s, "task_id" => lease["taskId"], "status" => "accepted"} }
    end
    Result.new(rows)
  end

  # Closes the socket pipe too, so no test leaves file descriptors for the garbage collector.
  def close
    @closed = true
    [@reader, @writer].each { |io| io.close unless io.closed? }
  end

  # Yields a new connection and closes it afterwards.
  def self.lend
    connection = new
    yield connection
  ensure
    connection&.close
  end
end

# A pool that lends one connection at a time from +connections+ and records each discard.
class FakeHeartbeatPool
  attr_reader :lent, :discarded

  def initialize(connections)
    @connections = connections
    @lent = Concurrent::Array.new
    @discarded = Concurrent::Array.new
  end

  def with
    @current = @connections.shift
    @lent << @current
    yield @current
  end

  def discard_current_connection
    @discarded << @current
    yield @current
  end
end

# A FakeExecutor that is also a pool of +size+ connections. It answers statements through
# FakeExecutor#rows without a checkout, and it lends a new FakeHeartbeatConnection to each checkout:
# the heartbeat reservation and the readiness query. +held+ holds the connections that are not
# back. While +refuse+ is true, a checkout raises, as a pool does that cannot connect. While +block+
# holds an unset event, a heartbeat checkout waits for it, as a pool does that has no free connection.
class FakeLendingPool < FakeExecutor
  attr_accessor :capacity, :refuse, :block
  attr_reader :held, :checkouts

  def initialize(&)
    super
    @held = Concurrent::Array.new
    @checkouts = Concurrent::AtomicFixnum.new
    @refuse = false
  end

  def size = capacity || 3

  def with
    @checkouts.increment
    block&.wait(10) if Thread.current.name == "workhorse-heartbeat-checkout"
    raise PG::ConnectionBad, "connection refused" if refuse

    connection = FakeHeartbeatConnection.new
    @held << connection
    begin
      yield connection
    ensure
      @held.delete(connection)
      connection.close
    end
  end
end

# A pool of +size+ 3 that sends every statement through a checkout, as a real pool does, and answers
# it from the block. +statements+ records each [sql, params, thread] that a connection ran, and then
# +before_answer+ runs with the same values, if set; it can raise. The heartbeat checkout thread
# gets a FakeHeartbeatConnection for its rounds; +heartbeat+ holds the one it uses now. While
# +refuse_heartbeat+ is true, a heartbeat checkout raises. While +hold+ holds an unset event, every
# other checkout waits until it is set, apart from those of the readiness probe and of a thread named
# "test-runner". +waiting+ holds the threads that wait.
class FakeThroughPool
  # A connection that answers each statement from the pool.
  class Connection < FakeHeartbeatConnection
    def initialize(pool)
      super()
      @pool = pool
    end

    def exec_params(sql, params = [], _format = 0, _type_map = nil)
      super
      Result.new(@pool.answer(sql, params))
    end
  end

  attr_accessor :refuse_heartbeat, :hold, :before_answer
  attr_reader :statements, :heartbeat_checkouts, :heartbeat, :waiting

  def initialize(&answer)
    @answer = answer
    @statements = Concurrent::Array.new
    @heartbeat_checkouts = Concurrent::AtomicFixnum.new
    @refuse_heartbeat = false
    @hold = nil
    @heartbeat = nil
    @waiting = Concurrent::Array.new
  end

  def size = 3

  def with
    if Thread.current.name == "workhorse-heartbeat-checkout"
      @heartbeat_checkouts.increment
      raise PG::ConnectionBad, "connection refused" if refuse_heartbeat

      FakeHeartbeatConnection.lend do |connection|
        @heartbeat = connection
        yield connection
      end
    else
      gate = hold
      if gate && !%w[test-runner workhorse-readiness].include?(Thread.current.name)
        @waiting << Thread.current
        gate.wait(10)
        @waiting.delete(Thread.current)
      end
      connection = Connection.new(self)
      begin
        yield connection
      ensure
        connection.close
      end
    end
  end

  def answer(sql, params)
    return FakeExecutor::COMPATIBLE.map(&:dup) if sql == W::SqlCatalogue::COMPATIBILITY_STATE

    @statements << [sql, params, Thread.current]
    before_answer&.call(sql, params, Thread.current)
    @answer ? @answer.call(sql, params) : []
  end
end
