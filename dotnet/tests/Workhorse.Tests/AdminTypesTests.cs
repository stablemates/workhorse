using System.Reflection;

namespace Workhorse.Tests;

/// <summary>The public <c>Admin</c> types follow the rules of ADR 0107, "Public types grow only additively".</summary>
public sealed class AdminTypesTests
{
    [Fact]
    public void OnlyTheSdkDerivesATimelineEntry()
    {
        // A closed result family has no constructor that another assembly can call.
        var constructors = typeof(TaskTimelineEntry).GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotEmpty(constructors);
        Assert.All(constructors, constructor => Assert.False(constructor.IsPublic || constructor.IsFamily || constructor.IsFamilyOrAssembly));
        Assert.True(typeof(TaskTimelineEvent).IsSealed);
        Assert.True(typeof(TaskTimelineAttempt).IsSealed);
    }

    public static TheoryData<Type> Records() =>
    [
        typeof(AdminAudit), typeof(AdminOptions), typeof(TaskQuery), typeof(TaskPayloadProjection), typeof(TaskListCursor),
        typeof(TaskPage), typeof(TaskListItem), typeof(TaskDependencyPolicy), typeof(TaskDetail), typeof(TimelineQuery),
        typeof(TaskTimelineCursor), typeof(TimelinePage), typeof(DeadLetterQuery), typeof(RedriveFilter), typeof(DeadLetterCursor),
        typeof(DeadLetterPage), typeof(DeadLetter), typeof(RedriveResult), typeof(BulkRedrivePage), typeof(TaskCheckpoint),
        typeof(TaskProgress), typeof(TaskWait), typeof(SignalWaitQuery), typeof(HumanWaitQuery), typeof(ExternalWaitCursor),
        typeof(SignalWait), typeof(SignalWaitPage), typeof(HumanWait), typeof(HumanWaitPage), typeof(WorkerInfo),
        typeof(WorkerPauseResult), typeof(QueueHistory), typeof(TaskGroupEvent), typeof(TaskGroupDrift), typeof(TaskGroupRepair),
    ];

    [Theory]
    [MemberData(nameof(Records))]
    public void ARecordIsSealedWithoutPositionalParameters(Type type)
    {
        Assert.True(type.IsSealed);
        Assert.NotNull(type.GetMethod("<Clone>$"));
        Assert.Null(type.GetMethod("Deconstruct"));
        Assert.All(type.GetConstructors(), constructor => Assert.True(constructor.GetParameters().Length == 0 || constructor.GetParameters()[0].ParameterType == type));
    }
}
