// PORT STATUS
// source: packages/pglite/src/base.ts + packages/pglite/src/pglite.ts
//         (CurrentQuery, #parse, execProtocol* family, #runQuery/#runExec,
//         describeQuery, transaction state flags)
// baseline: e752dbe
// stage: in-progress
// verification: adapter integration tests pending
// open issues:
// - JS-side mutexes (transactionMutex/queryMutex/listenMutex/fsSyncMutex)
//   live in the adapter (sync calls cannot interleave under the bridge ABI).
// - `queueMicrotask` notification delivery stays adapter-side.
// - Blob (/dev/blob) buffers are adapter-side state; `has_blob` flagged here.

use crate::errors::{make_pglite_error, PGliteError};
use crate::results::{parse_describe_statement_results, parse_results, Results, RowMode};
use crate::types::{
    CodecError, HostCallbacks, ParserOverrides, ParserRef, SerializerRef, TypeKey,
};
use crate::value::Value;
use pglite_protocol::messages::{BackendMessage, ErrorNotice};
use pglite_protocol::parser::Parser;
use pglite_protocol::serializer::{self, BindOpts, ExecOpts, ParseOpts, PortalOpts, PortalType};
use pglite_protocol::LegalValue;
use std::collections::HashMap;

/// Host call used to run one protocol exchange through the engine —
/// the `execProtocolRawSync` equivalent.
pub trait Transport {
    /// Send frontend message bytes to the engine; returns raw response bytes.
    /// Errors mirror JS exceptions thrown inside `execProtocolRawSync`
    /// (engine abort, startup-packet failure).
    fn exec_raw(&mut self, message: &[u8]) -> Result<Vec<u8>, String>;
}

/// `CurrentQuery` from pglite.ts — accumulates results and the first
/// DatabaseError while a query's messages stream in.
#[derive(Default)]
struct CurrentQuery {
    results: Vec<BackendMessage>,
    throw_on_error: bool,
    database_error: Option<ErrorNotice>,
    /// Notices collected during the exchange — emitted adapter-side.
    notices: Vec<ErrorNotice>,
    /// Notifications collected during the exchange — dispatched adapter-side.
    notifications: Vec<(i32, String, String)>,
}

/// Options accepted by `query`/`exec`/`describe` — mirrors `QueryOptions`.
#[derive(Default)]
pub struct QueryOptions {
    pub row_mode: RowMode,
    /// per-query parser overrides (host-registered ids or builtins by key)
    pub parsers: HashMap<TypeKey, ParserRef>,
    pub serializers: HashMap<TypeKey, SerializerRef>,
    /// `paramTypes` — explicit param OIDs for Parse.
    pub param_types: Option<Vec<u32>>,
    /// `onNotice` present? (callback itself stays adapter-side)
    pub has_on_notice: bool,
    /// `options.blob` present — adapter handles the /dev/blob read side.
    pub has_blob: bool,
}

impl Default for RowMode {
    fn default() -> Self {
        RowMode::Object
    }
}

/// `ExecProtocolOptions`.
#[derive(Default)]
pub struct ExecProtocolOptions {
    pub sync_to_fs: bool,
    pub throw_on_error: bool,
    pub has_on_notice: bool,
}

impl ExecProtocolOptions {
    pub fn defaults() -> Self {
        ExecProtocolOptions {
            sync_to_fs: true,
            throw_on_error: true,
            has_on_notice: false,
        }
    }
}

/// `{ messages, data }` of `execProtocol`, plus side-channel events the
/// adapter must dispatch (notices via onNotice, notifications via listeners).
pub struct ExecProtocolOutcome {
    pub messages: Vec<BackendMessage>,
    pub data: Vec<u8>,
    pub notices: Vec<ErrorNotice>,
    pub notifications: Vec<(i32, String, String)>,
    /// `execProtocolRawSync` consumed fs state → adapter should `syncToFs`
    /// when the caller asked for it.
    pub parsed_any: bool,
}

/// Events accumulated across the internal exchanges of one run_query /
/// run_exec / describe_query call. The adapter dispatches them after the
/// call returns (JS dispatched them via queueMicrotask — same timing).
#[derive(Default, Debug)]
pub struct SessionEvents {
    pub notices: Vec<ErrorNotice>,
    pub notifications: Vec<(i32, String, String)>,
}

/// Return value of `run_query`.
#[derive(Debug)]
pub struct QueryOutcome {
    pub result: Results,
    pub events: SessionEvents,
}

/// Return value of `run_exec`.
#[derive(Debug)]
pub struct ExecOutcome {
    pub results: Vec<Results>,
    pub events: SessionEvents,
}

/// Return value of `describe_query`.
#[derive(Debug)]
pub struct DescribeOutcome {
    pub result: DescribeQueryResult,
    pub events: SessionEvents,
}

#[derive(Debug)]
pub enum SessionError {
    /// Wrapped DatabaseError with query context (PGliteError).
    Database(Box<PGliteError>),
    /// Bare DatabaseError — e.g. thrown by `execProtocol` with no query ctx.
    DatabaseBare(Box<ErrorNotice>),
    Codec(CodecError),
    /// JS exception inside the engine exchange.
    Transport(String),
    /// Response stream parse failure (parser reset already applied).
    Parse(String),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Database(e) => write!(f, "{}", e),
            SessionError::DatabaseBare(e) => write!(f, "{}", e),
            SessionError::Codec(e) => write!(f, "{}", e),
            SessionError::Transport(e) | SessionError::Parse(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for SessionError {}

/// Per-instance state — the portable half of `PGlite`/`BasePGlite`.
pub struct Session {
    /// `#protocolParser` — persists across messages; reset after a thrown
    /// DatabaseError.
    parser: Parser,
    current: CurrentQuery,
    /// `serializers` instance map (defaults + constructor options merged).
    pub serializers: HashMap<TypeKey, SerializerRef>,
    /// `parsers` instance map.
    pub parsers_inst: HashMap<TypeKey, ParserRef>,
    /// `#inTransaction` — suppresses per-query syncToFs.
    pub in_transaction: bool,
    /// `#arrayTypesInitialized`
    array_types_initialized: bool,
    /// Events collected by internal `exec_protocol_no_sync` calls during a
    /// run_* method; drained into the method's outcome.
    pending_events: SessionEvents,
}

impl Session {
    pub fn new() -> Self {
        Session {
            parser: Parser::new(),
            current: CurrentQuery::default(),
            serializers: crate::types::default_serializers(),
            parsers_inst: crate::types::default_parsers(),
            in_transaction: false,
            array_types_initialized: false,
            pending_events: SessionEvents::default(),
        }
    }

    fn absorb_events(&mut self, out: ExecProtocolOutcome) -> Vec<BackendMessage> {
        self.pending_events.notices.extend(out.notices);
        self.pending_events.notifications.extend(out.notifications);
        out.messages
    }

    /// Drain events without consuming an outcome — the bridge calls this on
    /// every return path (JS dispatched events inline, so they surface even
    /// when the call errors).
    pub fn drain_events(&mut self) -> SessionEvents {
        std::mem::take(&mut self.pending_events)
    }

    /// `#parse` — latch first DatabaseError, route notices/notifications,
    /// collect results. Returns Some(msg) while no error is latched.
    fn handle_msg(&mut self, msg: BackendMessage) -> Option<BackendMessage> {
        if self.current.database_error.is_none() {
            match &msg {
                BackendMessage::Error(e) => {
                    if self.current.throw_on_error {
                        self.current.database_error = Some((**e).clone());
                    }
                }
                BackendMessage::Notice(n) => {
                    self.current.notices.push((**n).clone());
                }
                BackendMessage::Notification {
                    process_id,
                    channel,
                    payload,
                    ..
                } => {
                    self.current
                        .notifications
                        .push((*process_id, channel.clone(), payload.clone()));
                }
                _ => {}
            }
            // Reference returns `msg` unconditionally (error messages are
            // pushed to results too).
            return Some(msg);
        }
        None
    }

    /// `execProtocolRawSync` equivalent: send + receive, feeding responses
    /// through the persistent parser. Raw bytes are also returned.
    fn raw_exchange(
        &mut self,
        transport: &mut dyn Transport,
        message: &[u8],
        parse: bool,
    ) -> Result<Vec<u8>, SessionError> {
        let data = transport
            .exec_raw(message)
            .map_err(SessionError::Transport)?;
        if parse && !data.is_empty() {
            // The TS path parses inside the socket write callback; semantics
            // preserved: incremental parser over the full response.
            let mut parser = std::mem::take(&mut self.parser);
            let mut collected: Vec<BackendMessage> = Vec::new();
            let parse_res = parser.parse(&data, |msg| {
                if let Some(m) = self.handle_msg(msg) {
                    collected.push(m);
                }
            });
            self.parser = parser;
            if let Err(e) = parse_res {
                return Err(SessionError::Parse(e.to_string()));
            }
            // keep results accumulation identical to #parseData
            for m in collected {
                self.current.results.push(m);
            }
        }
        Ok(data)
    }

    /// `execProtocol` — returns messages + raw data; throws the latched
    /// DatabaseError when `throwOnError`.
    pub fn exec_protocol(
        &mut self,
        transport: &mut dyn Transport,
        message: &[u8],
        options: ExecProtocolOptions,
    ) -> Result<ExecProtocolOutcome, SessionError> {
        self.current = CurrentQuery {
            throw_on_error: options.throw_on_error,
            ..Default::default()
        };

        // execProtocolRaw without fs sync (syncToFs is adapter-async).
        let data = self.raw_exchange(transport, message, true)?;

        let database_error = self.current.database_error.take();
        let outcome = ExecProtocolOutcome {
            messages: std::mem::take(&mut self.current.results),
            data,
            notices: std::mem::take(&mut self.current.notices),
            notifications: std::mem::take(&mut self.current.notifications),
            parsed_any: true,
        };
        self.current = CurrentQuery::default();

        if options.throw_on_error {
            if let Some(e) = database_error {
                self.parser.reset(); // `this.#protocolParser = new ProtocolParser()`
                return Err(SessionError::DatabaseBare(Box::new(e)));
            }
        }
        Ok(outcome)
    }

    /// `execProtocolStream` — messages only.
    pub fn exec_protocol_stream(
        &mut self,
        transport: &mut dyn Transport,
        message: &[u8],
        options: ExecProtocolOptions,
    ) -> Result<ExecProtocolOutcome, SessionError> {
        self.current = CurrentQuery {
            throw_on_error: options.throw_on_error,
            ..Default::default()
        };
        let data = transport
            .exec_raw(message)
            .map_err(SessionError::Transport)?;
        if !data.is_empty() {
            let mut parser = std::mem::take(&mut self.parser);
            let mut collected: Vec<BackendMessage> = Vec::new();
            let parse_res = parser.parse(&data, |msg| {
                if let Some(m) = self.handle_msg(msg) {
                    collected.push(m);
                }
            });
            self.parser = parser;
            if let Err(e) = parse_res {
                return Err(SessionError::Parse(e.to_string()));
            }
            for m in collected {
                self.current.results.push(m);
            }
        }
        let database_error = self.current.database_error.take();
        let outcome = ExecProtocolOutcome {
            messages: std::mem::take(&mut self.current.results),
            data: Vec::new(),
            notices: std::mem::take(&mut self.current.notices),
            notifications: std::mem::take(&mut self.current.notifications),
            parsed_any: true,
        };
        self.current = CurrentQuery::default();
        if options.throw_on_error {
            if let Some(e) = database_error {
                self.parser.reset();
                return Err(SessionError::DatabaseBare(Box::new(e)));
            }
        }
        Ok(outcome)
    }

    fn exec_protocol_no_sync(
        &mut self,
        transport: &mut dyn Transport,
        message: &[u8],
    ) -> Result<Vec<BackendMessage>, SessionError> {
        let out = self.exec_protocol_stream(
            transport,
            message,
            ExecProtocolOptions {
                sync_to_fs: false,
                throw_on_error: true,
                has_on_notice: false,
            },
        )?;
        Ok(self.absorb_events(out))
    }

    /// `#runQuery` — extended-protocol single statement.
    pub fn run_query(
        &mut self,
        transport: &mut dyn Transport,
        query: &str,
        params: Vec<Value>,
        options: &QueryOptions,
        host: &dyn HostCallbacks,
    ) -> Result<QueryOutcome, SessionError> {
        // _handleBlob is adapter-side.
        let mut results: Vec<BackendMessage> = Vec::new();
        let mut pending_err: Option<SessionError> = None;

        let mut work = || -> Result<(), SessionError> {
            let (parse_msg, name_too_long) = serializer::serialize::parse(&ParseOpts {
                name: None,
                text: query,
                types: options.param_types.as_deref(),
            });
            let _ = name_too_long; // TODO(port): surface console.error warning
            let parse_results_msgs =
                self.exec_protocol_no_sync(transport, &parse_msg)?;
            results.extend(parse_results_msgs);

            // Reference: describe-statement messages are consumed for param
            // OIDs but NOT added to `results`.
            let describe_msgs = self.exec_protocol_no_sync(
                transport,
                &serializer::serialize::describe(&PortalOpts {
                    r#type: PortalType::Statement,
                    name: None,
                }),
            )?;
            let data_type_ids = parse_describe_statement_results(&describe_msgs);

            let mut values: Vec<LegalValue> = Vec::with_capacity(params.len());
            for (i, param) in params.iter().enumerate() {
                let oid = data_type_ids.get(i).copied().unwrap_or(0);
                if matches!(param, Value::Null | Value::Undefined) {
                    values.push(LegalValue::Null);
                    continue;
                }
                let serializer = options
                    .serializers
                    .get(&TypeKey::Oid(oid))
                    .cloned()
                    .or_else(|| self.serializers.get(&TypeKey::Oid(oid)).cloned());
                match serializer {
                    Some(SerializerRef::Builtin(f)) => {
                        values.push(LegalValue::Text(
                            f(param, host).map_err(SessionError::Codec)?,
                        ));
                    }
                    Some(SerializerRef::Host(id)) => {
                        match host.call_serializer(id, param) {
                            Some(Ok(s)) => values.push(LegalValue::Text(s)),
                            Some(Err(e)) => {
                                return Err(SessionError::Codec(CodecError::Host(e)))
                            }
                            None => values.push(LegalValue::Text(
                                crate::jstypeconv::js_to_string(param),
                            )),
                        }
                    }
                    None => values.push(LegalValue::Text(
                        crate::jstypeconv::js_to_string(param),
                    )),
                }
            }

            results.extend(self.exec_protocol_no_sync(
                transport,
                &serializer::serialize::bind(&BindOpts {
                    values: &values,
                    ..Default::default()
                }),
            )?);
            results.extend(self.exec_protocol_no_sync(
                transport,
                &serializer::serialize::describe(&PortalOpts {
                    r#type: PortalType::Portal,
                    name: None,
                }),
            )?);
            results.extend(self.exec_protocol_no_sync(
                transport,
                &serializer::serialize::execute(None::<&ExecOpts>),
            )?);
            Ok(())
        };

        if let Err(e) = work() {
            pending_err = Some(match e {
                SessionError::DatabaseBare(db) => SessionError::Database(Box::new(
                    make_pglite_error(*db, query.to_string(), Some(params.clone()), true),
                )),
                other => other,
            });
        }

        // finally: Sync is always sent.
        match self.exec_protocol_no_sync(transport, &serializer::serialize::sync()) {
            Ok(sync_msgs) => results.extend(sync_msgs),
            Err(e) => {
                // JS `finally` throwing replaces any in-flight exception.
                if let SessionError::DatabaseBare(db) = e {
                    return Err(SessionError::Database(Box::new(make_pglite_error(
                        *db,
                        query.to_string(),
                        Some(params),
                        true,
                    ))));
                }
                return Err(e);
            }
        }

        if let Some(e) = pending_err {
            return Err(e);
        }

        // parseType map = defaults ∪ instance ∪ query options
        let merged = ParserOverrides::merged(&self.parsers_inst, &options.parsers);
        let parsed = parse_results(&results, &merged, options.row_mode, false, host)
            .map_err(SessionError::Codec)?;
        Ok(QueryOutcome {
            result: parsed.into_iter().next().unwrap(),
            events: self.drain_events(),
        })
    }

    /// `#runExec` — simple-protocol multi-statement.
    pub fn run_exec(
        &mut self,
        transport: &mut dyn Transport,
        query: &str,
        options: &QueryOptions,
        host: &dyn HostCallbacks,
    ) -> Result<ExecOutcome, SessionError> {
        let mut results: Vec<BackendMessage> = Vec::new();
        let mut pending_err: Option<SessionError> = None;

        match self.exec_protocol_no_sync(
            transport,
            &serializer::serialize::query(query),
        ) {
            Ok(msgs) => results.extend(msgs),
            Err(e) => {
                pending_err = Some(match e {
                    SessionError::DatabaseBare(db) => {
                        SessionError::Database(Box::new(make_pglite_error(
                            *db,
                            query.to_string(),
                            None,
                            true,
                        )))
                    }
                    other => other,
                })
            }
        }

        match self.exec_protocol_no_sync(transport, &serializer::serialize::sync()) {
            Ok(sync_msgs) => results.extend(sync_msgs),
            Err(e) => {
                if let SessionError::DatabaseBare(db) = e {
                    return Err(SessionError::Database(Box::new(make_pglite_error(
                        *db,
                        query.to_string(),
                        None,
                        true,
                    ))));
                }
                return Err(e);
            }
        }

        if let Some(e) = pending_err {
            return Err(e);
        }

        let merged = ParserOverrides::merged(&self.parsers_inst, &options.parsers);
        let parsed = parse_results(&results, &merged, options.row_mode, false, host)
            .map_err(SessionError::Codec)?;
        Ok(ExecOutcome {
            results: parsed,
            events: self.drain_events(),
        })
    }

    /// `describeQuery`.
    pub fn describe_query(
        &mut self,
        transport: &mut dyn Transport,
        query: &str,
        options: &QueryOptions,
    ) -> Result<DescribeOutcome, SessionError> {
        let mut messages: Vec<BackendMessage> = Vec::new();
        let mut pending_err: Option<SessionError> = None;

        let mut work = |messages: &mut Vec<BackendMessage>| -> Result<(), SessionError> {
            let (parse_msg, _) = serializer::serialize::parse(&ParseOpts {
                name: None,
                text: query,
                types: options.param_types.as_deref(),
            });
            self.exec_protocol_no_sync(transport, &parse_msg)?;
            let msgs = self.exec_protocol_no_sync(
                transport,
                &serializer::serialize::describe(&PortalOpts {
                    r#type: PortalType::Statement,
                    name: None,
                }),
            )?;
            messages.extend(msgs);
            Ok(())
        };

        if let Err(e) = work(&mut messages) {
            pending_err = Some(match e {
                SessionError::DatabaseBare(db) => SessionError::Database(Box::new(
                    make_pglite_error(*db, query.to_string(), None, true),
                )),
                other => other,
            });
        }

        match self.exec_protocol_no_sync(transport, &serializer::serialize::sync()) {
            Ok(sync_msgs) => messages.extend(sync_msgs),
            Err(e) => {
                if let SessionError::DatabaseBare(db) = e {
                    return Err(SessionError::Database(Box::new(make_pglite_error(
                        *db,
                        query.to_string(),
                        None,
                        true,
                    ))));
                }
                return Err(e);
            }
        }

        if let Some(e) = pending_err {
            return Err(e);
        }

        let mut param_description = None;
        let mut result_description = None;
        for m in &messages {
            match m {
                BackendMessage::ParameterDescription { data_type_ids, .. }
                    if param_description.is_none() =>
                {
                    param_description = Some(data_type_ids.clone());
                }
                BackendMessage::RowDescription { fields, .. }
                    if result_description.is_none() =>
                {
                    result_description = Some(fields.clone());
                }
                _ => {}
            }
        }

        let query_params = param_description
            .unwrap_or_default()
            .into_iter()
            .map(|data_type_id| QueryParam {
                data_type_id,
                has_serializer: self
                    .serializers
                    .contains_key(&TypeKey::Oid(data_type_id)),
            })
            .collect();
        let result_fields = result_description
            .unwrap_or_default()
            .into_iter()
            .map(|f| ResultFieldDesc {
                name: f.name,
                data_type_id: f.data_type_id,
                has_parser: self
                    .parsers_inst
                    .contains_key(&TypeKey::Oid(f.data_type_id)),
            })
            .collect();
        Ok(DescribeOutcome {
            result: DescribeQueryResult {
                query_params,
                result_fields,
            },
            events: self.drain_events(),
        })
    }

    /// `_initArrayTypes` — installs per-array-type serializers/parsers built
    /// from the element OIDs discovered in pg_type.
    pub fn init_array_types(
        &mut self,
        transport: &mut dyn Transport,
        host: &dyn HostCallbacks,
        force: bool,
    ) -> Result<(), SessionError> {
        if self.array_types_initialized && !force {
            return Ok(());
        }
        self.array_types_initialized = true;
        let types = self.run_query(
            transport,
            "SELECT b.oid, b.typarray
             FROM pg_catalog.pg_type a
             LEFT JOIN pg_catalog.pg_type b ON b.oid = a.typelem
             WHERE a.typcategory = 'A'
             GROUP BY b.oid, b.typarray
             ORDER BY b.oid",
            Vec::new(),
            &QueryOptions::default(),
            host,
        )?;
        for row in types.result.rows {
            let oid = match row.first() {
                Some(Value::Number(n)) => *n as u32,
                Some(Value::BigInt(s)) => s.parse().unwrap_or(0),
                _ => continue,
            };
            let typarray = match row.get(1) {
                Some(Value::Number(n)) => *n as u32,
                Some(Value::BigInt(s)) => s.parse().unwrap_or(0),
                _ => continue,
            };
            // Bound at discovery time (reference closes over the lookups).
            let elem_ser = self.serializers.get(&TypeKey::Oid(oid)).cloned();
            let elem_par = self.parsers_inst.get(&TypeKey::Oid(oid)).cloned();
            self.serializers.insert(
                TypeKey::Oid(typarray),
                SerializerRef::Builtin(std::rc::Rc::new(move |x: &Value, host: &dyn HostCallbacks| {
                    crate::types::array_serializer(x, elem_ser.clone(), typarray, host)
                })),
            );
            self.parsers_inst.insert(
                TypeKey::Oid(typarray),
                ParserRef::Builtin(std::rc::Rc::new(
                    move |x: &str, _tid: u32, host: &dyn HostCallbacks| {
                        crate::types::array_parser(x, elem_par.clone(), typarray, host)
                    },
                )),
            );
        }
        Ok(())
    }

    // -----------------------------------------------------------------
    // Codec views — back `db.serializers` / `db.parsers` on the adapter.
    // -----------------------------------------------------------------

    /// Keys of the instance serializer map (defaults + array types + custom).
    pub fn serializer_keys(&self) -> Vec<TypeKey> {
        self.serializers.keys().cloned().collect()
    }

    /// Keys of the instance parser map.
    pub fn parser_keys(&self) -> Vec<TypeKey> {
        self.parsers_inst.keys().cloned().collect()
    }

    /// `serializers[oid](x)` against the session map; `js_to_string` fallback
    /// mirrors the run_query param path for unknown oids.
    pub fn serialize_value(
        &self,
        oid: u32,
        v: &Value,
        host: &dyn HostCallbacks,
    ) -> Result<String, CodecError> {
        match self.serializers.get(&TypeKey::Oid(oid)) {
            Some(SerializerRef::Builtin(f)) => f(v, host),
            Some(SerializerRef::Host(id)) => match host.call_serializer(*id, v) {
                Some(Ok(s)) => Ok(s),
                Some(Err(e)) => Err(CodecError::Host(e)),
                None => Ok(crate::jstypeconv::js_to_string(v)),
            },
            None => Ok(crate::jstypeconv::js_to_string(v)),
        }
    }

    /// `parseType(x, oid)` against the session map (null → null, raw string
    /// fallback for unknown oids — same as `parse_type` over merged maps).
    pub fn parse_value(
        &self,
        x: Option<&str>,
        oid: u32,
        host: &dyn HostCallbacks,
    ) -> Result<Value, CodecError> {
        let Some(x) = x else {
            return Ok(Value::Null);
        };
        match self.parsers_inst.get(&TypeKey::Oid(oid)) {
            Some(ParserRef::Builtin(f)) => f(x, oid, host),
            Some(ParserRef::Host(id)) => match host.call_parser(*id, x, oid) {
                Some(Ok(v)) => Ok(v),
                Some(Err(e)) => Err(CodecError::Host(e)),
                None => Ok(Value::String(x.to_string())),
            },
            None => Ok(Value::String(x.to_string())),
        }
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

/// `DescribeQueryResult`. Function-valued `serializer`/`parser` fields can't
/// cross the boundary — presence flags stand in until needed.
#[derive(Debug)]
pub struct DescribeQueryResult {
    pub query_params: Vec<QueryParam>,
    pub result_fields: Vec<ResultFieldDesc>,
}

#[derive(Debug)]
pub struct QueryParam {
    pub data_type_id: u32,
    pub has_serializer: bool,
}

#[derive(Debug)]
pub struct ResultFieldDesc {
    pub name: String,
    pub data_type_id: u32,
    pub has_parser: bool,
}


