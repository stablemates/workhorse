# frozen_string_literal: true

require "open3"
require "rbconfig"

# Each example runs in a new process, because Active Job runs its load hooks once per process.
RSpec.describe "Active Job below the adapter floor" do
  lib = File.expand_path("../../lib", __dir__)
  # Rails loads Active Support before the gems of the application, so the hook of the gem exists
  # when Active Job loads. The stubbed version stands in for an Active Job older than the floor.
  below_floor = <<~RUBY
    require "active_support"
    require "stablemates/workhorse"
    require "active_job"
    ActiveJob.define_singleton_method(:gem_version) { Gem::Version.new("8.0.5") }
  RUBY

  # Gives stdout, and true when the process succeeded. Stderr carries interpreter warnings, such as
  # the ones Bundler prints on Ruby 4.0, so a failed process gives its stderr instead of true.
  define_method(:run_ruby) do |source|
    stdout, stderr, status = Open3.capture3(RbConfig.ruby, "-I", lib, "-e", below_floor + source)
    [stdout, status.success? || stderr]
  end

  it "loads Active Job without the adapter, so an application that uses only the native API boots" do
    output, succeeded = run_ruby(<<~RUBY)
      ActiveJob::Base
      print $LOADED_FEATURES.any? { |path| path.end_with?("stablemates/workhorse/active_job.rb") }, " "
      print Stablemates::Workhorse::Queue.name
    RUBY

    expect([output, succeeded]).to eq(["false Stablemates::Workhorse::Queue", true])
  end

  it "raises LoadError when the application selects the adapter by name" do
    output, succeeded = run_ruby(<<~RUBY)
      begin
        ActiveJob::Base.queue_adapter = :stablemates_workhorse
      rescue LoadError => error
        print error.message
      end
    RUBY

    expect([output, succeeded])
      .to eq(["the Workhorse Active Job adapter requires Active Job 8.1 or later (found 8.0.5)", true])
  end

  it "raises LoadError when the application requires the adapter" do
    output, succeeded = run_ruby(<<~RUBY)
      ActiveJob::Base
      begin
        require "stablemates/workhorse/active_job"
      rescue LoadError => error
        print error.message
      end
    RUBY

    expect([output, succeeded])
      .to eq(["the Workhorse Active Job adapter requires Active Job 8.1 or later (found 8.0.5)", true])
  end
end
