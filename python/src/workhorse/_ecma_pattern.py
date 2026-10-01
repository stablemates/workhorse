"""Compile an ECMA-262 regular expression into a ``regex`` pattern with the same matches.

JSON Schema's ``pattern`` is an ECMA-262 regular expression. The source follows the ``u`` flag's
grammar, as other Workhorse validators compile it, and ``compile_ecma_pattern`` raises ValueError
for anything outside that grammar.

The ``regex`` module differs from ECMA-262 where this translation intervenes. ``^`` and ``$``
become absolute anchors, ``.`` excludes every line terminator, and ``\\d``, ``\\w``, ``\\s`` and
``\\b`` follow ECMA-262's character sets instead of Unicode's.

Modifier groups like ``(?i:`` and ``(?m-s:`` set their flags until their ``)``, and the translation
of ``^``, ``$`` and ``.`` follows the flags in effect. Under ``i``, each atom matches every
character whose simple case folding equals that of a character the atom matches, as ECMA-262
specifies. The translation writes those characters out from ``_ecma_case_folding``, because the
``regex`` module ignores case differently for properties and for ``i``, ``I``, ``\\u0130`` and
``\\u0131``.

The profile refuses backreferences, so ``\\1`` to ``\\9`` and ``\\k<name>`` raise ValueError. Two
differences remain. The ``regex`` module has no ``Changes_When_NFKC_Casefolded`` property, so the
compiler refuses it. Property names and members follow the module's Unicode version, which can lag
the one other validators read. Internal to the SDK.
"""

from __future__ import annotations

from collections.abc import Iterable
from functools import lru_cache
from typing import Literal

import regex

from ._ecma_case_folding import FOLD_CLASSES
from ._ecma_pattern_properties import BINARY_PROPERTIES, GENERAL_CATEGORIES, SCRIPTS

_SPACE = "\\t\\n\\x0b\\f\\r \\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
_WORD = "[A-Za-z0-9_]"
_LINE_TERMINATOR = "[\\n\\r\\u2028\\u2029]"
_DOT = "[^\\n\\r\\u2028\\u2029]"
_ANY = "[\\s\\S]"
_SYNTAX = "^$\\.*+?()[]{}|/"
_CONTROLS = {"f": 0x0C, "n": 0x0A, "r": 0x0D, "t": 0x09, "v": 0x0B}
_SETS = {
    "d": "[0-9]",
    "D": "[^0-9]",
    "w": _WORD,
    "W": "[^A-Za-z0-9_]",
    # Under i, ECMA-262 counts U+017F and U+212A as word characters, because they fold to s and k.
    "Wi": "[^A-Za-z0-9_\u017f\u212a]",
    "s": f"[{_SPACE}]",
    "S": f"[^{_SPACE}]",
}
_GROUP_NAME = regex.compile(r"[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*")
_PROPERTY = regex.compile(r"\{(?:(\w+)=)?(\w+)\}", regex.ASCII)
_BOUNDS = regex.compile(r"(\d+)(,(\d*))?\}", regex.ASCII)
_GROUP_PREFIX = regex.compile(r"\?(?::|=|!|<=|<!)")
_MODIFIERS = regex.compile(r"\?([a-zA-Z]*)(?:-([a-zA-Z]*))?:")

# Each character that shares its simple case folding with another, mapped to its class.
_FOLDS = {char: members for members in FOLD_CLASSES for char in members}
_FOLDED = "".join(FOLD_CLASSES)

_Last = Literal["none", "atom", "assertion", "quantifier"]


class BackreferenceError(ValueError):
    """Raised for a backreference, which the contract profile refuses."""


def compile_ecma_pattern(source: object) -> regex.Pattern[str]:
    """Return a ``regex`` pattern that matches what ECMA-262 matches for ``source``."""
    if not isinstance(source, str):
        raise ValueError("pattern must be a string")
    try:
        # Translation compiles class members under i, so it can raise regex.error too.
        return regex.compile(_Translator(source).translate(), regex.VERSION1)
    except regex.error as error:
        raise ValueError(f"pattern {source!r} does not compile: {error}") from error


class _Translator:
    def __init__(self, source: str) -> None:
        self._source = source
        self._at = 0
        self._out: list[str] = []
        # Each open group's kind and the flags outside it.
        self._groups: list[tuple[Literal["group", "assertion"], frozenset[str]]] = []
        # The i, m and s flags that modifier groups like (?i:...) set for the current position.
        self._flags: frozenset[str] = frozenset()
        # The enclosing disjunctions, each as its number and the index of its current alternative.
        self._alternatives: list[list[int]] = [[0, 0]]
        self._disjunctions = 1
        self._names: dict[str, list[tuple[tuple[int, int], ...]]] = {}
        self._last: _Last = "none"

    def translate(self) -> str:
        while not self._eos():
            char = self._take()
            if char == "\\":
                self._escape()
            elif char == "[":
                members, negated = self._character_class()
                atom = self._caseless(members)
                # regex can match any character for a negated class holding a set and its
                # complement, as in [^\\w\\W], so a negated class is a lookahead instead.
                self._emit(f"(?:(?!{atom}){_ANY})" if negated else atom, "atom")
            elif char == "(":
                self._open_group()
            elif char == ")":
                self._close_group()
            elif char == "|":
                self._alternatives[-1][1] += 1
                self._emit("|", "none")
            elif char == "^":
                multiline = "m" in self._flags
                self._emit(f"(?:\\A|(?<={_LINE_TERMINATOR}))" if multiline else "\\A", "assertion")
            elif char == "$":
                multiline = "m" in self._flags
                self._emit(f"(?:\\Z|(?={_LINE_TERMINATOR}))" if multiline else "\\Z", "assertion")
            elif char == ".":
                self._emit(self._caseless(_ANY if "s" in self._flags else _DOT), "atom")
            elif char in "*+?":
                self._quantify(char)
            elif char == "{":
                self._quantify(self._bounds())
            elif char in "}]":
                raise ValueError(f"lone {char}")
            else:
                self._emit(self._caseless(_literal(ord(char)), char), "atom")
        if self._groups:
            raise ValueError("unterminated group")
        return "".join(self._out)

    def _caseless(self, atom: str, char: str = "") -> str:
        """Match ``atom``, or the literal ``char`` it writes, under the i flag in effect."""
        if "i" not in self._flags:
            return atom
        if char:
            members = _FOLDS.get(char)
            return f"[{_class_body(members)}]" if members else atom
        extra = _fold(atom)
        return f"(?:{atom}|[{extra}])" if extra else atom

    def _emit(self, text: str, last: _Last) -> None:
        self._out.append(text)
        self._last = last

    def _quantify(self, text: str) -> None:
        if self._last != "atom":
            raise ValueError(f"nothing to repeat before {text}")
        if self._peek() == "?":
            text += self._take()
        self._emit(text, "quantifier")

    def _bounds(self) -> str:
        match = _BOUNDS.match(self._source, self._at)
        if match is None:
            raise ValueError("lone {")
        self._at = match.end()
        upper = match[3]
        if upper and int(upper) < int(match[1]):
            raise ValueError("numbers out of order in {} quantifier")
        return "{" + match[0]

    def _open_group(self) -> None:
        if self._source.startswith("?<", self._at) and self._source[self._at + 2 :][:1] not in "=!":
            self._at += 2
            self._declare(self._group_name())
            # The profile refuses backreferences, so a name has no reader and the group stays plain.
            self._push("group", "(")
            return
        modifiers = _MODIFIERS.match(self._source, self._at)
        if modifiers is not None and modifiers[0] != "?:":
            self._at = modifiers.end()
            self._modify(modifiers[1], modifiers[2] or "")
            return
        prefix = _GROUP_PREFIX.match(self._source, self._at)
        if prefix is None:
            if self._peek() == "?":
                raise ValueError(f"invalid group ({self._source[self._at : self._at + 2]}")
            self._push("group", "(")
            return
        self._at = prefix.end()
        self._push("group" if prefix[0] == "?:" else "assertion", "(" + prefix[0])

    def _modify(self, added: str, removed: str) -> None:
        """Open a modifier group like ``(?i-s:``, which sets flags until its ``)``."""
        letters = added + removed
        if not letters or len(set(letters)) != len(letters) or not set(letters) <= set("ims"):
            raise ValueError(f"invalid modifiers {added}-{removed}")
        self._push("group", "(?:")
        self._flags = frozenset((self._flags | set(added)) - set(removed))

    def _group_name(self) -> str:
        chars: list[str] = []
        while (char := self._take()) != ">":
            if char == "":
                raise ValueError("unterminated group name")
            if char == "\\":
                if self._take() != "u":
                    raise ValueError("invalid escape in a group name")
                char = chr(self._unicode_value())
            chars.append(char)
        name = "".join(chars)
        if _GROUP_NAME.fullmatch(name) is None:
            raise ValueError(f"invalid group name {name!r}")
        return name

    def _declare(self, name: str) -> None:
        """Record a group name, which two groups may share only in different alternatives."""
        path = tuple((number, index) for number, index in self._alternatives)
        for other in self._names.get(name, []):
            if not any(a[0] == b[0] and a[1] != b[1] for a, b in zip(path, other, strict=False)):
                raise ValueError(f"duplicate group name {name}")
        self._names.setdefault(name, []).append(path)

    def _push(self, kind: Literal["group", "assertion"], text: str) -> None:
        self._groups.append((kind, self._flags))
        self._alternatives.append([self._disjunctions, 0])
        self._disjunctions += 1
        self._emit(text, "none")

    def _close_group(self) -> None:
        if not self._groups:
            raise ValueError("lone )")
        self._alternatives.pop()
        kind, self._flags = self._groups.pop()
        self._emit(")", "atom" if kind == "group" else "assertion")

    def _escape(self) -> None:
        char = self._take()
        if char == "":
            raise ValueError("trailing backslash")
        if char in "bB":
            word = self._caseless(_WORD)
            if char == "b":
                boundary = f"(?:(?<={word})(?!{word})|(?<!{word})(?={word}))"
            else:
                boundary = f"(?:(?<={word})(?={word})|(?<!{word})(?!{word}))"
            self._emit(boundary, "assertion")
        elif char == "k" or "1" <= char <= "9":
            raise BackreferenceError(
                f"backreference \\{char} is outside the Workhorse contract profile"
            )
        else:
            atom = self._set_escape(char) or self._character_escape(char, _SYNTAX)
            self._emit(self._caseless(atom), "atom")

    def _set_escape(self, char: str) -> str | None:
        """A class like ``\\d``, or None for any other escape."""
        if char == "W" and "i" in self._flags:
            return _SETS["Wi"]
        if char in _SETS:
            return _SETS[char]
        if char not in "pP":
            return None
        escape = _PROPERTY.match(self._source, self._at)
        if escape is None:
            raise ValueError("invalid property escape")
        name = _property(escape[1], escape[2])
        if name is None:
            raise ValueError(f"unknown property {escape[0][1:-1]}")
        self._at = escape.end()
        return f"\\{char}{{{name}}}"

    def _character_escape(self, char: str, syntax: str) -> str:
        """A single character, written as the ``regex`` module reads it."""
        if char in _CONTROLS:
            return _code_point(_CONTROLS[char])
        if char in syntax:
            return _code_point(ord(char))
        if char == "0" and not _is_ascii_digit(self._peek()):
            return _code_point(0)
        if char == "c" and _is_ascii_letter(self._peek()):
            return _code_point(ord(self._take()) % 32)
        if char == "x":
            value = self._hex_digits(2)
            if value is not None:
                return _code_point(value)
        if char == "u":
            return _code_point(self._unicode_value())
        raise ValueError(f"invalid escape \\{char}")

    def _unicode_value(self) -> int:
        """The code point of a ``\\u`` escape, where a lone surrogate names that code unit."""
        braced = regex.match(r"\{([0-9A-Fa-f]+)\}", self._source[self._at :])
        if braced is not None:
            self._at += len(braced[0])
            value = int(braced[1], 16)
            if value > 0x10FFFF:
                raise ValueError("code point out of range")
            return value
        high = self._hex_digits(4)
        if high is None:
            raise ValueError("invalid unicode escape")
        low = regex.match(r"\\u([dD][c-fC-F][0-9A-Fa-f]{2})", self._source[self._at :])
        if 0xD800 <= high <= 0xDBFF and low is not None:
            self._at += 6
            return 0x10000 + ((high - 0xD800) << 10) + (int(low[1], 16) - 0xDC00)
        return high

    def _hex_digits(self, count: int) -> int | None:
        digits = self._source[self._at : self._at + count]
        if len(digits) != count or not all(digit in "0123456789abcdefABCDEF" for digit in digits):
            return None
        self._at += count
        return int(digits, 16)

    def _character_class(self) -> tuple[str, bool]:
        """The class's members as a positive class, and whether the class negates them."""
        negated = self._peek() == "^"
        if negated:
            self._take()
        if self._peek() == "]":
            self._take()
            return "(?!)", negated
        out = ["["]
        while True:
            if self._eos():
                raise ValueError("unterminated character class")
            char = self._take()
            if char == "]":
                break
            first, first_set = self._class_atom(char)
            following = self._source[self._at + 1 : self._at + 2]
            if self._peek() != "-" or following in ("", "]"):
                out.append(first)
                continue
            self._take()
            last, last_set = self._class_atom(self._take())
            if first_set or last_set:
                raise ValueError("character class escape in a range")
            out.append(f"{first}-{last}")
        out.append("]")
        return "".join(out), negated

    def _class_atom(self, char: str) -> tuple[str, bool]:
        """One class member and whether it is itself a set, like ``\\d``."""
        if char != "\\":
            return _literal(ord(char)), False
        char = self._take()
        if char == "":
            raise ValueError("trailing backslash")
        if char == "b":
            return _code_point(8), False
        found = self._set_escape(char)
        if found is not None:
            return found, True
        return self._character_escape(char, _SYNTAX + "-"), False

    def _peek(self) -> str:
        return self._source[self._at : self._at + 1]

    def _take(self) -> str:
        char = self._peek()
        self._at += len(char)
        return char

    def _eos(self) -> bool:
        return self._at >= len(self._source)


def _property(selector: str | None, name: str) -> str | None:
    """The ``regex`` spelling of a property ECMA-262 accepts, or None.

    A bare name is a general category or a binary property, and a selector limits the name to its
    own property.
    """
    if selector is None:
        if name in GENERAL_CATEGORIES:
            return f"gc={GENERAL_CATEGORIES[name]}"
        return BINARY_PROPERTIES.get(name)
    if selector in ("General_Category", "gc") and name in GENERAL_CATEGORIES:
        return f"gc={GENERAL_CATEGORIES[name]}"
    if selector in ("Script", "sc") and name in SCRIPTS:
        return f"sc={SCRIPTS[name]}"
    if selector in ("Script_Extensions", "scx") and name in SCRIPTS:
        return f"scx={SCRIPTS[name]}"
    return None


@lru_cache(maxsize=256)
def _fold(atom: str) -> str:
    """The class body of folded characters ECMA-262 adds to what ``atom`` matches under i.

    ECMA-262 matches a character when one of the set's members folds to the same character. A
    negated class negates that closure, so the caller folds its members before negating them.
    """
    inside = set(regex.findall(atom, _FOLDED, flags=regex.VERSION1))
    matched = {char for char in _FOLDED if any(member in inside for member in _FOLDS[char])}
    return _class_body(matched - inside)


def _class_body(chars: Iterable[str]) -> str:
    points = sorted(map(ord, chars))
    parts: list[str] = []
    start = 0
    while start < len(points):
        end = start
        while end + 1 < len(points) and points[end + 1] == points[end] + 1:
            end += 1
        first = _literal(points[start])
        parts.append(first if start == end else f"{first}-{_literal(points[end])}")
        start = end + 1
    return "".join(parts)


def _literal(value: int) -> str:
    # Any ASCII punctuation could be an operator in the regex module's VERSION1 syntax, including
    # inside a class, so every other ASCII character is written as a code point.
    char = chr(value)
    if not char.isascii() or char.isalnum():
        return char
    return _code_point(value)


def _code_point(value: int) -> str:
    return f"\\U{value:08x}"


def _is_ascii_letter(char: str) -> bool:
    return char.isascii() and char.isalpha()


def _is_ascii_digit(char: str) -> bool:
    return char.isascii() and char.isdigit()
