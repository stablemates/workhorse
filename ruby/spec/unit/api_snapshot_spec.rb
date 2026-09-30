# frozen_string_literal: true

require "tempfile"
require_relative "../../tools/api_snapshot"

RSpec.describe ApiSnapshot do
  it "keeps the whitespace inside a literal default and collapses the rest" do
    Tempfile.create(["api_snapshot", ".rb"]) do |file|
      file.write(<<~RUBY)
        def spaced(a = "one  two", b = /x  y/, c: :"p  q",
            d: 1)
        end
        def plain(a = "one two", b = /x y/, c: :"p q", d: 1)
        end
      RUBY
      file.flush
      source = ApiSnapshot::Source.new

      expect(source.parameters([file.path, 1])).to eq('a = "one  two", b = /x  y/, c: :"p  q", d: 1')
      expect(source.parameters([file.path, 4])).to eq('a = "one two", b = /x y/, c: :"p q", d: 1')
    end
  end

  it "lists every keyword a public method accepts" do
    lines = ApiSnapshot::Walker.new.run.lines(chomp: true)

    expect(lines).to include(a_string_matching(/def list_dead_letters\(.*finished_before: nil\)\z/))
    expect(lines).to include(a_string_matching(/def redrive_many\(.*finished_before: nil\)\z/))
    expect(lines).to include("  OPTION_KEYS = [:task_type, :max_attempts, :tags, :concurrency_key]")
    expect(lines).to include(a_string_ending_with("# keywords: Stablemates::Workhorse::ActiveJob::OPTION_KEYS"))
  end

  it "stops on a public ** whose keywords it cannot name" do
    stub_const("ApiSnapshot::KEYWORD_SOURCES",
      ApiSnapshot::KEYWORD_SOURCES.except("Stablemates::Workhorse::Queue#enqueue"))

    expect { ApiSnapshot::Walker.new.run }
      .to raise_error(RuntimeError, /\AStablemates::Workhorse::Queue#enqueue takes \*\* keywords/)
  end
end
