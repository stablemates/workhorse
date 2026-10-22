using System.Text.Json;
using System.Text.RegularExpressions;
using Npgsql;
using Workhorse.Internal.Database;
using Workhorse.Tests.Testing;

namespace Workhorse.Tests.Exceptions;

/// <summary>The exception set mirrors Ruby's <c>errors.rb</c> class for class (ADR 0107, "Errors").</summary>
public sealed partial class ExceptionTests
{
    [Fact]
    public void EveryRubyErrorHasAnExceptionClassWithTheSameParent()
    {
        var source = File.ReadAllText(Repository.Path("ruby/lib/stablemates/workhorse/errors.rb"));
        var classes = RubyClass().Matches(source).Select(match => (Name: match.Groups[1].Value, Parent: match.Groups[2].Value)).ToList();
        Assert.NotEmpty(classes);
        foreach (var (name, parent) in classes)
        {
            var type = typeof(WorkhorseException).Assembly.GetType($"Workhorse.{CSharpName(name)}");
            Assert.True(type is not null, $"no C# class for {name}");
            var expected = parent == "StandardError" ? typeof(Exception) : typeof(WorkhorseException).Assembly.GetType($"Workhorse.{CSharpName(parent)}");
            Assert.Equal(expected, type!.BaseType);
            Assert.True(type.IsPublic);
        }
    }

    [Fact]
    public void DotNetAddsTheIsolationLevelException()
    {
        Assert.Equal(typeof(DatabaseException), typeof(IsolationLevelException).BaseType);
        var error = new IsolationLevelException("repeatable read", "message", null);
        Assert.Equal("0A000", error.SqlState);
        Assert.Equal("repeatable read", error.IsolationLevel);
    }

    [Fact]
    public void MessagesMatchTheOtherSdks()
    {
        Assert.Equal("workhorse compatibility check refused: schema-too-old", new CompatibilityException(CompatibilityCode.SchemaTooOld).Message);
        Assert.Equal("progress is rate limited; retry after 1.5 seconds", new ProgressRateLimitedException(TimeSpan.FromMilliseconds(1500)).Message);
        Assert.Equal("task cancelled: deadline_exceeded", new CancelledException(CancelReason.DeadlineExceeded).Message);
        Assert.Equal("child greet conflicts: stored child \"wave\", requested child \"greet\"", new ConflictException("child", "greet", "wave").Message);
        Assert.Equal("child greet conflicts with a different retained request", new ConflictException("child", "greet").Message);
        Assert.Equal("send_signal returned unexpected status \"odd\"", new UnexpectedStatusException("send_signal", "odd").Message);
        Assert.Equal("send_signal returned unexpected status null", new UnexpectedStatusException("send_signal", null).Message);
        Assert.Equal("Fast-tier queue fast does not support dependencies", new FastTierUnsupportedException("fast", "dependencies", 2).Message);
    }

    [Fact]
    public void TaskGroupClosedReadsItsDetails()
    {
        var group = Guid.NewGuid();
        var error = new TaskGroupClosedException(Details($$"""{"groupId":"{{group}}","state":"sealed","reason":"not_running_member"}"""));
        Assert.Equal(group, error.GroupId);
        Assert.Equal(TaskGroupState.Sealed, error.State);
        Assert.Equal(TaskGroupClosedReason.NotRunningMember, error.Reason);
        Assert.Equal($"Task group {group} does not accept tasks (not_running_member)", error.Message);

        var unknown = new TaskGroupClosedException(Details("""{"reason":"later"}"""));
        Assert.Null(unknown.Reason);
        Assert.Null(unknown.GroupId);
    }

    public static TheoryData<string, Type> SqlStateCases() => new()
    {
        { "P1001", typeof(EnqueueIdempotencyConflictException) },
        { "P1002", typeof(RedriveIdempotencyConflictException) },
        { "P1003", typeof(DependencyCycleException) },
        { "P1005", typeof(DependencyLimitExceededException) },
        { "P1006", typeof(PurgeIdempotencyConflictException) },
        { "P1007", typeof(FastTierUnsupportedException) },
        { "P1008", typeof(TaskGroupClosedException) },
        { "P1009", typeof(TaskGroupLimitExceededException) },
        { "P1010", typeof(TaskGroupMembershipConflictException) },
        { "0A000", typeof(DatabaseException) },
        { "23505", typeof(DatabaseException) },
    };

    [Theory]
    [MemberData(nameof(SqlStateCases))]
    public void TranslatesEachSqlState(string sqlState, Type expected)
    {
        var translated = SqlStates.Translate(Postgres(sqlState, "message", """{"queue":"fast","feature":"dependencies","ordinal":3}"""));
        Assert.IsType(expected, translated);
        if (translated is DatabaseException database)
        {
            Assert.Equal(sqlState, database.SqlState);
            Assert.IsType<PostgresException>(database.InnerException);
        }
    }

    [Fact]
    public void TranslatesTheIsolationRefusal()
    {
        var translated = SqlStates.Translate(Postgres("0A000", "Workhorse claims require read committed isolation, not repeatable read", null));
        var error = Assert.IsType<IsolationLevelException>(translated);
        Assert.Equal("repeatable read", error.IsolationLevel);
    }

    [Fact]
    public void TranslatesTheFastTierDetails()
    {
        var error = Assert.IsType<FastTierUnsupportedException>(
            SqlStates.Translate(Postgres("P1007", "refused", """{"queue":"fast","feature":"dependencies","ordinal":3}""")));
        Assert.Equal("fast", error.Queue);
        Assert.Equal("dependencies", error.Feature);
        Assert.Equal(3, error.Ordinal);
    }

    [Fact]
    public void KeepsADetailThatIsNotJsonOutOfTheDetails()
    {
        var error = Assert.IsType<EnqueueIdempotencyConflictException>(SqlStates.Translate(Postgres("P1001", "refused", "not json")));
        Assert.Empty(error.Details);
    }

    private static PostgresException Postgres(string sqlState, string message, string? detail) =>
        new(message, "ERROR", "ERROR", sqlState, detail);

    private static Dictionary<string, JsonElement> Details(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    private static string CSharpName(string ruby) => ruby == "Error" ? "WorkhorseException" : ruby[..^"Error".Length] + "Exception";

    [GeneratedRegex(@"^\s*class (\w+Error|Error) < (\w+)", RegexOptions.Multiline)]
    private static partial Regex RubyClass();
}
