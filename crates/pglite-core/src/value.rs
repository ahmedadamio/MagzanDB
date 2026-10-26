// PORT STATUS
// source: n/a — port-local domain type for the JS value boundary
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-core
// open issues: none
//
// `Value` models every JS value the PGlite API produces or accepts at the
// boundary. It is deliberately NOT `serde_json::Value` (guide §6: JSON cannot
// represent bigint/undefined/Date/Uint8Array faithfully). The `tag` module
// implements the tagged-JSON envelope shared with `adapter/src/values.js`.

use serde_json::{json, Value as Json};

/// Domain representation of a JavaScript value crossing the bridge.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    /// `undefined` — kept distinct from `Null` (guide §6).
    Undefined,
    Bool(bool),
    /// JS `number`. NaN/±Infinity included (they occur, e.g. `NaN` params).
    Number(f64),
    /// JS `bigint` — arbitrary precision, carried as its decimal string.
    BigInt(String),
    String(String),
    /// `Uint8Array` payload.
    Bytes(Vec<u8>),
    /// A JS `Date`. Carried as the source string/millis so the adapter builds
    /// `new Date(x)` with native JS parsing semantics.
    Date(DateRepr),
    /// A parsed JSON document (from `json`/`jsonb` fields).
    Json(Json),
    Array(Vec<Value>),
    /// Order-preserving object (JS objects enumerate in insertion order).
    Object(Vec<(String, Value)>),
}

/// How a `Date` should be materialized on the JS side.
#[derive(Debug, Clone, PartialEq)]
pub enum DateRepr {
    /// `new Date(str)` — preserves JS `Date.parse` behavior exactly.
    FromString(String),
    /// `new Date(millis)` — epoch milliseconds.
    FromMillis(f64),
}

pub mod tag {
    use super::*;

    /// Value → tagged `serde_json::Value` for the wire envelope.
    pub fn encode(v: &Value) -> Json {
        match v {
            Value::Null => Json::Null,
            Value::Undefined => json!({ "$undefined": true }),
            Value::Bool(b) => Json::Bool(*b),
            Value::Number(n) => {
                if n.is_finite() {
                    json!(n)
                } else {
                    json!({ "$num": special_number_tag(*n) })
                }
            }
            Value::BigInt(s) => json!({ "$bigint": s }),
            Value::String(s) => Json::String(s.clone()),
            Value::Bytes(b) => json!({ "$bytes": to_hex(b) }),
            Value::Date(DateRepr::FromString(s)) => json!({ "$datestr": s }),
            Value::Date(DateRepr::FromMillis(ms)) => json!({ "$datems": ms }),
            Value::Json(j) => j.clone(),
            Value::Array(xs) => Json::Array(xs.iter().map(encode).collect()),
            Value::Object(pairs) => {
                // Duplicate keys and ordering must survive — send pairs.
                let items: Vec<Json> = pairs
                    .iter()
                    .map(|(k, v)| json!({ "$k": k, "$v": encode(v) }))
                    .collect();
                json!({ "$objpairs": items })
            }
        }
    }

    /// tagged `serde_json::Value` → `Value` (params arriving from JS).
    pub fn decode(j: &Json) -> Value {
        match j {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => Value::String(s.clone()),
            Json::Array(items) => Value::Array(items.iter().map(decode).collect()),
            Json::Object(map) => {
                if map.get("$undefined").and_then(|v| v.as_bool()) == Some(true) {
                    Value::Undefined
                } else if let Some(s) = map.get("$bigint").and_then(|v| v.as_str()) {
                    Value::BigInt(s.to_string())
                } else if let Some(s) = map.get("$bytes").and_then(|v| v.as_str()) {
                    Value::Bytes(from_hex(s))
                } else if let Some(s) = map.get("$datestr").and_then(|v| v.as_str()) {
                    Value::Date(DateRepr::FromString(s.to_string()))
                } else if let Some(ms) = map.get("$datems").and_then(|v| v.as_f64()) {
                    Value::Date(DateRepr::FromMillis(ms))
                } else if let Some(s) = map.get("$num").and_then(|v| v.as_str()) {
                    Value::Number(parse_special_number_tag(s))
                } else if let Some(items) = map.get("$objpairs").and_then(|v| v.as_array()) {
                    Value::Object(
                        items
                            .iter()
                            .map(|it| {
                                (
                                    it["$k"].as_str().unwrap_or_default().to_string(),
                                    decode(&it["$v"]),
                                )
                            })
                            .collect(),
                    )
                } else {
                    Value::Object(
                        map.iter()
                            .map(|(k, v)| (k.clone(), decode(v)))
                            .collect(),
                    )
                }
            }
        }
    }

    fn special_number_tag(n: f64) -> &'static str {
        if n.is_nan() {
            "NaN"
        } else if n == f64::INFINITY {
            "Infinity"
        } else {
            "-Infinity"
        }
    }

    fn parse_special_number_tag(s: &str) -> f64 {
        match s {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => f64::NAN,
        }
    }

    pub fn to_hex(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            out.push_str(&format!("{:02x}", b));
        }
        out
    }

    pub fn from_hex(s: &str) -> Vec<u8> {
        let s = s.as_bytes();
        let mut out = Vec::with_capacity(s.len() / 2);
        for pair in s.chunks(2) {
            let hi = (pair[0] as char).to_digit(16).unwrap_or(0) as u8;
            let lo = if pair.len() > 1 {
                (pair[1] as char).to_digit(16).unwrap_or(0) as u8
            } else {
                0
            };
            out.push((hi << 4) | lo);
        }
        out
    }
}
