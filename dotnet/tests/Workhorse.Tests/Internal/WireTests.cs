using Workhorse.Internal;

namespace Workhorse.Tests.Internal;

public sealed class WireTests
{
    [Fact]
    public void SpellsEnumMembersInLowerSnakeCase()
    {
        Assert.Equal("not_running_member", Wire.Text(TaskGroupClosedReason.NotRunningMember));
        Assert.Equal(TaskState.Succeeded, Wire.Optional<TaskState>("succeeded"));
        Assert.Null(Wire.Optional<TaskState>("Succeeded"));
        Assert.Null(Wire.Optional<TaskState>(null));
    }

    [Fact]
    public void RefusesAnUndefinedMember() =>
        Assert.Throws<ArgumentException>(() => Wire.Text((DebounceSchedule)99));

    [Fact]
    public void AnUnknownRequiredStatusThrows()
    {
        var error = Assert.Throws<UnexpectedStatusException>(() => Wire.Required<TaskState>("cancel", "paused"));
        Assert.Equal("paused", error.Status);
    }
}
