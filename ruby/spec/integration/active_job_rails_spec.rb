# frozen_string_literal: true

require "rbconfig"
require "securerandom"
require "tmpdir"

# Boots the Rails application in spec/fixtures/rails_app in child processes, as a deployment would.
RSpec.describe "Active Job in a Rails application" do
  include_context "with a scratch database"

  let(:app) { File.expand_path("../fixtures/rails_app", __dir__) }

  around do |example|
    Dir.mktmpdir do |directory|
      @output = File.join(directory, "output")
      example.run
    end
  end

  def environment
    {"DATABASE_URL" => ScratchDatabase.url, "WORKHORSE_QUEUE" => @queue_name, "FIXTURE_OUTPUT" => @output}
  end

  def lines = File.exist?(@output) ? File.readlines(@output, chomp: true) : []

  it "selects the adapter by name and runs both formats under the worker its bin/ script starts" do
    enqueue = 'GreetingJob.perform_later("ada"); TypedGreetingJob.perform_later({"name" => "grace"}); ' \
      "print ActiveJob::Base.queue_adapter.class.name"
    output = IO.popen(environment, [RbConfig.ruby, "-r", "./config/environment", "-e", enqueue],
      chdir: app, &:read)
    expect($?.success?).to be(true)
    expect(output).to eq("ActiveJob::QueueAdapters::StablematesWorkhorseAdapter")
    expect(task_count).to eq(2)

    worker = Process.spawn(environment, RbConfig.ruby, "bin/workhorse", chdir: app)
    begin
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 30
      sleep(0.05) until lines.length == 2 || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      expect(lines).to contain_exactly("default ada", "typed grace")
    ensure
      Process.kill("TERM", worker)
      _, status = Process.wait2(worker)
    end
    expect(status.exitstatus).to eq(0)
  end
end
