namespace Workhorse.Examples.Workers;

/// <summary>The payload of an <c>email.send</c> task in the snippets about workers.</summary>
public sealed record Email(string To);

/// <summary>The result that the mail provider gives for one email.</summary>
public sealed record Delivery(string DeliveredTo);

/// <summary>The mail provider of the snippets about workers.</summary>
public interface IMailer
{
    /// <summary>Sends one email and returns the result that the task stores.</summary>
    Task<Delivery> SendAsync(Email email, CancellationToken cancellationToken);
}

/// <summary>The answer of the email provider for one email of a batch. The provider sets <see cref="Error"/> when it did not accept the email.</summary>
public sealed record BatchDelivery(string Id, Exception? Error);

/// <summary>The email provider of the snippets about batch handlers.</summary>
public interface IBatchEmailProvider
{
    /// <summary>Sends the emails in one request, and returns one delivery for each email, in order.</summary>
    Task<IReadOnlyList<BatchDelivery>> SendManyAsync(IReadOnlyList<Email> emails, CancellationToken cancellationToken);
}

/// <summary>A scoped service of the hosted handler: one mail session for each attempt.</summary>
public sealed class MailSession(IMailer mailer)
{
    /// <summary>Sends one email in this session.</summary>
    public Task<Delivery> SendAsync(Email email, CancellationToken cancellationToken) => mailer.SendAsync(email, cancellationToken);
}

/// <summary>The operator of the snippets about operations.</summary>
public sealed record OperationsActor(string Email);
