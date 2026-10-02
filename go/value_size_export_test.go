package workhorse

// JSONBTextBytesForTest exposes the result measure to the external tests that compare it with
// PostgreSQL.
var JSONBTextBytesForTest = jsonbTextBytes

// HasUnstorableEscapeForTest exposes the jsonb escape scan to the external test that compares it
// with PostgreSQL.
var HasUnstorableEscapeForTest = hasUnstorableEscape
