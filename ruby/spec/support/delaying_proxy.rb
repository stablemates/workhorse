# frozen_string_literal: true

require "rbconfig"
require "socket"

# A TCP proxy between a client and PostgreSQL that delays each client-to-server write of a
# statement by +delay+ seconds and keeps the order of the writes. PostgreSQL thus sees an idle gap
# of about +delay+ before each statement, as on a slow network. The startup and the authentication
# of a connection, and the server-to-client direction, have no delay.
#
# +DelayingProxy.start+ runs the proxy in a child process, so the threads of the process under test
# cannot add more delay to the threads of the proxy. The result gives the local +port+ that clients
# connect to, and +close+ ends the proxy and every connection through it.
class DelayingProxy
  # The first byte of each frontend message that starts a statement or a step of one: Query, Parse,
  # Bind, Describe, Execute, Sync, Close, Flush, and Function call.
  STATEMENT_TYPES = %w[Q P B D E S C H F].freeze

  # A running proxy process.
  Child = Struct.new(:pid, :port) do
    def close
      Process.kill("TERM", pid)
      Process.wait(pid)
    rescue Errno::ESRCH, Errno::ECHILD
      nil
    end
  end

  # Starts a proxy process to +host+:+port+, and returns its Child when it listens.
  def self.start(host, port, delay)
    reader, writer = IO.pipe
    pid = Process.spawn(RbConfig.ruby, __FILE__, host, port.to_s, delay.to_s, out: writer)
    writer.close
    line = reader.gets
    reader.close
    raise "the delaying proxy did not start" if line.nil?

    Child.new(pid, Integer(line, 10))
  end

  attr_reader :port

  def initialize(host, port, delay)
    @host = host
    @upstream_port = port
    @delay = delay
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
  end

  # Accepts connections until the process ends.
  def run
    loop do
      client = @server.accept
      upstream = TCPSocket.new(@host, @upstream_port)
      [client, upstream].each { |socket| socket.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1) }
      writes = Thread::Queue.new
      Thread.new { read_delayed(client, writes) }
      Thread.new { write_delayed(writes, upstream, client) }
      Thread.new { pump(upstream, client) }
    end
  end

  private

  # Reads from +client+ and queues each chunk with the monotonic time when it can go upstream.
  def read_delayed(client, writes)
    due = 0
    loop do
      # The due time counts from the end of the read, not from its start, so a write after an idle
      # gap gets the full delay too. A write of the startup or the authentication goes at once, but
      # never before a write that came earlier.
      data = client.readpartial(65_536)
      due = [due, monotonic + (STATEMENT_TYPES.include?(data[0]) ? @delay : 0)].max
      writes << [due, data]
    end
  rescue IOError, SystemCallError
    writes << nil
  end

  # Writes each queued chunk to +upstream+ at its time, in order.
  def write_delayed(writes, upstream, client)
    while (entry = writes.pop)
      due, data = entry
      wait = due - monotonic
      sleep wait if wait.positive?
      upstream.write(data)
    end
  rescue IOError, SystemCallError
    nil
  ensure
    close_socket(upstream)
    close_socket(client)
  end

  def pump(from, to)
    loop { to.write(from.readpartial(65_536)) }
  rescue IOError, SystemCallError
    nil
  ensure
    close_socket(to)
    close_socket(from)
  end

  def close_socket(socket)
    socket.close unless socket.closed?
  rescue IOError, SystemCallError
    nil
  end

  def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)
end

if $PROGRAM_NAME == __FILE__
  host, port, delay = ARGV
  proxy = DelayingProxy.new(host, Integer(port, 10), Float(delay))
  $stdout.puts proxy.port
  $stdout.flush
  Signal.trap("TERM") { exit!(0) }
  proxy.run
end
