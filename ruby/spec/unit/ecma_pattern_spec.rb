# frozen_string_literal: true

# EcmaPattern is internal; the dashboard validator compiles its schema patterns with it.
RSpec.describe "EcmaPattern" do
  let(:described_class) { Stablemates::Workhorse.const_get(:EcmaPattern) }

  def match?(source, value) = described_class.compile(source).match?(value)

  it "matches with ECMA-262 semantics" do
    expect(match?("^a$", "a")).to be(true)
    expect(match?("^a$", "a\nb")).to be(false), "^ and $ do not match at line ends"
    expect(match?("^.$", "\r")).to be(false), ". excludes every line terminator"
    expect(match?("^\\s$", "\u0085")).to be(false), "\\s excludes NEL"
    expect(match?("^\\w$", "é")).to be(false), "\\w is ASCII"
    expect(match?("\\bb", "éb")).to be(true), "\\b uses ASCII word characters"
    expect(match?("^(?<x>a)(b)$", "ab")).to be(true), "a named group beside a plain one"
    expect(match?("^\\\\1$", "\\1")).to be(true), "an escaped backslash is not a backreference"
    expect(match?("^\\p{Lu}$", "A")).to be(true)
    expect(match?("^\\p{Script=Greek}\\p{sc=Grek}$", "αβ")).to be(true)
    expect(match?("^\\p{digit}$", "٣")).to be(true), "digit is Decimal_Number"
    expect(match?("^\\P{gc=L}$", "α")).to be(false)
  end

  it "refuses a source outside the u-flag grammar" do
    ["(", "\\p{greek}", "\\p{Greek}", "\\p{Script=Lu}", "\\p{gc=ASCII}", "\\p{Other_Alphabetic}", "\\p{Alnum}",
      "(?i)a", "\\A", "\\h", "a{2,1}", "(?<x>a)(?<x>b)", "^(a)\\1$", "^(?<x>a)\\k<x>$"].each do |source|
      expect { described_class.compile(source) }.to raise_error(ArgumentError), source
    end
  end
end
