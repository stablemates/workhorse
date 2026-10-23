namespace Workhorse.Examples.Durable;

/// <summary>The order that the snippets of the site page about child tasks charge.</summary>
public sealed record ChildTasksOrder(string Id);

/// <summary>The receipt of the <c>payments.charge</c> child.</summary>
public sealed record Receipt(string ReceiptId);

/// <summary>The C# tabs of the site page about child tasks. Each method runs inside a handler.</summary>
public static class ChildTasksExamples
{
    /// <summary>Charges the order in one child task, and returns the receipt of the child.</summary>
    public static async Task<Receipt> ChargeAsync(HandlerContext context, ChildTasksOrder order)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(order);
        // docs:start csharp-child-tasks-run-child
        var charge = await context.RunChildAsync<object, Receipt>(
            "charge",
            "payments.charge",
            new { orderId = order.Id },
            new EnqueueOptions { Queue = "payments" });
        // docs:end
        return charge;
    }

    /// <summary>Checks the order for fraud and reserves its stock in two child tasks at the same time.</summary>
    public static async Task<object> CheckoutAsync(HandlerContext context, string orderId)
    {
        ArgumentNullException.ThrowIfNull(context);
        // docs:start csharp-child-tasks-run-children
        var results = await context.RunChildrenAsync(
        [
            new ChildRequest { Name = "fraud", TaskType = "orders.check-fraud", Payload = new { orderId } },
            new ChildRequest { Name = "inventory", TaskType = "orders.reserve", Payload = new { orderId } },
        ]);

        var fraud = results["fraud"];
        if (fraud.Status == ChildStatus.Failed)
        {
            return new { accepted = false, reason = fraud.Error };
        }
        // docs:end
        return new { accepted = true };
    }
}
