// PORT STATUS
// source: packages/pglite/src/errors.ts
// baseline: e752dbe
// stage: implemented
// verification: adapter differential tests pending
// open issues: `queryOptions` carries callbacks in JS (unserializable); the
//              envelope ships only data-carrying fields.

use pglite_protocol::messages::ErrorNotice;
use crate::value::Value;

/// `PGliteError` = `DatabaseError` + `query`, `params`, `queryOptions`.
/// The reference mutates the DatabaseError instance; we carry the extras
/// structurally instead.
#[derive(Debug, Clone)]
pub struct PGliteError {
    pub error: ErrorNotice,
    pub query: Option<String>,
    pub params: Option<Vec<Value>>,
    // TODO(port): QueryOptions include callbacks (onNotice) and overrides;
    // attached here as presence/metadata only — full fidelity TBD at the
    // JS boundary where the original options object exists.
    pub query_options_present: bool,
}

impl std::fmt::Display for PGliteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.error)
    }
}

impl std::error::Error for PGliteError {}

pub fn make_pglite_error(
    e: ErrorNotice,
    query: String,
    params: Option<Vec<Value>>,
    options_present: bool,
) -> PGliteError {
    PGliteError {
        error: e,
        query: Some(query),
        params,
        query_options_present: options_present,
    }
}
