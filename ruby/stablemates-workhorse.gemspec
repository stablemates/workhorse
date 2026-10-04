# frozen_string_literal: true

require_relative "lib/stablemates/workhorse/version"

Gem::Specification.new do |spec|
  spec.name = "stablemates-workhorse"
  spec.version = Stablemates::Workhorse::VERSION
  spec.authors = ["Stablemates"]
  spec.summary = "Ruby SDK for Workhorse, a durable task queue whose state lives in PostgreSQL"
  spec.homepage = "https://github.com/stablemates/workhorse"
  spec.license = "Apache-2.0"
  spec.required_ruby_version = ">= 3.3"
  spec.metadata = {
    "source_code_uri" => "https://github.com/stablemates/workhorse/tree/main/ruby",
    "changelog_uri" => "https://github.com/stablemates/workhorse/blob/main/ruby/CHANGELOG.md",
    "rubygems_mfa_required" => "true"
  }

  spec.files = Dir["lib/**/*.{rb,json,tar.gz}"] + %w[CHANGELOG.md LICENSE NOTICE README.md]
  spec.require_paths = ["lib"]

  spec.add_dependency "concurrent-ruby", ">= 1.3.1", "< 2"
  spec.add_dependency "connection_pool", ">= 2.5", "< 4"
  spec.add_dependency "logger", ">= 1.6", "< 2"
  spec.add_dependency "pg", ">= 1.6", "< 2"
end
