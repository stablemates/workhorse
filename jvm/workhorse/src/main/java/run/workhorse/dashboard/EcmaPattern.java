package run.workhorse.dashboard;

import java.util.regex.Pattern;

/**
 * Compiles a {@code dashboard/v1} schema {@code pattern} for {@code java.util.regex} with ECMA-262
 * semantics (ADR 0103, "The ECMA-262 pattern policy"). Internal to the SDK; the narrow counterpart
 * of Ruby's {@code EcmaPattern}.
 *
 * <p>The translator accepts the subset that the {@code dashboard/v1} schemas use: literals, escaped
 * syntax characters, character classes and ranges, {@code \d}, {@code ^}, {@code $}, groups,
 * non-capturing groups, alternation, and quantifiers. Outside a character class it writes {@code ^}
 * as {@code \A} and {@code $} as {@code \z}, because {@code java.util.regex} lets {@code $} match
 * before a final line terminator and ECMA-262 does not. It refuses every other construct with
 * {@link IllegalArgumentException}, so a new construct in the contract fails a test before it
 * reaches a release.
 */
final class EcmaPattern {
  /** The ECMA-262 syntax characters, which an identity escape may name with the {@code u} flag. */
  private static final String SYNTAX = "^$\\.*+?()[]{}|/";

  private final String source;
  private final StringBuilder out = new StringBuilder();
  private int position;
  private int depth;

  private EcmaPattern(String source) {
    this.source = source;
  }

  /**
   * The compiled pattern. A caller matches it with {@code find}, because a JSON Schema pattern is
   * not anchored unless it says so.
   *
   * @throws IllegalArgumentException if the pattern uses a construct outside the subset
   */
  static Pattern compile(String source) {
    return Pattern.compile(translate(source));
  }

  /** The {@code java.util.regex} source for an ECMA-262 pattern in the subset. */
  static String translate(String source) {
    EcmaPattern translator = new EcmaPattern(source);
    translator.alternatives();
    return translator.out.toString();
  }

  private void alternatives() {
    boolean quantifiable = false;
    while (position < source.length()) {
      char next = source.charAt(position);
      switch (next) {
        case '^' -> {
          position++;
          out.append("\\A");
          quantifiable = false;
        }
        case '$' -> {
          position++;
          out.append("\\z");
          quantifiable = false;
        }
        case '|' -> {
          position++;
          out.append('|');
          quantifiable = false;
        }
        case '(' -> {
          group();
          quantifiable = true;
        }
        case ')' -> {
          if (depth == 0) {
            throw refuse("an unmatched )");
          }
          return;
        }
        case '[' -> {
          characterClass();
          quantifiable = true;
        }
        case '\\' -> {
          escape(false);
          quantifiable = true;
        }
        case '*', '+', '?', '{' -> {
          if (!quantifiable) {
            throw refuse("a quantifier without an atom");
          }
          quantifier();
          quantifiable = false;
        }
        case '.' -> throw refuse("the . wildcard");
        case ']', '}' -> throw refuse("a lone " + next);
        default -> {
          position++;
          literal(next);
          quantifiable = true;
        }
      }
    }
    if (depth != 0) {
      throw refuse("an unclosed group");
    }
  }

  private void group() {
    position++;
    if (source.startsWith("?:", position)) {
      position += 2;
      out.append("(?:");
    } else if (position < source.length() && source.charAt(position) == '?') {
      throw refuse("a group modifier, a lookaround, or a named group");
    } else {
      out.append('(');
    }
    depth++;
    alternatives();
    if (position >= source.length()) {
      throw refuse("an unclosed group");
    }
    position++;
    depth--;
    out.append(')');
  }

  private void quantifier() {
    char next = source.charAt(position++);
    if (next == '{') {
      int close = source.indexOf('}', position);
      String bounds = close < 0 ? "" : source.substring(position, close);
      if (!bounds.matches("[0-9]+(,[0-9]*)?")) {
        throw refuse("a malformed {} quantifier");
      }
      out.append('{').append(bounds).append('}');
      position = close + 1;
    } else {
      out.append(next);
    }
    if (position < source.length() && source.charAt(position) == '?') {
      position++;
      out.append('?');
    }
  }

  private void characterClass() {
    position++;
    out.append('[');
    if (position < source.length() && source.charAt(position) == '^') {
      position++;
      out.append('^');
    }
    if (position < source.length() && source.charAt(position) == ']') {
      throw refuse("an empty character class");
    }
    while (true) {
      if (position >= source.length()) {
        throw refuse("an unclosed character class");
      }
      if (source.charAt(position) == ']') {
        position++;
        out.append(']');
        return;
      }
      boolean set = classAtom();
      if (position + 1 < source.length()
          && source.charAt(position) == '-'
          && source.charAt(position + 1) != ']') {
        position++;
        out.append('-');
        // ECMA-262 with the u flag refuses a range whose endpoint is a set such as \d.
        if (classAtom() || set) {
          throw refuse("a range with a character set endpoint");
        }
      }
    }
  }

  /** Writes one class atom, and answers whether it is a set rather than one character. */
  private boolean classAtom() {
    char next = source.charAt(position);
    if (next == '\\') {
      boolean set = position + 1 < source.length() && source.charAt(position + 1) == 'd';
      escape(true);
      return set;
    }
    position++;
    // `[`, `&&`, and an unescaped `^` have a meaning of their own in a Java class.
    if (next == '[' || next == '&' || next == '^') {
      out.append('\\');
    }
    literal(next);
    return false;
  }

  private void escape(boolean inClass) {
    if (position + 1 >= source.length()) {
      throw refuse("a trailing backslash");
    }
    char next = source.charAt(position + 1);
    position += 2;
    if (next == 'd') {
      out.append("\\d");
    } else if (SYNTAX.indexOf(next) >= 0 || (inClass && next == '-')) {
      out.append('\\').append(next);
    } else {
      throw refuse("the escape \\" + next);
    }
  }

  private void literal(char character) {
    if (Character.isWhitespace(character) || Character.isISOControl(character)) {
      throw refuse("a whitespace or control character");
    }
    out.append(character);
  }

  private IllegalArgumentException refuse(String construct) {
    return new IllegalArgumentException(
        "dashboard/v1 pattern " + source + " uses " + construct + ", which the translator refuses");
  }
}
