"""The input fingerprint a checkpoint stores for one input (ADR 0098).

Each SDK must give the same digest for the same input, so the canonical form is RFC 8785.
``json.dumps(sort_keys=True)`` does not write that form: it sorts keys by code point, not by
UTF-16 code units, and ``repr(float)`` lays out exponents and integral values in another notation.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence

# I-JSON (RFC 7493) keeps integers to the range that an IEEE 754 double holds exactly.
_MAX_SAFE_INTEGER = 2**53 - 1
_REPR = re.compile(r"(\d+)(?:\.(\d+))?(?:e([+-]\d+))?")


def checkpoint_input_fingerprint(input: object) -> str:
    """Return the input fingerprint that a checkpoint stores for ``input``.

    The fingerprint is the SHA-256 digest of the canonical JSON form of the input (RFC 8785), as
    64 lowercase hexadecimal characters. The canonical form sorts the keys of each object by their
    UTF-16 code units, writes no whitespace, and writes each number in the ECMAScript form of its
    IEEE 754 double. Thus two inputs that differ only in key order have the same fingerprint, and
    every SDK gives the same digest for the same input.

    ``input`` must be JSON: a mapping with ``str`` keys, a list or tuple, a ``str``, an ``int`` of
    at most 2**53 - 1 in magnitude, a finite ``float``, ``True``, ``False``, or ``None``. A value of
    another type raises ``TypeError``. A non-finite number, a larger integer, or a string with a
    lone surrogate raises ``ValueError``.
    """
    return hashlib.sha256(_canonical(input).encode()).hexdigest()


def _canonical(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, int):
        if abs(value) > _MAX_SAFE_INTEGER:
            raise ValueError("Checkpoint input integers must be at most 2**53 - 1 in magnitude")
        return str(int(value))
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, Mapping):
        return _object(value)
    if isinstance(value, (list, tuple)):
        items: Sequence[object] = value
        return "[" + ",".join(_canonical(item) for item in items) + "]"
    raise TypeError(f"Checkpoint input contains {type(value).__name__}, which is not a JSON value")


def _object(value: Mapping[object, object]) -> str:
    members: list[tuple[bytes, str]] = []
    for key, item in value.items():
        if not isinstance(key, str):
            raise TypeError("Checkpoint input object keys must be strings")
        members.append((_utf16(key), f"{_string(key)}:{_canonical(item)}"))
    # Big-endian UTF-16 bytes compare in the order of their code units, which RFC 8785 requires.
    members.sort(key=lambda member: member[0])
    return "{" + ",".join(member for _, member in members) + "}"


def _number(value: float) -> str:
    """Write a double in the ECMAScript ``Number::toString`` form.

    ``repr`` gives the shortest digits that read back as the same double, and takes the even digit
    when two such forms are equally near, as ECMAScript does. Only the notation differs.
    """
    if not math.isfinite(value):
        raise ValueError("Checkpoint input must contain only finite numbers")
    if value == 0:
        return "0"
    match = _REPR.fullmatch(repr(abs(value)))
    if match is None:
        raise ValueError(f"Cannot write the number {value!r} in the ECMAScript form")
    whole, fraction, exponent = match.group(1), match.group(2) or "", match.group(3) or "0"
    digits = whole + fraction
    # The value is 0.<digits> * 10**point.
    point = len(whole) + int(exponent)
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    return ("-" if value < 0 else "") + _notation(digits, point)


def _notation(digits: str, point: int) -> str:
    count = len(digits)
    if count <= point <= 21:
        return digits + "0" * (point - count)
    if 0 < point <= 21:
        return f"{digits[:point]}.{digits[point:]}"
    if -6 < point <= 0:
        return f"0.{'0' * -point}{digits}"
    exponent = point - 1
    mantissa = digits if count == 1 else f"{digits[0]}.{digits[1:]}"
    return f"{mantissa}e{'-' if exponent < 0 else '+'}{abs(exponent)}"


def _string(value: str) -> str:
    # With ensure_ascii off, json escapes only the quote, the backslash, and the control
    # characters, with lowercase hexadecimal digits, as RFC 8785 requires.
    _utf16(value)
    return json.dumps(value, ensure_ascii=False)


def _utf16(value: str) -> bytes:
    try:
        return value.encode("utf-16-be")
    except UnicodeEncodeError as error:
        raise ValueError("Checkpoint input strings must not contain a lone surrogate") from error
