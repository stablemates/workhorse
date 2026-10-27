namespace Workhorse.Examples.Overview;

/// <summary>The payload of the <c>order.fulfill</c> task.</summary>
public sealed record OrderPayload(string OrderId, string Email);

/// <summary>The charge that the payment provider made for an order.</summary>
public sealed record Charge(string Id);

/// <summary>The payload of the <c>order-shipped</c> signal.</summary>
public sealed record Shipped(string TrackingNumber);

/// <summary>The result of the <c>order.fulfill</c> task.</summary>
public sealed record Fulfillment(Charge Charge, string TrackingNumber);

/// <summary>The result of the receipt email.</summary>
public sealed record ReceiptResult(bool Sent);

/// <summary>The payment provider that charges the card of an order.</summary>
public interface IPayments
{
    Task<Charge> ChargeAsync(string orderId, string idempotencyKey, CancellationToken cancellationToken);
}

/// <summary>The service that sends the receipt.</summary>
public interface IMailer
{
    Task<ReceiptResult> ReceiptAsync(
        string email, Charge charge, string trackingNumber, CancellationToken cancellationToken);
}

/// <summary>The C# tab of the site page "What is Workhorse?".</summary>
public sealed class OverviewExamples(IPayments payments, IMailer mailer)
{
    /// <summary>Stores the merchant limit, enqueues one fulfillment, and registers its handler.</summary>
    public async Task FulfillAsync(Queue queue, Worker worker, string orderId, string email, string merchantId)
    {
        ArgumentNullException.ThrowIfNull(queue);
        ArgumentNullException.ThrowIfNull(worker);
        // docs:start csharp-overview-fulfill
        // Step 1: allow three active fulfillments per merchant, across all workers.
        // PostgreSQL applies this limit when a worker claims a task.
        await queue.SyncConcurrencyPoliciesAsync(
            "shop",
            [new ConcurrencyPolicyDefinition { Queue = "fulfillment", MaxActive = 20, MaxActivePerKey = 3 }]);

        // Enqueue the task. The merchant is the concurrency key.
        await queue.EnqueueAsync(
            "order.fulfill",
            new OrderPayload(orderId, email),
            new EnqueueOptions { Queue = "fulfillment", ConcurrencyKey = merchantId });

        worker.Handle<OrderPayload, Fulfillment>(
            "order.fulfill",
            async (context, order) =>
            {
                // Step 2: charge the card. The checkpoint stores the charge.
                // On a later run, it returns the stored charge, and the handler
                // does not charge the card a second time.
                var charge = await context.CheckpointAsync(
                    "charge",
                    ct => payments.ChargeAsync(order.OrderId, $"charge:{order.OrderId}", ct));

                // Step 3: wait until the carrier ships the parcel. The task releases
                // its worker, and it does not count against the merchant limit.
                var shipped = await context.WaitForSignalAsync<Shipped>("order-shipped", null);

                // Step 4: the signal arrived. The handler ran again from its first line,
                // and the "charge" checkpoint gave back the stored charge.

                // Step 5: send the receipt with the tracking number.
                await context.CheckpointAsync(
                    "receipt",
                    ct => mailer.ReceiptAsync(order.Email, charge, shipped.TrackingNumber, ct));
                return new Fulfillment(charge, shipped.TrackingNumber);
            });
        // docs:end
    }
}
