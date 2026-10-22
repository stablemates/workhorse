using System.Text.Json;
using Workhorse.Internal.Durable;
using Workhorse.Internal.Json;

namespace Workhorse;

/// <summary>The checkpoint input fingerprint of ADR 0098.</summary>
public static class Checkpoints
{
    /// <summary>
    /// The input fingerprint that a checkpoint stores for <paramref name="input"/>, encoded with the
    /// SDK default JSON options: the SHA-256 digest of the RFC 8785 canonical JSON of the input, as 64
    /// lowercase hexadecimal characters. The counterpart of Ruby's
    /// <c>Workhorse.checkpoint_input_fingerprint</c>.
    /// </summary>
    /// <remarks>
    /// Two inputs that differ only in key order have the same fingerprint, and every SDK gives the
    /// same digest for the same input. A <c>null</c> input is the JSON value <c>null</c>, which has a
    /// fingerprint. If the worker has its own JSON options, use
    /// <see cref="InputFingerprint{T}(T, JsonSerializerOptions)"/> with those options.
    /// </remarks>
    /// <param name="input">The checkpoint input.</param>
    /// <exception cref="ArgumentException">The input is not JSON, holds a lone surrogate or a
    /// non-finite number, or holds a number of more than 2^53 - 1 in magnitude.</exception>
    public static string InputFingerprint<T>(T input) => InputFingerprint(input, JsonCodec.Default);

    /// <summary>
    /// The input fingerprint that a checkpoint stores for <paramref name="input"/>, encoded with
    /// <paramref name="options"/>.
    /// </summary>
    /// <remarks>
    /// An option that changes the JSON text, such as a naming policy, changes the fingerprint. Give
    /// the options of the worker, so the fingerprint is the one that a checkpoint of that worker
    /// stores.
    /// </remarks>
    /// <param name="input">The checkpoint input.</param>
    /// <param name="options">The JSON options of the worker.</param>
    /// <exception cref="ArgumentNullException"><paramref name="options"/> is <c>null</c>.</exception>
    /// <exception cref="ArgumentException">The input is not JSON, holds a lone surrogate or a
    /// non-finite number, or holds a number of more than 2^53 - 1 in magnitude.</exception>
    public static string InputFingerprint<T>(T input, JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return InputFingerprint(input, new JsonCodec(options));
    }

    /// <summary>The fingerprint of <paramref name="input"/> as <paramref name="codec"/> encodes it.</summary>
    internal static string InputFingerprint<T>(T input, JsonCodec codec) =>
        CanonicalJson.Fingerprint(codec.Serialize(input, "checkpoint input"));
}
