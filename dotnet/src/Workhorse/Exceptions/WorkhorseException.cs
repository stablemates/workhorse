namespace Workhorse;

/// <summary>
/// The root of every error the SDK throws (ADR 0107, "Errors"). A caller catches a category, not
/// one class per primitive. An invalid argument throws <see cref="ArgumentException"/> instead.
/// </summary>
public class WorkhorseException : Exception
{
    /// <summary>An exception with a default message.</summary>
    public WorkhorseException()
        : base("Workhorse refused the operation")
    {
    }

    /// <summary>An exception with <paramref name="message"/>.</summary>
    public WorkhorseException(string message)
        : base(message)
    {
    }

    /// <summary>An exception with <paramref name="message"/> and the exception that caused it.</summary>
    public WorkhorseException(string message, Exception? innerException)
        : base(message, innerException)
    {
    }
}
