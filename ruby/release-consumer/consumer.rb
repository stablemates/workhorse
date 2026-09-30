# frozen_string_literal: true

# The clean consumer that `scripts/check-ruby-release.ts` runs against the packaged gem.
#
# The check installs the built `.gem` into an empty gem home and runs this file there, with no
# Bundler and no load path into the checkout. It therefore loads exactly the files RubyGems.org
# would serve. It uses the public API the way an application does, so a commit that changes that
# API updates this file too.
#
# Without an argument it prints where the gem loaded from and its version. With a PostgreSQL URL it
# enqueues one task, runs it through a worker, and prints the task id for the script to verify.

require "connection_pool"
require "pg"
require "stablemates/workhorse"

QUEUE = "release-consumer"
TASK_TYPE = "release.consumer"

url = ARGV.first
unless url
  spec = Gem.loaded_specs.fetch("stablemates-workhorse")
  puts spec.full_gem_path
  puts Stablemates::Workhorse::VERSION
  exit
end

pool = ConnectionPool.new(size: 4) { PG.connect(url) }
queue = Stablemates::Workhorse::Queue.new(pool, default_queue: QUEUE)
enqueued = queue.enqueue(TASK_TYPE, {"packaged" => true})

worker = Stablemates::Workhorse::Worker.new(pool, queues: [QUEUE])
worker.handle(TASK_TYPE) { |payload, _context| {"echo" => payload} }
raise "the worker ran no handler" unless worker.run_once

puts enqueued.task_id
pool.shutdown(&:close)
