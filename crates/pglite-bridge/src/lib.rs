// PORT STATUS
// source: n/a — wasm-bindgen boundary between the JS adapter and the Rust core
// baseline: e752dbe
// stage: in-progress
// verification: wasm-pack build; adapter integration tests pending
// open issues:
// - messages cross as JSON descriptors, not real BackendMessage class
//   instances — the adapter rehydrates class identity where the public API
//   needs it (TODO(port)).
// - JS exceptions from host callbacks are stringified; structured error
//   propagation is adapter-side.
//
// Boundary contract (adapter/src/values.js implements the JS half):
// - Values cross as tagged-JSON strings (see pglite-core::value::tag).
// - Transport: a JS function `execRawSync(Uint8Array) -> Uint8Array`,
//   registered via `set_transport`. It drives the Emscripten module's
//   `_PostgresMainLoopOnce` and returns response bytes.
// - Host callbacks: `callParser(id, text, oid) -> taggedJson|undefined`,
//   `callSerializer(id, taggedJson) -> string|undefined`, for JS-registered
//   custom type handlers.
// - Errors cross as thrown JS objects `{__pglite: kind, ...fields}`; the
//   adapter rehydrates DatabaseError/PGliteError instances.

use js_sys::{Function, Uint8Array};
use pglite_core::results::{Results, RowMode};
use pglite_core::session::{
    ExecProtocolOptions, QueryOptions, Session, SessionError, SessionEvents, Transport,
};
use pglite_core::types::HostCallbacks;
use pglite_core::value::{tag, Value};
use pglite_protocol::messages::{BackendMessage, ErrorNotice};
use serde_json::{json, Value as Json};
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// JS → Rust traits
// ---------------------------------------------------------------------------

struct JsTransport {
    f: Function,
}

impl Transport for JsTransport {
    fn exec_raw(&mut self, message: &[u8]) -> Result<Vec<u8>, String> {
        let arg = Uint8Array::from(message);
        match self.f.call1(&JsValue::NULL, &arg) {
            Ok(v) => {
                if v.is_undefined() || v.is_null() {
                    return Ok(Vec::new());
                }
                let arr = Uint8Array::new(&v);
                Ok(arr.to_vec())
            }
            Err(e) => Err(js_error_string(&e)),
        }
    }
}

struct JsHost<'a> {
    call_parser: Option<&'a Function>,
    call_serializer: Option<&'a Function>,
}

impl HostCallbacks for JsHost<'_> {
    fn call_parser(
        &self,
        id: u32,
        text: &str,
        oid: u32,
    ) -> Option<Result<Value, String>> {
        let f = self.call_parser?;
        let res = f.call3(
            &JsValue::NULL,
            &JsValue::from(id),
            &JsValue::from(text),
            &JsValue::from(oid),
        );
        match res {
            Ok(v) if v.is_undefined() || v.is_null() => None,
            Ok(v) => Some(
                v.as_string()
                    .ok_or_else(|| "callParser must return a tagged JSON string".to_string())
                    .and_then(|s| decode_tagged_str(&s)),
            ),
            Err(e) => Some(Err(js_error_string(&e))),
        }
    }

    fn call_serializer(&self, id: u32, value: &Value) -> Option<Result<String, String>> {
        let f = self.call_serializer?;
        let tagged = serde_json::to_string(&tag::encode(value))
            .unwrap_or_else(|_| "null".to_string());
        let res = f.call2(&JsValue::NULL, &JsValue::from(id), &JsValue::from(tagged));
        match res {
            Ok(v) if v.is_undefined() || v.is_null() => None,
            Ok(v) => Some(
                v.as_string()
                    .ok_or_else(|| "callSerializer must return a string".to_string()),
            ),
            Err(e) => Some(Err(js_error_string(&e))),
        }
    }
}

fn decode_tagged_str(s: &str) -> Result<Value, String> {
    serde_json::from_str::<Json>(s)
        .map(|j| tag::decode(&j))
        .map_err(|e| e.to_string())
}

fn js_error_string(e: &JsValue) -> String {
    e.as_string()
        .or_else(|| {
            js_sys::JSON::stringify(e)
                .ok()
                .and_then(|s| s.as_string())
        })
        .unwrap_or_else(|| "unknown js error".to_string())
}

// ---------------------------------------------------------------------------
// JSON envelopes out
// ---------------------------------------------------------------------------

fn results_json(r: &Results) -> Json {
    json!({
        "rows": r.rows.iter().map(|row| row.iter().map(tag::encode).collect::<Vec<_>>()).collect::<Vec<_>>(),
        "affectedRows": r.affected_rows,
        "command": r.command,
        "rowCount": r.row_count,
        "fields": r.fields.iter().map(|f| json!({
            "name": f.name,
            "dataTypeID": f.data_type_id,
        })).collect::<Vec<_>>(),
        "hasBlob": r.has_blob,
    })
}

fn error_notice_json(e: &ErrorNotice) -> Json {
    json!({
        "message": e.message,
        "severity": e.severity,
        "code": e.code,
        "detail": e.detail,
        "hint": e.hint,
        "position": e.position,
        "internalPosition": e.internal_position,
        "internalQuery": e.internal_query,
        "where": e.where_,
        "schema": e.schema,
        "table": e.table,
        "column": e.column,
        "dataType": e.data_type,
        "constraint": e.constraint,
        "file": e.file,
        "line": e.line,
        "routine": e.routine,
        "length": e.length,
    })
}

fn events_json(ev: &SessionEvents) -> Json {
    json!({
        "notices": ev.notices.iter().map(error_notice_json).collect::<Vec<_>>(),
        "notifications": ev.notifications.iter().map(|(pid, ch, pl)| json!({
            "processId": pid, "channel": ch, "payload": pl,
        })).collect::<Vec<_>>(),
    })
}

fn message_json(m: &BackendMessage) -> Json {
    // JSON descriptor carrying every public field of the reference message
    // classes; `name` is the JS `msg.name` discriminant.
    let mut o = serde_json::Map::new();
    o.insert("name".into(), json!(m.name().as_str()));
    match m {
        BackendMessage::DataRow { fields, length } => {
            o.insert("length".into(), json!(length));
            o.insert(
                "fields".into(),
                json!(fields.iter().map(|f| f.clone()).collect::<Vec<_>>()),
            );
        }
        BackendMessage::RowDescription { fields, length } => {
            o.insert("length".into(), json!(length));
            o.insert(
                "fields".into(),
                fields
                    .iter()
                    .map(|f| {
                        json!({
                            "name": f.name,
                            "tableID": f.table_id,
                            "columnID": f.column_id,
                            "dataTypeID": f.data_type_id,
                            "dataTypeSize": f.data_type_size,
                            "dataTypeModifier": f.data_type_modifier,
                            "format": match f.format {
                                pglite_protocol::Mode::Text => "text",
                                pglite_protocol::Mode::Binary => "binary",
                            },
                        })
                    })
                    .collect::<Vec<_>>()
                    .into(),
            );
        }
        BackendMessage::ParameterDescription {
            data_type_ids,
            length,
        } => {
            o.insert("length".into(), json!(length));
            o.insert("dataTypeIDs".into(), json!(data_type_ids));
        }
        BackendMessage::CommandComplete { text, length } => {
            o.insert("length".into(), json!(length));
            o.insert("text".into(), json!(text));
        }
        BackendMessage::Notification {
            process_id,
            channel,
            payload,
            length,
        } => {
            o.insert("length".into(), json!(length));
            o.insert("processId".into(), json!(process_id));
            o.insert("channel".into(), json!(channel));
            o.insert("payload".into(), json!(payload));
        }
        BackendMessage::ReadyForQuery { status, length } => {
            o.insert("length".into(), json!(length));
            o.insert("status".into(), json!(status));
        }
        BackendMessage::ParameterStatus {
            parameter_name,
            parameter_value,
            length,
        } => {
            o.insert("length".into(), json!(length));
            o.insert("parameterName".into(), json!(parameter_name));
            o.insert("parameterValue".into(), json!(parameter_value));
        }
        BackendMessage::BackendKeyData {
            process_id,
            secret_key,
            length,
        } => {
            o.insert("length".into(), json!(length));
            o.insert("processID".into(), json!(process_id));
            o.insert("secretKey".into(), json!(secret_key));
        }
        BackendMessage::Error(e) => {
            // Reference ErrorResponse flattens NoticeOrError props onto the
            // message object itself (pg consumers read m.severity/.code/...).
            if let Json::Object(props) = error_notice_json(e) {
                for (k, v) in props {
                    o.insert(k, v);
                }
            }
        }
        BackendMessage::Notice(n) => {
            if let Json::Object(props) = error_notice_json(n) {
                for (k, v) in props {
                    o.insert(k, v);
                }
            }
        }
        BackendMessage::CopyData { chunk, length } => {
            o.insert("length".into(), json!(length));
            o.insert("chunk".into(), json!(tag::to_hex(chunk)));
        }
        BackendMessage::CopyInResponse(r) | BackendMessage::CopyOutResponse(r) => {
            o.insert("length".into(), json!(r.length));
            o.insert("binary".into(), json!(r.binary));
            o.insert("columnTypes".into(), json!(r.column_types));
        }
        other => {
            let _ = other;
        }
    }
    Json::Object(o)
}

/// SessionError → thrown JS object `{__pglite: kind, events, ...}`.
fn session_error_js(e: &SessionError, events: &SessionEvents) -> JsValue {
    let mut payload = match e {
        SessionError::Database(pe) => json!({
            "__pglite": "pgliteError",
            "fields": error_notice_json(&pe.error),
            "query": pe.query,
            "params": pe.params.as_ref().map(|ps| ps.iter().map(tag::encode).collect::<Vec<_>>()),
        }),
        SessionError::DatabaseBare(dbe) => json!({
            "__pglite": "databaseError",
            "fields": error_notice_json(dbe),
        }),
        SessionError::Codec(c) => json!({
            "__pglite": "codec",
            "message": c.to_string(),
        }),
        SessionError::Transport(t) => json!({
            "__pglite": "transport",
            "message": t,
        }),
        SessionError::Parse(p) => json!({
            "__pglite": "parse",
            "message": p,
        }),
    };
    payload["events"] = events_json(events);
    js_sys::JSON::parse(&payload.to_string()).unwrap_or_else(|_| JsValue::from_str("pglite error"))
}

fn parse_options(j: &Json) -> Result<QueryOptions, String> {
    let mut opts = QueryOptions::default();
    if let Some(rm) = j.get("rowMode").and_then(|v| v.as_str()) {
        opts.row_mode = match rm {
            "array" => RowMode::Array,
            _ => RowMode::Object,
        };
    }
    if let Some(pts) = j.get("paramTypes").and_then(|v| v.as_array()) {
        opts.param_types = Some(
            pts.iter()
                .filter_map(|v| v.as_u64().map(|n| n as u32))
                .collect(),
        );
    }
    // Custom parsers/serializers by key — registered host callbacks by id.
    if let Some(parsers) = j.get("parsers").and_then(|v| v.as_object()) {
        for (k, v) in parsers {
            if let Some(id) = v.as_u64() {
                if let Some(key) = type_key(k) {
                    opts.parsers
                        .insert(key, pglite_core::types::ParserRef::Host(id as u32));
                }
            }
        }
    }
    if let Some(sers) = j.get("serializers").and_then(|v| v.as_object()) {
        for (k, v) in sers {
            if let Some(id) = v.as_u64() {
                if let Some(key) = type_key(k) {
                    opts.serializers.insert(
                        key,
                        pglite_core::types::SerializerRef::Host(id as u32),
                    );
                }
            }
        }
    }
    opts.has_on_notice = j.get("onNotice").is_some();
    opts.has_blob = j.get("blob").is_some();
    Ok(opts)
}

fn type_key(k: &str) -> Option<pglite_core::types::TypeKey> {
    if let Ok(oid) = k.parse::<u32>() {
        Some(pglite_core::types::TypeKey::Oid(oid))
    } else if !k.is_empty() {
        Some(pglite_core::types::TypeKey::Name(k.to_string()))
    } else {
        None
    }
}

fn decode_params(s: &str) -> Result<Vec<Value>, String> {
    let j: Json = serde_json::from_str(s).map_err(|e| e.to_string())?;
    match j {
        Json::Array(items) => Ok(items.iter().map(tag::decode).collect()),
        _ => Err("params must be a tagged JSON array".to_string()),
    }
}

fn parse_json_arg(s: &str) -> Json {
    serde_json::from_str(s).unwrap_or(Json::Object(serde_json::Map::new()))
}

// ---------------------------------------------------------------------------
// Exported session
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct BridgeSession {
    session: Session,
    transport: Option<Function>,
    call_parser: Option<Function>,
    call_serializer: Option<Function>,
}

#[wasm_bindgen]
impl BridgeSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> BridgeSession {
        BridgeSession {
            session: Session::new(),
            transport: None,
            call_parser: None,
            call_serializer: None,
        }
    }

    /// Register `execRawSync(Uint8Array) -> Uint8Array`.
    pub fn set_transport(&mut self, f: Function) {
        self.transport = Some(f);
    }

    /// Register host codec callbacks (or pass undefined to clear).
    pub fn set_host_callbacks(
        &mut self,
        call_parser: Option<Function>,
        call_serializer: Option<Function>,
    ) {
        self.call_parser = call_parser;
        self.call_serializer = call_serializer;
    }

    pub fn set_in_transaction(&mut self, v: bool) {
        self.session.in_transaction = v;
    }

    /// Merge host-registered parsers/serializers into the instance maps
    /// (`{typeKey: callbackId}`). Called at construction for
    /// `options.parsers`/`options.serializers`.
    pub fn register_codecs(&mut self, parsers_json: &str, serializers_json: &str) {
        if let Json::Object(m) = parse_json_arg(parsers_json) {
            for (k, v) in m {
                if let (Some(key), Some(id)) = (type_key(&k), v.as_u64()) {
                    self.session
                        .parsers_inst
                        .insert(key, pglite_core::types::ParserRef::Host(id as u32));
                }
            }
        }
        if let Json::Object(m) = parse_json_arg(serializers_json) {
            for (k, v) in m {
                if let (Some(key), Some(id)) = (type_key(&k), v.as_u64()) {
                    self.session.serializers.insert(
                        key,
                        pglite_core::types::SerializerRef::Host(id as u32),
                    );
                }
            }
        }
    }

    fn with_parts<R>(
        &mut self,
        f: impl FnOnce(&mut Session, &mut JsTransport, &JsHost) -> Result<R, SessionError>,
    ) -> Result<(R, SessionEvents), JsValue> {
        let tf = self
            .transport
            .as_ref()
            .ok_or_else(|| JsValue::from_str("pglite: transport not registered"))?
            .clone();
        let cp = self.call_parser.clone();
        let cs = self.call_serializer.clone();
        let mut transport = JsTransport { f: tf };
        let host = JsHost {
            call_parser: cp.as_ref(),
            call_serializer: cs.as_ref(),
        };
        let res = f(&mut self.session, &mut transport, &host);
        // Drain unconditionally — events must surface even on the error path.
        let events = self.session.drain_events();
        match res {
            Ok(r) => Ok((r, events)),
            Err(e) => Err(session_error_js(&e, &events)),
        }
    }

    /// `query` — extended protocol. `params`/`options` are JSON strings
    /// (params tagged). Returns a JSON string.
    pub fn query(
        &mut self,
        query: &str,
        params_tagged: &str,
        options_json: &str,
    ) -> Result<String, JsValue> {
        let params = decode_params(params_tagged).map_err(|e| JsValue::from_str(&e))?;
        let options = parse_options(&parse_json_arg(options_json)).map_err(|e| JsValue::from_str(&e))?;
        let (out, extra_events) = self.with_parts(|s, t, h| {
            s.run_query(t, query, params, &options, h)
        })?;
        Ok(json!({
            "result": results_json(&out.result),
            "events": events_json(&merge_events(out.events, extra_events)),
        })
        .to_string())
    }

    /// `exec` — simple protocol, multi-statement.
    pub fn exec(&mut self, query: &str, options_json: &str) -> Result<String, JsValue> {
        let options = parse_options(&parse_json_arg(options_json)).map_err(|e| JsValue::from_str(&e))?;
        let (out, extra_events) =
            self.with_parts(|s, t, h| s.run_exec(t, query, &options, h))?;
        Ok(json!({
            "results": out.results.iter().map(results_json).collect::<Vec<_>>(),
            "events": events_json(&merge_events(out.events, extra_events)),
        })
        .to_string())
    }

    /// `describeQuery`.
    pub fn describe_query(
        &mut self,
        query: &str,
        options_json: &str,
    ) -> Result<String, JsValue> {
        let options = parse_options(&parse_json_arg(options_json)).map_err(|e| JsValue::from_str(&e))?;
        let (out, extra_events) =
            self.with_parts(|s, t, _h| s.describe_query(t, query, &options))?;
        Ok(json!({
            "result": {
                "queryParams": out.result.query_params.iter().map(|p| json!({
                    "dataTypeID": p.data_type_id,
                    "hasSerializer": p.has_serializer,
                })).collect::<Vec<_>>(),
                "resultFields": out.result.result_fields.iter().map(|f| json!({
                    "name": f.name,
                    "dataTypeID": f.data_type_id,
                    "hasParser": f.has_parser,
                })).collect::<Vec<_>>(),
            },
            "events": events_json(&merge_events(out.events, extra_events)),
        })
        .to_string())
    }

    /// `execProtocol` — raw passthrough with parsing, error latching and
    /// event collection in Rust. Returns `{data: base64? -> Uint8Array,
    /// messages: [..], events}`; we return data via a wrapper object JSON
    /// plus a byte array to keep ABI simple.
    pub fn exec_protocol(
        &mut self,
        message: &[u8],
        options_json: &str,
    ) -> Result<JsValue, JsValue> {
        let j = parse_json_arg(options_json);
        let opts = ExecProtocolOptions {
            sync_to_fs: j
                .get("syncToFs")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            throw_on_error: j
                .get("throwOnError")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            has_on_notice: j.get("onNotice").is_some(),
        };
        let (out, extra_events) =
            self.with_parts(|s, t, _h| s.exec_protocol(t, message, opts))?;
        let events = merge_events(
            SessionEvents {
                notices: out.notices,
                notifications: out.notifications,
            },
            extra_events,
        );
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("data"),
            &Uint8Array::from(out.data.as_slice()),
        )?;
        let msgs = js_sys::JSON::parse(
            &Json::Array(out.messages.iter().map(message_json).collect()).to_string(),
        )?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("messages"), &msgs)?;
        let ev = js_sys::JSON::parse(&events_json(&events).to_string())?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("events"), &ev)?;
        Ok(obj.into())
    }

    /// `execProtocolStream` — messages + events only.
    pub fn exec_protocol_stream(
        &mut self,
        message: &[u8],
        options_json: &str,
    ) -> Result<String, JsValue> {
        let j = parse_json_arg(options_json);
        let opts = ExecProtocolOptions {
            sync_to_fs: j
                .get("syncToFs")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            throw_on_error: j
                .get("throwOnError")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            has_on_notice: j.get("onNotice").is_some(),
        };
        let (out, extra_events) =
            self.with_parts(|s, t, _h| s.exec_protocol_stream(t, message, opts))?;
        let events = merge_events(
            SessionEvents {
                notices: out.notices,
                notifications: out.notifications,
            },
            extra_events,
        );
        Ok(json!({
            "messages": out.messages.iter().map(message_json).collect::<Vec<_>>(),
            "events": events_json(&events),
        })
        .to_string())
    }

    /// `query(strings, ...values)` templating — values arrive as a JSON array
    /// of template markers `{"$part": s}` / `{"$cont": {...}}` / tagged values.
    /// Returns `{query, params}` (params tagged-encoded JSON).
    pub fn query_template(
        &mut self,
        strings_json: &str,
        raw_json: &str,
        values_json: &str,
    ) -> Result<String, JsValue> {
        let strings: Vec<String> = serde_json::from_str(strings_json)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let raw: Vec<String> = serde_json::from_str(raw_json)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let values_j: Json = serde_json::from_str(values_json)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let items = match values_j {
            Json::Array(items) => items,
            _ => return Err(JsValue::from_str("values must be an array")),
        };
        let values: Vec<pglite_core::templating::TemplateValue> =
            items.iter().map(decode_template_value).collect();
        let out = pglite_core::templating::query(&strings, &raw, values);
        Ok(json!({
            "query": out.query,
            "params": out.params.iter().map(tag::encode).collect::<Vec<_>>(),
        })
        .to_string())
    }

    /// `_initArrayTypes` — discovers array OIDs via an internal query.
    pub fn init_array_types(&mut self, force: bool) -> Result<String, JsValue> {
        let ((), events) =
            self.with_parts(|s, t, h| s.init_array_types(t, h, force))?;
        Ok(events_json(&events).to_string())
    }

    /// Session codec keys — backs `db.serializers`/`db.parsers` enumeration.
    /// Returns `{parsers: [{oid}|{name}], serializers: [...]}`.
    pub fn codec_key_list(&self) -> String {
        use pglite_core::types::TypeKey;
        let key_of = |k: &TypeKey| -> Json {
            match k {
                TypeKey::Oid(n) => json!({"oid": n}),
                TypeKey::Name(s) => json!({"name": s}),
            }
        };
        json!({
            "parsers": self.session.parser_keys().iter().map(key_of).collect::<Vec<_>>(),
            "serializers": self.session.serializer_keys().iter().map(key_of).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// `serializers[oid](x)` against the session map (includes array types +
    /// instance customizations). `tagged` is a tagged-JSON value.
    pub fn serialize_value(&self, type_id: u32, tagged: &str) -> Result<String, JsValue> {
        let j: Json =
            serde_json::from_str(tagged).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let v = tag::decode(&j);
        let host = JsHost {
            call_parser: self.call_parser.as_ref(),
            call_serializer: self.call_serializer.as_ref(),
        };
        self.session
            .serialize_value(type_id, &v, &host)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// `parseType(x, oid)` against the session map. `x` may be null.
    /// Returns tagged-JSON.
    pub fn parse_value(&self, x: Option<String>, type_id: u32) -> Result<String, JsValue> {
        let host = JsHost {
            call_parser: self.call_parser.as_ref(),
            call_serializer: self.call_serializer.as_ref(),
        };
        let v = self
            .session
            .parse_value(x.as_deref(), type_id, &host)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(tag::encode(&v).to_string())
    }
}

fn merge_events(mut a: SessionEvents, b: SessionEvents) -> SessionEvents {
    a.notices.extend(b.notices);
    a.notifications.extend(b.notifications);
    a
}

// ---------------------------------------------------------------------------
// Free codec functions — back the adapter's `types` namespace
// (`types.parsers[oid]`, `types.serializers[oid]`, `types.parseType`). They
// carry no session state: JS-registered custom codecs live per-session, but
// the exported tables are the builtin defaults only, same as the reference
// `parsers`/`serializers` exports.
// ---------------------------------------------------------------------------

/// `parseType(x, type)` over the builtin handler table. `x` may be null →
/// tagged null. Returns the tagged-JSON encoded value.
#[wasm_bindgen]
pub fn codec_parse_type(x: Option<String>, type_id: u32) -> Result<String, JsValue> {
    use pglite_core::types::{self, NoHost, ParserOverrides};
    let merged = ParserOverrides::merged(&std::collections::HashMap::new(), &Default::default());
    let v = types::parse_type(x.as_deref(), type_id, &merged, &NoHost)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(tag::encode(&v).to_string())
}

/// `serializers[oid](x)` over the builtin handler table. `x` is tagged JSON.
#[wasm_bindgen]
pub fn codec_serialize(type_id: u32, tagged: &str) -> Result<String, JsValue> {
    use pglite_core::types::{self, NoHost, SerializerRef};
    let j: Json =
        serde_json::from_str(tagged).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let v = tag::decode(&j);
    let s = types::get_serializer(&types::default_serializers(), type_id)
        .ok_or_else(|| JsValue::from_str("no serializer for oid"))?;
    match s {
        SerializerRef::Builtin(f) => {
            f(&v, &NoHost).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        _ => Err(JsValue::from_str("host serializer in builtin table")),
    }
}

/// Enumerate the builtin codec keys (oids + handler names) so the adapter can
/// build the enumerable `parsers`/`serializers` tables. Name keys carry the
/// handler's `to` OID so they can still invoke the codec.
#[wasm_bindgen]
pub fn codec_keys() -> String {
    use pglite_core::types::{default_handlers, TypeKey};
    let key_of = |k: &TypeKey, to: u32| -> Json {
        match k {
            TypeKey::Oid(n) => json!({"oid": n}),
            TypeKey::Name(s) => json!({"name": s, "to": to}),
        }
    };
    let mut parsers = Vec::new();
    let mut serializers = Vec::new();
    for h in default_handlers() {
        // Parsers are keyed under `from` oids — a name key needs one of those
        // (e.g. 'number' has to:0 which is serializer-only).
        let parse_oid = h.from.first().copied().unwrap_or(h.to);
        parsers.push(key_of(&TypeKey::Name(h.name.to_string()), parse_oid));
        serializers.push(key_of(&TypeKey::Oid(h.to), h.to));
        serializers.push(key_of(&TypeKey::Name(h.name.to_string()), h.to));
        for f in h.from {
            parsers.push(key_of(&TypeKey::Oid(*f), *f));
            serializers.push(key_of(&TypeKey::Oid(*f), *f));
        }
    }
    json!({"parsers": parsers, "serializers": serializers}).to_string()
}

/// `arrayParser(x, typarray)` over builtin element codecs — exposed so the
/// adapter's `types` namespace can offer it without a session.
#[wasm_bindgen]
pub fn codec_array_parse(
    x: &str,
    elem_oid: Option<u32>,
    typarray: u32,
) -> Result<String, JsValue> {
    use pglite_core::types::{self, NoHost};
    let parser = elem_oid.and_then(|oid| {
        types::default_parsers()
            .get(&types::TypeKey::Oid(oid))
            .cloned()
    });
    let v = types::array_parser(x, parser, typarray, &NoHost)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(tag::encode(&v).to_string())
}

/// `arraySerializer(xs, serializer-oid, typarray)`.
#[wasm_bindgen]
pub fn codec_array_serialize(
    tagged: &str,
    elem_oid: Option<u32>,
    typarray: u32,
) -> Result<String, JsValue> {
    use pglite_core::types::{self, NoHost};
    let j: Json =
        serde_json::from_str(tagged).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let v = tag::decode(&j);
    let ser = elem_oid.and_then(|oid| {
        types::default_serializers()
            .get(&types::TypeKey::Oid(oid))
            .cloned()
    });
    types::array_serializer(&v, ser, typarray, &NoHost)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

fn decode_template_value(j: &Json) -> pglite_core::templating::TemplateValue {
    use pglite_core::templating::TemplateValue;
    if let Json::Object(m) = j {
        if let Some(s) = m.get("$part").and_then(|v| v.as_str()) {
            return TemplateValue::Part(s.to_string());
        }
        if let Some(c) = m.get("$cont") {
            let strings: Vec<String> = c["strings"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| v.as_str().unwrap_or_default().to_string())
                        .collect()
                })
                .unwrap_or_default();
            let raw: Vec<String> = c["raw"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| v.as_str().unwrap_or_default().to_string())
                        .collect()
                })
                .unwrap_or_else(|| strings.clone());
            let values: Vec<TemplateValue> = c["values"]
                .as_array()
                .map(|a| a.iter().map(decode_template_value).collect())
                .unwrap_or_default();
            return TemplateValue::Container {
                strings,
                raw,
                values,
            };
        }
    }
    TemplateValue::Plain(tag::decode(j))
}
