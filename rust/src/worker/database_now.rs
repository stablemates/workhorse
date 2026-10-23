//! The maintenance time that PostgreSQL chooses.

use std::error::Error as StdError;

use bytes::BytesMut;
use tokio_postgres::types::{to_sql_checked, Format, IsNull, ToSql, Type};

/// The `timestamptz` input `now`, which PostgreSQL resolves to the start time of the current
/// transaction.
///
/// Maintenance writes shared due times and retention cutoffs, so a fast or slow host clock must not
/// choose them. tokio-postgres sends other parameters in binary format, which can hold only a
/// fixed time. This value goes in text format, so the database clock applies.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DatabaseNow;

/// The text that PostgreSQL reads as the transaction start time.
pub(crate) const DATABASE_NOW: &str = "now";

impl ToSql for DatabaseNow {
    fn to_sql(
        &self,
        _ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn StdError + Sync + Send>> {
        out.extend_from_slice(DATABASE_NOW.as_bytes());
        Ok(IsNull::No)
    }

    fn accepts(ty: &Type) -> bool {
        *ty == Type::TIMESTAMPTZ
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }

    to_sql_checked!();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_the_text_now_and_not_a_local_time() {
        let mut out = BytesMut::new();
        let is_null = DatabaseNow.to_sql(&Type::TIMESTAMPTZ, &mut out).expect("encode");
        assert!(matches!(is_null, IsNull::No));
        assert_eq!(&out[..], b"now");
        assert!(matches!(DatabaseNow.encode_format(&Type::TIMESTAMPTZ), Format::Text));
        assert!(<DatabaseNow as ToSql>::accepts(&Type::TIMESTAMPTZ));
        assert!(!<DatabaseNow as ToSql>::accepts(&Type::TIMESTAMP));
    }
}
