// PORT STATUS
// source: packages/pglite/src/types.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-core; adapter differential tests pending
// open issues: see TODO(port) markers — `new Date(x)`/JSON.parse remain host
//              materialization steps via the Value envelope.

//! Port of `types.ts` (itself based on postgres.js `types.js`, Unlicense).
//!
//! Type-handler tables are keyed like the reference: a single flat map where
//! both OIDs (numeric) and handler names (`'string'`, `'number'`, …) may
//! appear — user `ParserOptions`/`SerializerOptions` keys follow the same
//! convention (`{[pgType: number|string]: fn}`).

use crate::jstypeconv;
use crate::value::{DateRepr, Value};
use serde_json::json;
use std::collections::HashMap;
use std::fmt::Write as _;

// OID constants — verbatim from types.ts.
pub const BOOL: u32 = 16;
pub const BYTEA: u32 = 17;
pub const CHAR: u32 = 18;
pub const INT8: u32 = 20;
pub const INT2: u32 = 21;
pub const INT4: u32 = 23;
pub const REGPROC: u32 = 24;
pub const TEXT: u32 = 25;
pub const OID: u32 = 26;
pub const TID: u32 = 27;
pub const XID: u32 = 28;
pub const CID: u32 = 29;
pub const JSON: u32 = 114;
pub const XML: u32 = 142;
pub const PG_NODE_TREE: u32 = 194;
pub const SMGR: u32 = 210;
pub const PATH: u32 = 602;
pub const POLYGON: u32 = 604;
pub const CIDR: u32 = 650;
pub const FLOAT4: u32 = 700;
pub const FLOAT8: u32 = 701;
pub const ABSTIME: u32 = 702;
pub const RELTIME: u32 = 703;
pub const TINTERVAL: u32 = 704;
pub const CIRCLE: u32 = 718;
pub const MACADDR8: u32 = 774;
pub const MONEY: u32 = 790;
pub const MACADDR: u32 = 829;
pub const INET: u32 = 869;
pub const ACLITEM: u32 = 1033;
pub const BPCHAR: u32 = 1042;
pub const VARCHAR: u32 = 1043;
pub const DATE: u32 = 1082;
pub const TIME: u32 = 1083;
pub const TIMESTAMP: u32 = 1114;
pub const TIMESTAMPTZ: u32 = 1184;
pub const INTERVAL: u32 = 1186;
pub const TIMETZ: u32 = 1266;
pub const BIT: u32 = 1560;
pub const VARBIT: u32 = 1562;
pub const NUMERIC: u32 = 1700;
pub const REFCURSOR: u32 = 1790;
pub const REGPROCEDURE: u32 = 2202;
pub const REGOPER: u32 = 2203;
pub const REGOPERATOR: u32 = 2204;
pub const REGCLASS: u32 = 2205;
pub const REGTYPE: u32 = 2206;
pub const UUID: u32 = 2950;
pub const TXID_SNAPSHOT: u32 = 2970;
pub const PG_LSN: u32 = 3220;
pub const PG_NDISTINCT: u32 = 3361;
pub const PG_DEPENDENCIES: u32 = 3402;
pub const TSVECTOR: u32 = 3614;
pub const TSQUERY: u32 = 3615;
pub const GTSVECTOR: u32 = 3642;
pub const REGCONFIG: u32 = 3734;
pub const REGDICTIONARY: u32 = 3769;
pub const JSONB: u32 = 3802;
pub const REGNAMESPACE: u32 = 4089;
pub const REGROLE: u32 = 4096;

/// `Parser = (x: string, typeId?: number) => any`
pub type ParserFn =
    std::rc::Rc<dyn Fn(&str, u32, &dyn HostCallbacks) -> Result<Value, CodecError>>;
/// `Serializer = (x: any) => string`
pub type SerializerFn =
    std::rc::Rc<dyn Fn(&Value, &dyn HostCallbacks) -> Result<String, CodecError>>;

/// Where a handler is stored in the flat TS maps: numeric OID or name key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TypeKey {
    Oid(u32),
    Name(String),
}

impl TypeKey {
    pub fn oid(n: u32) -> TypeKey {
        TypeKey::Oid(n)
    }
}

/// Host-side hooks for behaviors that are JS-domain by design (guide §6-7).
/// The bridge implements these over host imports; tests use `NoHost`.
pub trait HostCallbacks {
    /// JSON.parse on the JS side is not needed — serde_json covers it — but
    /// custom user parsers/serializers registered from JS are invoked here.
    /// Returns None when no host handler is registered for the key.
    fn call_parser(&self, _id: u32, _x: &str, _type_id: u32) -> Option<Result<Value, String>> {
        None
    }
    fn call_serializer(&self, _id: u32, _x: &Value) -> Option<Result<String, String>> {
        None
    }
}

/// Default host callbacks — no JS functions registered.
pub struct NoHost;
impl HostCallbacks for NoHost {}

#[derive(Debug)]
pub enum CodecError {
    /// JS `new Error('Invalid input for boolean type')` etc.
    Message(String),
    /// A host (JS) handler threw.
    Host(String),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::Message(m) | CodecError::Host(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for CodecError {}

/// One entry of the `types` table.
pub struct TypeHandler {
    /// `to` — the serializer's own OID key.
    pub to: u32,
    /// `from` — OIDs this handler parses.
    pub from: &'static [u32],
    /// handler-name key ('string', 'number', …).
    pub name: &'static str,
    pub serialize: SerializerFn,
    pub parse: ParserFn,
}

fn serialize_string(x: &Value, _host: &dyn HostCallbacks) -> Result<String, CodecError> {
    match x {
        // `if (x instanceof Date) return x.toISOString()`
        Value::Date(DateRepr::FromString(s)) => Ok(s.clone()),
        Value::Date(DateRepr::FromMillis(ms)) => Ok(jstypeconv::epoch_millis_to_iso(*ms)),
        other => Ok(jstypeconv::js_to_string(other)),
    }
}

fn parse_string(x: &str, _type_id: u32, _host: &dyn HostCallbacks) -> Result<Value, CodecError> {
    Ok(Value::String(x.to_string()))
}

fn serialize_number(x: &Value, _host: &dyn HostCallbacks) -> Result<String, CodecError> {
    // `(x: number) => x.toString()`
    match x {
        Value::Number(n) => Ok(jstypeconv::number_to_string(*n)),
        other => Ok(jstypeconv::js_to_string(other)),
    }
}

fn parse_number(x: &str, _type_id: u32, _host: &dyn HostCallbacks) -> Result<Value, CodecError> {
    // `+x`
    Ok(Value::Number(jstypeconv::str_to_number(x)))
}

fn serialize_bigint(x: &Value, _host: &dyn HostCallbacks) -> Result<String, CodecError> {
    match x {
        Value::BigInt(s) => Ok(s.clone()),
        Value::Number(n) => Ok(jstypeconv::number_to_string(*n)),
        other => Ok(jstypeconv::js_to_string(other)),
    }
}

fn parse_bigint(x: &str, _type_id: u32, _host: &dyn HostCallbacks) -> Result<Value, CodecError> {
    // const n = BigInt(x); safe range → Number, else BigInt.
    // BigInt(x) accepts decimal (with optional -), throws on garbage → in the
    // reference that propagates as a SyntaxError. Mirror by NaN-free parse.
    match parse_bigint_text(x) {
        Some(i) => {
            if i >= MIN_SAFE_INTEGER && i <= MAX_SAFE_INTEGER {
                Ok(Value::Number(i as f64))
            } else {
                Ok(Value::BigInt(x.to_string()))
            }
        }
        // BigInt() also accepts hex/octal/binary strings.
        None => match parse_bigint_radix(x) {
            Some(dec) => Ok(Value::BigInt(dec)),
            None => Err(CodecError::Message(format!(
                "Cannot convert {} to a BigInt",
                x
            ))),
        },
    }
}

// 2^53 bounds (JS MIN/MAX_SAFE_INTEGER are exactly ±(2^53 - 1)).
const MIN_SAFE_INTEGER: i128 = -9_007_199_254_740_991;
const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;

fn parse_bigint_text(x: &str) -> Option<i128> {
    // BigInt() trims whitespace and accepts +/- decimal. `BigInt("")` is 0n.
    let t = x.trim();
    if t.is_empty() {
        return Some(0);
    }
    t.parse::<i128>().ok()
}

fn parse_bigint_radix(x: &str) -> Option<String> {
    let t = x.trim();
    let (neg, body) = if let Some(b) = t.strip_prefix('-') {
        (true, b)
    } else {
        (false, t.strip_prefix('+').unwrap_or(t))
    };
    let (radix, digits) = if let Some(d) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        (16, d)
    } else if let Some(d) = body.strip_prefix("0o").or_else(|| body.strip_prefix("0O")) {
        (8, d)
    } else if let Some(d) = body.strip_prefix("0b").or_else(|| body.strip_prefix("0B")) {
        (2, d)
    } else {
        return None;
    };
    let v = i128::from_str_radix(digits, radix).ok()?;
    Some(if neg { (-v).to_string() } else { v.to_string() })
}

fn serialize_json(x: &Value, _host: &dyn HostCallbacks) -> Result<String, CodecError> {
    // `typeof x === 'string' ? x : JSON.stringify(x, bigint→string)`
    match x {
        Value::String(s) => Ok(s.clone()),
        other => Ok(json_stringify_bigint(other)),
    }
}

/// JSON.stringify with the reference's `bigint → toString` replacer.
fn json_stringify_bigint(v: &Value) -> String {
    fn to_json(v: &Value) -> serde_json::Value {
        match v {
            Value::Null | Value::Undefined => serde_json::Value::Null,
            Value::Bool(b) => json!(b),
            Value::Number(n) => {
                if n.is_finite() {
                    json!(n)
                } else {
                    // JSON.stringify(Infinity/NaN) → null
                    serde_json::Value::Null
                }
            }
            Value::BigInt(s) => serde_json::Value::String(s.clone()),
            Value::String(s) => serde_json::Value::String(s.clone()),
            Value::Bytes(b) => {
                // Uint8Array → {"0":x,"1":y,…} object under JSON.stringify.
                let mut m = serde_json::Map::new();
                for (i, byte) in b.iter().enumerate() {
                    m.insert(i.to_string(), json!(byte));
                }
                serde_json::Value::Object(m)
            }
            Value::Date(_) => {
                // Date.prototype.toJSON → ISO string.
                match v {
                    Value::Date(DateRepr::FromString(s)) => json!(s),
                    Value::Date(DateRepr::FromMillis(ms)) => {
                        json!(jstypeconv::epoch_millis_to_iso(*ms))
                    }
                    _ => unreachable!(),
                }
            }
            Value::Json(j) => j.clone(),
            Value::Array(xs) => serde_json::Value::Array(xs.iter().map(to_json).collect()),
            Value::Object(pairs) => {
                let mut m = serde_json::Map::new();
                for (k, val) in pairs {
                    m.insert(k.clone(), to_json(val));
                }
                serde_json::Value::Object(m)
            }
        }
    }
    js_json_to_string(&to_json(v))
}

/// JSON.stringify of a `serde_json::Value` using ECMAScript number formatting
/// (`number_to_string`) — serde_json's default renders 1.0 as "1.0" while JS
/// emits "1". String/key escaping matches both emitters (\n \t \uXXXX …).
pub fn js_json_to_string(j: &serde_json::Value) -> String {
    let mut out = String::new();
    write_json(j, &mut out);
    out
}

fn write_json(j: &serde_json::Value, out: &mut String) {
    match j {
        serde_json::Value::Null => out.push_str("null"),
        serde_json::Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        serde_json::Value::Number(n) => {
            out.push_str(&jstypeconv::number_to_string(n.as_f64().unwrap_or(f64::NAN)))
        }
        serde_json::Value::String(s) => write_json_string(s, out),
        serde_json::Value::Array(xs) => {
            out.push('[');
            for (i, x) in xs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(x, out);
            }
            out.push(']');
        }
        serde_json::Value::Object(m) => {
            out.push('{');
            for (i, (k, v)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(k, out);
                out.push(':');
                write_json(v, out);
            }
            out.push('}');
        }
    }
}

fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Normalize every number in a parsed JSON doc to f64 — JS `JSON.parse`
/// produces only doubles, so i64/u64 precision must be lost the same way.
fn json_numbers_to_f64(j: serde_json::Value) -> serde_json::Value {
    match j {
        serde_json::Value::Number(n) => serde_json::Number::from_f64(
            n.as_f64().unwrap_or(f64::NAN),
        )
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null),
        serde_json::Value::Array(xs) => {
            serde_json::Value::Array(xs.into_iter().map(json_numbers_to_f64).collect())
        }
        serde_json::Value::Object(m) => serde_json::Value::Object(
            m.into_iter().map(|(k, v)| (k, json_numbers_to_f64(v))).collect(),
        ),
        other => other,
    }
}

fn parse_json(x: &str, _type_id: u32, _host: &dyn HostCallbacks) -> Result<Value, CodecError> {
    match serde_json::from_str::<serde_json::Value>(x) {
        Ok(j) => Ok(Value::Json(json_numbers_to_f64(j))),
        // TODO(port): JS `JSON.parse` error surface differs (SyntaxError with
        // position). Mapped to a message error; the exact message text is not
        // part of the public contract but the throw is.
        Err(e) => Err(CodecError::Message(format!("{}", e))),
    }
}

fn serialize_boolean(x: &Value, _host: &dyn HostCallbacks) -> Result<String, CodecError> {
    // Mirrors Postgres `boolin` acceptance per the source comment.
    match x {
        Value::Bool(b) => Ok(if *b { "t" } else { "f" }.to_string()),
        Value::Number(n) => {
            if *n == 1.0 {
                Ok("t".to_string())
            } else if *n == 0.0 {
                Ok("f".to_string())
            } else {
                Err(CodecError::Message("Invalid input for boolean type".into()))
            }
        }
        Value::String(s) => {
            let lower = s.trim().to_lowercase();
            if ["true", "t", "yes", "y", "on", "1"].contains(&lower.as_str()) {
                Ok("t".to_string())
            } else if ["false", "f", "no", "n", "off", "0"].contains(&lower.as_str()) {
                Ok("f".to_string())
            } else {
                Err(CodecError::Message("Invalid input for boolean type".into()))
            }
        }
        _ => Err(CodecError::Message("Invalid input for boolean type".into())),
    }
}

fn parse_boolean(x: &str, _type_id: u32, _host: &dyn HostCallbacks) -> Result<Value, CodecError> {
    Ok(Value::Bool(x == "t"))
}

fn serialize_date(x: &Value, _host: &dyn HostCallbacks) -> Result<String, CodecError> {
    match x {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(jstypeconv::epoch_millis_to_iso(*n)),
        Value::Date(DateRepr::FromString(s)) => Ok(s.clone()),
        Value::Date(DateRepr::FromMillis(ms)) => Ok(jstypeconv::epoch_millis_to_iso(*ms)),
        _ => Err(CodecError::Message("Invalid input for date type".into())),
    }
}

fn parse_date(x: &str, _type_id: u32, _host: &dyn HostCallbacks) -> Result<Value, CodecError> {
    // `new Date(x)` — materialized by the adapter so JS Date.parse applies.
    Ok(Value::Date(DateRepr::FromString(x.to_string())))
}

fn serialize_bytea(x: &Value, _host: &dyn HostCallbacks) -> Result<String, CodecError> {
    match x {
        Value::Bytes(b) => {
            let mut out = String::with_capacity(2 + b.len() * 2);
            out.push_str("\\x");
            for byte in b {
                let _ = write!(out, "{:02x}", byte);
            }
            Ok(out)
        }
        _ => Err(CodecError::Message("Invalid input for bytea type".into())),
    }
}

fn parse_bytea(x: &str, _type_id: u32, _host: &dyn HostCallbacks) -> Result<Value, CodecError> {
    let hex = &x[2.min(x.len())..];
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16).unwrap_or(0) as u8;
        let lo = if pair.len() > 1 {
            (pair[1] as char).to_digit(16).unwrap_or(0) as u8
        } else {
            0
        };
        out.push((hi << 4) | lo);
    }
    Ok(Value::Bytes(out))
}

/// The `types` handler table — built once.
pub fn default_handlers() -> Vec<TypeHandler> {
    vec![
        TypeHandler {
            name: "string",
            to: TEXT,
            from: &[TEXT, VARCHAR, BPCHAR],
            serialize: std::rc::Rc::new(serialize_string),
            parse: std::rc::Rc::new(parse_string),
        },
        TypeHandler {
            name: "number",
            to: 0,
            from: &[INT2, INT4, OID, FLOAT4, FLOAT8],
            serialize: std::rc::Rc::new(serialize_number),
            parse: std::rc::Rc::new(parse_number),
        },
        TypeHandler {
            name: "bigint",
            to: INT8,
            from: &[INT8],
            serialize: std::rc::Rc::new(serialize_bigint),
            parse: std::rc::Rc::new(parse_bigint),
        },
        TypeHandler {
            name: "json",
            to: JSON,
            from: &[JSON, JSONB],
            serialize: std::rc::Rc::new(serialize_json),
            parse: std::rc::Rc::new(parse_json),
        },
        TypeHandler {
            name: "boolean",
            to: BOOL,
            from: &[BOOL],
            serialize: std::rc::Rc::new(serialize_boolean),
            parse: std::rc::Rc::new(parse_boolean),
        },
        TypeHandler {
            name: "date",
            to: TIMESTAMPTZ,
            from: &[DATE, TIMESTAMP, TIMESTAMPTZ],
            serialize: std::rc::Rc::new(serialize_date),
            parse: std::rc::Rc::new(parse_date),
        },
        TypeHandler {
            name: "bytea",
            to: BYTEA,
            from: &[BYTEA],
            serialize: std::rc::Rc::new(serialize_bytea),
            parse: std::rc::Rc::new(parse_bytea),
        },
    ]
}

/// Flat maps mirroring `typeHandlers(types)` — name AND oid keys coexist.
pub struct HandlerMaps {
    pub parsers: HashMap<TypeKey, ParserFn>,
    pub serializers: HashMap<TypeKey, SerializerFn>,
}

pub fn default_handler_maps() -> HandlerMaps {
    let mut parsers = HashMap::new();
    let mut serializers = HashMap::new();
    for h in default_handlers() {
        serializers.insert(TypeKey::Oid(h.to), h.serialize.clone());
        serializers.insert(TypeKey::Name(h.name.to_string()), h.serialize.clone());
        parsers.insert(TypeKey::Name(h.name.to_string()), h.parse.clone());
        for f in h.from {
            parsers.insert(TypeKey::Oid(*f), h.parse.clone());
            serializers.insert(TypeKey::Oid(*f), h.serialize.clone());
        }
    }
    HandlerMaps { parsers, serializers }
}

/// `parseType(x, type, parsers?)` — `null` → `null`, handler → parsed, else
/// raw string. `parsers` here is the merged override map.
pub fn parse_type(
    x: Option<&str>,
    type_id: u32,
    parsers: &ParserOverrides,
    host: &dyn HostCallbacks,
) -> Result<Value, CodecError> {
    let Some(x) = x else {
        return Ok(Value::Null);
    };
    match parsers.get(&TypeKey::Oid(type_id)) {
        Some(ParserRef::Builtin(f)) => f(x, type_id, host),
        Some(ParserRef::Host(id)) => match host.call_parser(*id, x, type_id) {
            Some(Ok(v)) => Ok(v),
            Some(Err(e)) => Err(CodecError::Host(e)),
            None => Ok(Value::String(x.to_string())),
        },
        None => Ok(Value::String(x.to_string())),
    }
}

/// A parser is either a ported builtin or a JS callback (host id).
#[derive(Clone)]
pub enum ParserRef {
    Builtin(ParserFn),
    Host(u32),
}

#[derive(Clone)]
pub enum SerializerRef {
    Builtin(SerializerFn),
    Host(u32),
}

/// Merged parser/serializer maps: defaults + instance + per-query overrides.
#[derive(Default)]
pub struct ParserOverrides {
    map: HashMap<TypeKey, ParserRef>,
}

impl ParserOverrides {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build the effective map = defaults ∪ instance ∪ query overrides,
    /// in that precedence order (same key = last wins).
    pub fn merged(
        instance: &HashMap<TypeKey, ParserRef>,
        query: &HashMap<TypeKey, ParserRef>,
    ) -> ParserOverrides {
        let mut map: HashMap<TypeKey, ParserRef> = HashMap::new();
        let defaults = default_handler_maps();
        for (k, v) in defaults.parsers.iter() {
            map.insert(k.clone(), ParserRef::Builtin(v.clone()));
        }
        for (k, v) in instance {
            map.insert(k.clone(), v.clone());
        }
        for (k, v) in query {
            map.insert(k.clone(), v.clone());
        }
        ParserOverrides { map }
    }

    pub fn get(&self, key: &TypeKey) -> Option<&ParserRef> {
        self.map.get(key)
    }
}

/// Serializer lookup — same key space as parsers.
pub fn get_serializer(
    maps: &SerializerMaps,
    oid: u32,
) -> Option<SerializerRef> {
    maps.get(&TypeKey::Oid(oid)).cloned()
}

pub type SerializerMaps = HashMap<TypeKey, SerializerRef>;

/// Default serializer map (oid keys + name keys).
pub fn default_serializers() -> SerializerMaps {
    default_handler_maps()
        .serializers
        .into_iter()
        .map(|(k, v)| (k, SerializerRef::Builtin(v)))
        .collect()
}

pub fn default_parsers() -> HashMap<TypeKey, ParserRef> {
    default_handler_maps()
        .parsers
        .into_iter()
        .map(|(k, v)| (k, ParserRef::Builtin(v)))
        .collect()
}

fn array_escape(x: &str) -> String {
    x.replace('\\', "\\\\").replace('"', "\\\"")
}

/// `arraySerializer(xs, serializer, typarray)` — PG array literal.
pub fn array_serializer(
    xs: &Value,
    serializer: Option<SerializerRef>,
    typarray: u32,
    host: &dyn HostCallbacks,
) -> Result<String, CodecError> {
    let Value::Array(items) = xs else {
        // `if (Array.isArray(xs) === false) return xs` — passthrough.
        return Ok(jstypeconv::js_to_string(xs));
    };
    if items.is_empty() {
        return Ok("{}".to_string());
    }
    // Only _box (1020) uses ';'.
    let delimiter = if typarray == 1020 { ';' } else { ',' };
    let first = &items[0];
    if matches!(first, Value::Array(_)) {
        let mut out = String::from("{");
        let parts: Result<Vec<String>, _> = items
            .iter()
            .map(|x| array_serializer(x, serializer.clone(), typarray, host))
            .collect();
        out.push_str(&parts?.join(&delimiter.to_string()));
        out.push('}');
        Ok(out)
    } else {
        let mut out = String::from("{");
        for (i, x) in items.iter().enumerate() {
            if i > 0 {
                out.push(delimiter);
            }
            let x = if matches!(x, Value::Undefined) {
                &Value::Null
            } else {
                x
            };
            if matches!(x, Value::Null) {
                out.push_str("null");
            } else {
                let ser = match &serializer {
                    Some(SerializerRef::Builtin(f)) => f(x, host)?,
                    Some(SerializerRef::Host(id)) => match host.call_serializer(*id, x) {
                        Some(Ok(s)) => s,
                        Some(Err(e)) => return Err(CodecError::Host(e)),
                        None => jstypeconv::js_to_string(x),
                    },
                    None => jstypeconv::js_to_string(x),
                };
                out.push('"');
                out.push_str(&array_escape(&ser));
                out.push('"');
            }
        }
        out.push('}');
        Ok(out)
    }
}

/// `arrayParser(x, parser, typarray)` — PG array literal → Vec<Value>.
///
/// PORT NOTE: the reference scans the input in UTF-16 code units and keeps a
/// module-level mutable state (`arrayParserState`). This port uses an
/// explicit state struct (no shared mutation) and iterates over UTF-16 code
/// units to keep indexing/slicing behavior identical for non-ASCII input.
pub fn array_parser(
    x: &str,
    parser: Option<ParserRef>,
    typarray: u32,
    host: &dyn HostCallbacks,
) -> Result<Value, CodecError> {
    let units: Vec<u16> = x.encode_utf16().collect();
    let mut s = ArrayParserState::default();
    let xs = array_parser_loop(&mut s, &units, parser.as_ref(), typarray, host)?;
    // Reference returns `arrayParserLoop(...)[0]` — the first element of the
    // outer list, which is the top-level `{…}` recursion result.
    Ok(xs.into_iter().next().unwrap_or(Value::Null))
}

#[derive(Default)]
struct ArrayParserState {
    i: usize,
    /// Shared `s.char` — the inner recursion's last read persists here, which
    /// is observable: after a `{…}` recursion the loop bottom's `s.p = s.char`
    /// sees `}` (the char that broke the inner loop), not `{`.
    ch: u16,
    str_buf: Vec<u16>,
    quoted: bool,
    last: usize,
    p: Option<u16>,
}

fn apply_elem_parser(
    raw_utf16: &[u16],
    parser: Option<&ParserRef>,
    typarray: u32,
    host: &dyn HostCallbacks,
) -> Result<Value, CodecError> {
    let s = String::from_utf16_lossy(raw_utf16);
    match parser {
        Some(ParserRef::Builtin(f)) => f(&s, typarray, host),
        Some(ParserRef::Host(id)) => match host.call_parser(*id, &s, typarray) {
            Some(Ok(v)) => Ok(v),
            Some(Err(e)) => Err(CodecError::Host(e)),
            None => Ok(Value::String(s)),
        },
        None => Ok(Value::String(s)),
    }
}

fn array_parser_loop(
    s: &mut ArrayParserState,
    x: &[u16],
    parser: Option<&ParserRef>,
    typarray: u32,
    host: &dyn HostCallbacks,
) -> Result<Vec<Value>, CodecError> {
    let mut xs = Vec::new();
    let delimiter = if typarray == 1020 { b';' as u16 } else { b',' as u16 };
    while s.i < x.len() {
        s.ch = x[s.i];
        let ch = s.ch;
        let c = char::from_u32(ch as u32).unwrap_or('\u{FFFD}');
        if s.quoted {
            if c == '\\' {
                s.i += 1;
                if s.i < x.len() {
                    s.str_buf.push(x[s.i]);
                } else {
                    // `s.str += x[++s.i]` reads past the end → JS `undefined`
                    // → appends the literal text "undefined".
                    s.str_buf.extend("undefined".encode_utf16());
                }
            } else if c == '"' {
                xs.push(apply_elem_parser(&s.str_buf, parser, typarray, host)?);
                s.str_buf.clear();
                s.quoted = x.get(s.i + 1) == Some(&(b'"' as u16));
                s.last = s.i + 2;
            } else {
                s.str_buf.push(ch);
            }
        } else if c == '"' {
            s.quoted = true;
        } else if c == '{' {
            s.i += 1;
            s.last = s.i;
            let nested = array_parser_loop(s, x, parser, typarray, host)?;
            xs.push(Value::Array(nested));
            // Loop bottom still runs: `s.p = s.char` — but `s.char` was
            // overwritten by the inner loop and now holds `}`. This suppresses
            // the delimiter push for the `,` between nested rows.
            s.p = Some(s.ch);
            s.i += 1;
            continue;
        } else if c == '}' {
            if s.last < s.i {
                let el = &x[s.last..s.i];
                if el == [b'N' as u16, b'U' as u16, b'L' as u16, b'L' as u16] && !s.quoted {
                    xs.push(Value::Null);
                } else {
                    xs.push(apply_elem_parser(el, parser, typarray, host)?);
                }
            }
            s.quoted = false;
            s.last = s.i + 1;
            break;
        } else if ch == delimiter
            && s.p != Some(b'}' as u16)
            && s.p != Some(b'"' as u16)
        {
            let el = &x[s.last..s.i];
            if el == [b'N' as u16, b'U' as u16, b'L' as u16, b'L' as u16] && !s.quoted {
                xs.push(Value::Null);
            } else {
                xs.push(apply_elem_parser(el, parser, typarray, host)?);
            }
            s.last = s.i + 1;
        }
        s.p = Some(s.ch);
        s.i += 1;
    }
    if s.last < s.i {
        // Reference tail: `x.slice(s.last, s.i + 1)` — includes current char.
        let end = (s.i + 1).min(x.len());
        xs.push(apply_elem_parser(&x[s.last..end], parser, typarray, host)?);
    }
    Ok(xs)
}
