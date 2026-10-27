using System.Collections.Concurrent;
using Workhorse.Examples.Overview;
using Workhorse.Examples.Tests.Durable;
using Workhorse.Examples.Tests.Testing;
using Workhorse.Tests.Testing;

namespace Workhorse.Examples.Tests.Overview;

/// <summary>Runs the C# fulfillment of the site page "What is Workhorse?".</summary>
public sealed class OverviewExamplesTests(ScratchDatabase scratch) : IPayments, IMailer
{
    private readonly ExampleDatabase _db = ExampleDatabase.Shared(scratch);
    private readonly ConcurrentQueue<string> _calls = new();
    private int _receipts;

    [Fact(Timeout = 120_000)]
    public async Task TheFulfillmentWaitsForTheParcelAndChargesTheCardOneTime()
    {
        var token = TestContext.Current.CancellationToken;
        var driver = new DurableFlowDriver(_db);
        await using var worker = driver.CreateWorker();
        var enqueued = $"csharp-{Guid.NewGuid()}";
        await new OverviewExamples(this, this).FulfillAsync(_db.Queue, worker, enqueued, "ada@example.com", "merchant-42");

        var policy = Assert.Single(
            await _db.Queue.ListConcurrencyPoliciesAsync(token), stored => stored.Queue == "fulfillment");
        Assert.Equal("shop", policy.Namespace);
        Assert.Equal(3, policy.MaxActivePerKey);
        var stored = await _db.TaskAsync("order.fulfill", "orderId", enqueued);
        Assert.Equal("fulfillment", stored.Queue);
        Assert.Equal("merchant-42", stored.ConcurrencyKey);

        var taskId = await driver.EnqueueAsync(
            "order.fulfill", new { orderId = "order-9", email = "ada@example.com" }, token);
        await driver.DeliverSignalAsync(worker, taskId, "order-shipped", new { trackingNumber = "TRK-1" });
        var task = await driver.FinishAsync(worker, taskId);
        Assert.Equal(TaskState.Succeeded, task.State);
        Assert.Equal(2, task.CurrentAttempt);
        Assert.Equal(
            ["charge order-9 charge:order-9", "receipt ada@example.com TRK-1", "receipt ada@example.com TRK-1"],
            _calls);
        JsonAssert.Equal("""{"charge":{"id":"ch-order-9"},"trackingNumber":"TRK-1"}""", task.Result);
    }

    Task<Charge> IPayments.ChargeAsync(string orderId, string idempotencyKey, CancellationToken cancellationToken)
    {
        _calls.Enqueue($"charge {orderId} {idempotencyKey}");
        return Task.FromResult(new Charge($"ch-{orderId}"));
    }

    Task<ReceiptResult> IMailer.ReceiptAsync(
        string email, Charge charge, string trackingNumber, CancellationToken cancellationToken)
    {
        _calls.Enqueue($"receipt {email} {trackingNumber}");
        if (Interlocked.Increment(ref _receipts) == 1)
        {
            throw new InvalidOperationException("the mail service is not available");
        }
        return Task.FromResult(new ReceiptResult(true));
    }
}
