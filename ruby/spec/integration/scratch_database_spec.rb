# frozen_string_literal: true

# A host I/O stall can make a WAL flush take seconds, so a commit in a test does not wait for it
# (SM-1809). A new session of the scratch database and of an extra database takes the setting.
RSpec.describe "The scratch databases of the Ruby tests" do
  include_context "with a scratch database"

  def synchronous_commit(connection) = connection.exec("SHOW synchronous_commit").getvalue(0, 0)

  it "commits without waiting for the WAL flush" do
    expect(synchronous_commit(@connection)).to eq("off")

    extra = PG.connect(ScratchDatabase.extra("synchronous_commit"))
    begin
      expect(synchronous_commit(extra)).to eq("off")
    ensure
      extra.close
      ScratchDatabase.drop_extra("synchronous_commit")
    end
  end
end
