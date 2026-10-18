/**
 * The JDBC form of a statement. PgJDBC binds positional `?` parameters, so each `$n` becomes `?`,
 * and `parameters` lists the protocol parameter that each `?` binds, in order. A `$n` used twice
 * binds its value twice. PgJDBC reads a bare `?` as a parameter, so a `?` operator becomes `??`.
 * Literals, escape strings, quoted identifiers, nested comments, and dollar quotes stay as they
 * are, because PgJDBC skips them too.
 *
 * `uncast` lists the 1-based JDBC index of each `?` that no `::` cast follows. Only whitespace can
 * come between the `?` and its cast. The list is conservative: it also names a `?` in
 * `CAST(? AS type)` or a `?` with a comment before its cast. The JVM `Sql` runner binds text as an
 * untyped parameter. PostgreSQL then infers the type of each uncast `?` from its context alone.
 */
export function jdbcStatement(sql: string): {
  sql: string;
  parameters: number[];
  uncast: number[];
} {
  const parameters: number[] = [];
  const uncast: number[] = [];
  let output = "";
  let index = 0;
  const copyUntil = (end: number) => {
    output += sql.slice(index, end);
    index = end;
  };
  const unterminated = (what: string) =>
    new Error(`unterminated ${what} in ${JSON.stringify(sql)}`);
  while (index < sql.length) {
    const rest = sql.slice(index);
    // An unquoted identifier can hold `$` after its first character, as in `name$1`. PostgreSQL
    // reads every non-ASCII character as an identifier character.
    const identifier = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/.exec(rest);
    const placeholder = /^\$(\d+)/.exec(rest);
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (rest.startsWith("'")) {
      // `E'…'` takes backslash escapes. The `E` must start a token, not end an identifier.
      const escaped = /(?:^|[^A-Za-z0-9_$\u0080-\uffff])[eE]$/.test(output);
      const literal = (escaped ? /^'(?:[^'\\]|\\[\s\S]|'')*'/ : /^'(?:[^']|'')*'/).exec(rest);
      if (!literal) throw unterminated("string literal");
      copyUntil(index + literal[0].length);
    } else if (rest.startsWith('"')) {
      const quoted = /^"(?:[^"]|"")*"/.exec(rest);
      if (!quoted) throw unterminated("quoted identifier");
      copyUntil(index + quoted[0].length);
    } else if (rest.startsWith("--")) {
      const end = rest.search(/[\r\n]/);
      copyUntil(end < 0 ? sql.length : index + end);
    } else if (rest.startsWith("/*")) {
      // PostgreSQL nests block comments.
      let depth = 0;
      let end = index;
      do {
        const open = sql.indexOf("/*", end);
        const close = sql.indexOf("*/", end);
        if (close < 0) throw unterminated("block comment");
        if (open >= 0 && open < close) {
          depth += 1;
          end = open + 2;
        } else {
          depth -= 1;
          end = close + 2;
        }
      } while (depth > 0);
      copyUntil(end);
    } else if (identifier) {
      copyUntil(index + identifier[0].length);
    } else if (placeholder) {
      parameters.push(Number(placeholder[1]));
      output += "?";
      index += placeholder[0].length;
      if (!/^\s*::/.test(sql.slice(index))) uncast.push(parameters.length);
    } else if (dollar) {
      const close = sql.indexOf(dollar[0], index + dollar[0].length);
      if (close < 0) throw unterminated("dollar quote");
      copyUntil(close + dollar[0].length);
    } else if (rest.startsWith("?")) {
      output += "??";
      index += 1;
    } else {
      copyUntil(index + 1);
    }
  }
  return { sql: output, parameters, uncast };
}
