using System.Text.Json;
using Workhorse.Internal.Durable;
using Workhorse.Internal.Json;

namespace Workhorse;

/// <summary>The checkpoint input fingerprint of ADR 0098.</summary>
public static class Checkpoints
{
    /// <summary>
    /// The input fingerprint that a checkpoint stores for <paramref name="input"/>: the SHA-256 digest
    /// of the RFC 8785 canonical JSON of the input, as 64 lowercase hexadecimal characters. The
    /// counterpart of Ruby's <c>Workhorse.checkpoint_input_fingerprint</c>.
    /// </summary>
    /// <remarks>
    /// Two inputs that differ only in key order have the same fingerprint, and every SDK gives the
    /// same digest for the same input. A <c>null</c> input is the JSON value <c>null</c>, which has a
    /// fingerprint. <paramref name="options"/> encodes the input. An option that changes the JSON
    /// text, such as a naming policy, changes the fingerprint. Give the options of the worker, so the
    /// fingerprint is the one that a checkpoint of that worker stores.
    /// </remarks>
    /// <param name="input">The checkpoint input.</param>
    /// <param name="options">The JSON options, or <c>null</c> for the SDK default.</param>
    /// <exception cref="ArgumentException">The input is not JSON, holds a lone surrogate or a
    /// non-finite number, or holds a number of more than 2^53 - 1 in magnitude.</exception>
    public static string InputFingerprint<T>(T input, JsonSerializerOptions? options = null) =>
        InputFingerprint(input, options is null ? JsonCodec.Default : new JsonCodec(options));

    /// <summary>The fingerprint of <paramref name="input"/> as <paramref name="codec"/> encodes it.</summary>
    internal static string InputFingerprint<T>(T input, JsonCodec codec) =>
        CanonicalJson.Fingerprint(codec.Serialize(input, "checkpoint input"));
}
