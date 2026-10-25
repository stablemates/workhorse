namespace Workhorse.Examples.Durable;

/// <summary>The payload of the <c>order.fulfill</c> and <c>order.review</c> tasks.</summary>
public sealed record OrderPayload(string OrderId);

/// <summary>The payload of the <c>trial.follow-up</c> task.</summary>
public sealed record TrialPayload(string To, DateTimeOffset FollowUpAt);

/// <summary>A charge of the payment provider.</summary>
public sealed record Charge(string Id);

/// <summary>A shipment of the logistics provider.</summary>
public sealed record Shipment(string ShipmentId, string ChargeId);

/// <summary>The parcel that the warehouse sends as the <c>packed</c> signal.</summary>
public sealed record Parcel(string ParcelId);

/// <summary>The result of one email.</summary>
public sealed record MailResult(bool Sent);

/// <summary>The event that the provider sends as a signal.</summary>
public sealed record ProviderEvent(string Id);

/// <summary>The decision of a person.</summary>
public sealed record Review(bool Approved);

/// <summary>The payment provider of the order handler.</summary>
public interface IPayments
{
    Task<Charge> ChargeAsync(string orderId, string idempotencyKey, CancellationToken cancellationToken);
}

/// <summary>The shipment provider of the order handler.</summary>
public interface ILogistics
{
    Task<Shipment> CreateShipmentAsync(string orderId, Charge charge, CancellationToken cancellationToken);
}

/// <summary>The mail provider of the trial handler.</summary>
public interface ITrialMailer
{
    Task<MailResult> WelcomeAsync(string recipient, CancellationToken cancellationToken);

    Task<MailResult> FollowUpAsync(string recipient, CancellationToken cancellationToken);
}

/// <summary>The C# tabs of the site page about durable execution.</summary>
public sealed class DurableExecutionExamples(IPayments payments, ILogistics logistics, ITrialMailer mailer)
{
    /// <summary>Registers the <c>order.fulfill</c> handler, which keeps its finished work in checkpoints.</summary>
    public void RegisterCheckpoints(Worker worker)
    {
        ArgumentNullException.ThrowIfNull(worker);
        worker.Handle<OrderPayload, Shipment>(
            "order.fulfill",
            async (context, payload) =>
            {
                var orderId = payload.OrderId;
                // docs:start csharp-durable-execution-checkpoint
                var charge = await context.CheckpointAsync(
                    "charge", ct => payments.ChargeAsync(orderId, $"charge:{orderId}", ct));
                var shipment = await context.CheckpointAsync(
                    "shipment", ct => logistics.CreateShipmentAsync(orderId, charge, ct));
                // docs:end
                return shipment;
            });
    }

    /// <summary>
    /// Registers the <c>order.fulfill</c> handler of the "What is Workhorse?" page, which waits for the
    /// warehouse between two checkpoints.
    /// </summary>
    public void RegisterFulfillment(Worker worker)
    {
        ArgumentNullException.ThrowIfNull(worker);
        worker.Handle<OrderPayload, Shipment>(
            "order.fulfill",
            async (context, payload) =>
            {
                var orderId = payload.OrderId;
                // docs:start csharp-overview-fulfill
                var charge = await context.CheckpointAsync(
                    "charge", ct => payments.ChargeAsync(orderId, $"charge:{orderId}", ct));
                await context.WaitForSignalAsync<Parcel>("packed", null);
                var shipment = await context.CheckpointAsync(
                    "shipment", ct => logistics.CreateShipmentAsync(orderId, charge, ct));
                // docs:end
                return shipment;
            });
    }

    /// <summary>Registers the <c>trial.follow-up</c> handler, which waits for a time between two emails.</summary>
    public void RegisterFollowUp(Worker worker)
    {
        ArgumentNullException.ThrowIfNull(worker);
        worker.Handle<TrialPayload>(
            "trial.follow-up",
            async (context, payload) =>
            {
                var to = payload.To;
                var followUpAt = payload.FollowUpAt;
                // docs:start csharp-durable-execution-sleep-until
                await context.CheckpointAsync("welcome", ct => mailer.WelcomeAsync(to, ct));
                await context.SleepUntilAsync("follow-up-window", followUpAt);
                await context.CheckpointAsync("follow-up", ct => mailer.FollowUpAsync(to, ct));
                // docs:end
            });
    }

    /// <summary>Registers the <c>order.review</c> handler, which waits for a signal and for a person.</summary>
    public static void RegisterExternalWaits(Worker worker)
    {
        ArgumentNullException.ThrowIfNull(worker);
        worker.Handle<OrderPayload, object>(
            "order.review",
            async (context, payload) =>
            {
                // docs:start csharp-durable-execution-external-waits
                var providerEvent = await context.WaitForSignalAsync<ProviderEvent>("provider-event", null);
                var review = await context.WaitForHumanAsync<object, Review>(
                    "operator-review", new { eventId = providerEvent.Id }, null);
                // docs:end
                return new { @event = providerEvent, review };
            });
    }

}
