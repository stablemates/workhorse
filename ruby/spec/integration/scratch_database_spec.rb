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

  # `pnpm db:sweep` takes this lock with no wait before it drops a scratch database. A test can have
  # no session on a scratch database, so only the lease keeps the sweep away (SM-1702).
  def sweep_locks?(sweep, url)
    name = URI.parse(url).path.delete_prefix("/")
    locked = sweep.exec_params("SELECT pg_try_advisory_lock(hashtextextended($1, 0))", [name]).getvalue(0, 0) == "t"
    sweep.exec_params("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [name]) if locked
    locked
  end

  it "keeps the sweep away from the scratch database and an extra database until their drop" do
    admin = URI.parse(ScratchDatabase.url)
    admin.path = "/postgres"
    sweep = PG.connect(admin.to_s)
    begin
      expect(sweep_locks?(sweep, ScratchDatabase.url)).to be(false)

      extra = ScratchDatabase.extra("sweep_lease")
      expect(sweep_locks?(sweep, extra)).to be(false)
      ScratchDatabase.drop_extra("sweep_lease")
      expect(sweep_locks?(sweep, extra)).to be(true)
    ensure
      sweep.close
    end
  end
end
