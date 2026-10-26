// Core port tests — types/values/arrays/templating/results/session.
use pglite_core::results::{parse_results, RowMode};
use pglite_core::templating::{query as tquery, sql_tag, TemplateValue};
use pglite_core::types::{
    self, array_parser, array_serializer, default_parsers, NoHost, ParserOverrides,
    ParserRef, SerializerRef, TypeKey,
};
use pglite_core::value::{tag, DateRepr, Value};
use pglite_protocol::messages::{BackendMessage, Field};
use pglite_protocol::Mode;
use serde_json::json;

const H: &NoHost = &NoHost;

fn overrides() -> ParserOverrides {
    ParserOverrides::merged(&default_parsers(), &Default::default())
}

// ---------------------------------------------------------------------------
// value tag envelope
// ---------------------------------------------------------------------------

#[test]
fn tag_roundtrip() {
    let cases = vec![
        Value::Null,
        Value::Undefined,
        Value::Bool(true),
        Value::Number(3.5),
        Value::Number(f64::NAN),
        Value::Number(f64::INFINITY),
        Value::Number(f64::NEG_INFINITY),
        Value::BigInt("9007199254740993".into()),
        Value::String("héllo".into()),
        Value::Bytes(vec![0, 1, 255]),
        Value::Date(DateRepr::FromMillis(0.0)),
        Value::Date(DateRepr::FromString("2024-06-01".into())),
        Value::Array(vec![Value::Number(1.0), Value::Null]),
        Value::Object(vec![
            ("k".into(), Value::Number(1.0)),
            ("k".into(), Value::Number(2.0)), // duplicate key preserved
        ]),
    ];
    for v in cases {
        let j = tag::encode(&v);
        let back = tag::decode(&j);
        let eq = match (&back, &v) {
            (Value::Number(a), Value::Number(b)) if a.is_nan() && b.is_nan() => true,
            _ => back == v,
        };
        assert!(eq, "roundtrip failed for {:?}", v);
    }
}

#[test]
fn tag_wire_shapes() {
    assert_eq!(tag::encode(&Value::Undefined), json!({"$undefined": true}));
    assert_eq!(tag::encode(&Value::BigInt("5".into())), json!({"$bigint": "5"}));
    assert_eq!(tag::encode(&Value::Bytes(vec![0xde, 0xad])), json!({"$bytes": "dead"}));
    assert_eq!(tag::encode(&Value::Number(f64::NAN)), json!({"$num": "NaN"}));
    // Value::Json encodes as the bare document — it only flows Rust→JS, where
    // the adapter decodes it to a plain JS object. Decoding the bare doc here
    // yields Object (params from JS arrive via $objpairs, not bare objects).
    let j = tag::encode(&Value::Json(json!({"a": 1})));
    assert_eq!(j, json!({"a": 1}));
    assert_eq!(
        tag::decode(&j),
        Value::Object(vec![("a".into(), Value::Number(1.0))])
    );
}

// ---------------------------------------------------------------------------
// parse_type — ported builtin codecs
// ---------------------------------------------------------------------------

fn ptype(x: Option<&str>, oid: u32) -> Value {
    parse_results_helper(x, oid)
}

fn parse_results_helper(x: Option<&str>, oid: u32) -> Value {
    let o = overrides();
    types::parse_type(x, oid, &o, H).unwrap()
}

#[test]
fn parse_bool_int_float_text() {
    assert_eq!(ptype(Some("t"), types::BOOL), Value::Bool(true));
    assert_eq!(ptype(Some("f"), types::BOOL), Value::Bool(false));
    assert_eq!(ptype(Some("42"), types::INT4), Value::Number(42.0));
    assert_eq!(ptype(Some("42"), types::INT2), Value::Number(42.0));
    assert_eq!(ptype(Some("42"), types::OID), Value::Number(42.0));
    assert_eq!(ptype(Some("1.5"), types::FLOAT8), Value::Number(1.5));
    assert_eq!(ptype(Some("txt"), types::VARCHAR), Value::String("txt".into()));
    // unknown oid → raw string
    assert_eq!(ptype(Some("txt"), 99999), Value::String("txt".into()));
    // null field → null
    assert_eq!(ptype(None, types::INT4), Value::Null);
}

#[test]
fn parse_bigint_boundary() {
    // in-range → number
    assert_eq!(ptype(Some("9007199254740991"), types::INT8), Value::Number(9007199254740991.0));
    // out of range → bigint
    assert_eq!(
        ptype(Some("9007199254740992"), types::INT8),
        Value::BigInt("9007199254740992".into())
    );
    assert_eq!(
        ptype(Some("-9007199254740993"), types::INT8),
        Value::BigInt("-9007199254740993".into())
    );
    // BigInt("") is 0n → number 0
    assert_eq!(ptype(Some(""), types::INT8), Value::Number(0.0));
}

#[test]
fn parse_json_and_jsonb() {
    assert_eq!(
        ptype(Some("{\"a\":1}"), types::JSON),
        // JS JSON.parse yields only f64 numbers.
        Value::Json(json!({"a": 1.0}))
    );
    assert_eq!(
        ptype(Some("{\"a\":1}"), types::JSONB),
        Value::Json(json!({"a": 1.0}))
    );
}

#[test]
fn parse_bytea() {
    assert_eq!(
        ptype(Some("\\x010203"), types::BYTEA),
        Value::Bytes(vec![1, 2, 3])
    );
}

#[test]
fn parse_date_timestamp() {
    // date/timestamp/timestamptz → Date
    match ptype(Some("2021-01-01"), types::DATE) {
        Value::Date(DateRepr::FromString(s)) => assert_eq!(s, "2021-01-01"),
        v => panic!("expected date string, got {:?}", v),
    }
}

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

fn ser(oid: u32, v: &Value) -> String {
    let s = types::get_serializer(&types::default_serializers(), oid).unwrap();
    match s {
        SerializerRef::Builtin(f) => f(v, H).unwrap(),
        _ => unreachable!(),
    }
}

#[test]
fn serialize_builtins() {
    assert_eq!(ser(types::BOOL, &Value::Bool(true)), "t");
    assert_eq!(ser(types::BOOL, &Value::Bool(false)), "f");
    // boolin-compatible literals
    assert_eq!(ser(types::BOOL, &Value::String("on".into())), "t");
    assert_eq!(ser(types::BOOL, &Value::Number(0.0)), "f");
    assert!(matches!(
        types::get_serializer(&types::default_serializers(), types::BOOL)
            .map(|s| match s {
                SerializerRef::Builtin(f) => f(&Value::Number(2.0), H),
                _ => unreachable!(),
            }),
        Some(Err(_))
    ));
    assert_eq!(ser(types::INT8, &Value::BigInt("42".into())), "42");
    assert_eq!(ser(types::INT4, &Value::Number(42.0)), "42");
    assert_eq!(
        ser(types::JSON, &Value::Json(json!({"a": 1}))),
        "{\"a\":1}"
    );
    // date serializer — Date → ISO
    assert_eq!(
        ser(types::TIMESTAMPTZ, &Value::Date(DateRepr::FromMillis(0.0))),
        "1970-01-01T00:00:00.000Z"
    );
    // bytea → \xhex
    assert_eq!(
        ser(types::BYTEA, &Value::Bytes(vec![1, 2, 3])),
        "\\x010203"
    );
}

// ---------------------------------------------------------------------------
// array parser/serializer — fidelity to the reference's peculiar behavior
// ---------------------------------------------------------------------------

fn aparse(x: &str, typarray: u32, parser: Option<ParserRef>) -> Value {
    array_parser(x, parser, typarray, H).unwrap()
}

#[test]
fn array_flat() {
    let p = Some(ParserRef::Builtin(
        types::default_handler_maps().parsers[&TypeKey::Oid(types::INT4)].clone(),
    ));
    assert_eq!(
        aparse("{1,2,3}", 0, p),
        Value::Array(vec![
            Value::Number(1.0),
            Value::Number(2.0),
            Value::Number(3.0)
        ])
    );
}

#[test]
fn array_nested() {
    let v = aparse("{{1,2},{3,4}}", 0, None);
    assert_eq!(
        v,
        Value::Array(vec![
            Value::Array(vec![Value::String("1".into()), Value::String("2".into())]),
            Value::Array(vec![Value::String("3".into()), Value::String("4".into())])
        ])
    );
}

#[test]
fn array_quoted_and_null() {
    let v = aparse("{\"a b\",NULL,\"c\\\"d\"}", 0, None);
    assert_eq!(
        v,
        Value::Array(vec![
            Value::String("a b".into()),
            Value::Null,
            Value::String("c\"d".into())
        ])
    );
}

#[test]
fn array_lowercase_null_is_string() {
    // Only the literal "NULL" is special: bare NULL → null, quoted "NULL" and
    // bare lowercase `null` both stay strings.
    let v = aparse("{NULL,\"NULL\",null}", 0, None);
    assert_eq!(
        v,
        Value::Array(vec![
            Value::Null,
            Value::String("NULL".into()),
            Value::String("null".into())
        ])
    );
}

#[test]
fn array_serialize_roundtrip() {
    let out = array_serializer(
        &Value::Array(vec![
            Value::Number(1.0),
            Value::Null,
            Value::String("a\"b".into()),
        ]),
        None,
        0,
        H,
    )
    .unwrap();
    assert_eq!(out, "{\"1\",null,\"a\\\"b\"}");
}

#[test]
fn array_serialize_nested() {
    let out = array_serializer(
        &Value::Array(vec![
            Value::Array(vec![Value::Number(1.0), Value::Number(2.0)]),
            Value::Array(vec![Value::Number(3.0)]),
        ]),
        None,
        0,
        H,
    )
    .unwrap();
    assert_eq!(out, "{{\"1\",\"2\"},{\"3\"}}");
}

// ---------------------------------------------------------------------------
// templating
// ---------------------------------------------------------------------------

#[test]
fn template_query_params() {
    let out = tquery(
        &["SELECT * FROM ".into(), " WHERE a = ".into()],
        &["SELECT * FROM ".into(), " WHERE a = ".into()],
        vec![
            TemplateValue::Part("\"t\"".into()),
            TemplateValue::Plain(Value::Number(3.0)),
        ],
    );
    assert_eq!(out.query, "SELECT * FROM \"t\" WHERE a = $1");
    assert_eq!(out.params, vec![Value::Number(3.0)]);
}

#[test]
fn template_nested_container() {
    // sql`a = ${1}` inside query`SELECT * FROM t WHERE ${inner} OR a = ${2}`
    let inner = TemplateValue::Container {
        strings: vec!["a = ".into(), "".into()],
        raw: vec!["a = ".into(), "".into()],
        values: vec![TemplateValue::Plain(Value::Number(1.0))],
    };
    let out = tquery(
        &["SELECT * FROM t WHERE ".into(), " OR a = ".into(), "".into()],
        &["SELECT * FROM t WHERE ".into(), " OR a = ".into(), "".into()],
        vec![inner, TemplateValue::Plain(Value::Number(2.0))],
    );
    assert_eq!(out.query, "SELECT * FROM t WHERE a = $1 OR a = $2");
    assert_eq!(out.params, vec![Value::Number(1.0), Value::Number(2.0)]);
}

// ---------------------------------------------------------------------------
// parse_results
// ---------------------------------------------------------------------------

fn fields() -> Vec<Field> {
    vec![Field {
        name: "n".into(),
        table_id: 0,
        column_id: 0,
        data_type_id: types::INT4,
        data_type_size: 4,
        data_type_modifier: -1,
        format: Mode::Text,
    }]
}

#[test]
fn results_basic() {
    let msgs = vec![
        BackendMessage::RowDescription { length: 0, fields: fields() },
        BackendMessage::DataRow { length: 0, fields: vec![Some("7".into())] },
        BackendMessage::CommandComplete { length: 0, text: "SELECT 1".into() },
        BackendMessage::ReadyForQuery { length: 0, status: "I".into() },
    ];
    let o = overrides();
    let rs = parse_results(&msgs, &o, RowMode::Object, false, H).unwrap();
    assert_eq!(rs.len(), 1);
    assert_eq!(rs[0].rows, vec![vec![Value::Number(7.0)]]);
    assert_eq!(rs[0].command.as_deref(), Some("SELECT"));
    assert_eq!(rs[0].row_count, Some(1));
}

#[test]
fn results_affected_rows_insert() {
    let msgs = vec![
        BackendMessage::CommandComplete { length: 0, text: "INSERT 0 3".into() },
        BackendMessage::CommandComplete { length: 0, text: "UPDATE 2".into() },
    ];
    let o = overrides();
    let rs = parse_results(&msgs, &o, RowMode::Object, false, H).unwrap();
    assert_eq!(rs[0].affected_rows, 3);
    assert_eq!(rs[1].affected_rows, 5); // accumulates
}

#[test]
fn results_no_command() {
    // empty message list → single empty Results
    let o = overrides();
    let rs = parse_results(&[], &o, RowMode::Object, false, H).unwrap();
    assert_eq!(rs.len(), 1);
    assert!(rs[0].rows.is_empty());
}

// ---------------------------------------------------------------------------
// session — mock transport driving canned protocol bytes
// ---------------------------------------------------------------------------

mod session {
    use super::*;
    use pglite_core::session::{QueryOptions, Session, SessionError, Transport};
    use pglite_protocol::messages::BackendMessage;

    fn be32(v: i32) -> [u8; 4] {
        v.to_be_bytes()
    }
    fn msg(code: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![code];
        out.extend_from_slice(&be32(body.len() as i32 + 4));
        out.extend_from_slice(body);
        out
    }

    fn row_desc(name: &str, oid: u32) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&1i16.to_be_bytes());
        b.extend_from_slice(name.as_bytes());
        b.push(0);
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0i16.to_be_bytes());
        b.extend_from_slice(&oid.to_be_bytes());
        b.extend_from_slice(&4i16.to_be_bytes());
        b.extend_from_slice(&(-1i32).to_be_bytes());
        b.extend_from_slice(&0i16.to_be_bytes());
        msg(b'T', &b)
    }
    fn data_row(vals: &[Option<&str>]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&(vals.len() as i16).to_be_bytes());
        for v in vals {
            match v {
                Some(s) => {
                    b.extend_from_slice(&(s.len() as i32).to_be_bytes());
                    b.extend_from_slice(s.as_bytes());
                }
                None => b.extend_from_slice(&(-1i32).to_be_bytes()),
            }
        }
        msg(b'D', &b)
    }
    fn cmd(text: &str) -> Vec<u8> {
        msg(b'C', format!("{}\0", text).as_bytes())
    }
    fn ready() -> Vec<u8> {
        msg(b'Z', b"I")
    }
    fn complete1() -> Vec<u8> {
        msg(b'1', b"")
    } // ParseComplete
    fn complete2() -> Vec<u8> {
        msg(b'2', b"")
    } // BindComplete
    fn param_desc(oids: &[u32]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&(oids.len() as i16).to_be_bytes());
        for o in oids {
            b.extend_from_slice(&o.to_be_bytes());
        }
        msg(b't', &b)
    }
    fn err(code: &str, m: &str) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"SERROR\0");
        b.extend_from_slice(format!("C{}\0", code).as_bytes());
        b.extend_from_slice(format!("M{}\0", m).as_bytes());
        b.push(0);
        msg(b'E', &b)
    }

    /// Script transport: each exec_raw call pops the next canned response.
    struct Script(Vec<Vec<u8>>);
    impl Transport for Script {
        fn exec_raw(&mut self, _message: &[u8]) -> Result<Vec<u8>, String> {
            Ok(if self.0.is_empty() { Vec::new() } else { self.0.remove(0) })
        }
    }

    /// Verify the emitted message sequence for run_query: Parse, Describe(S),
    /// Bind, Describe(P), Execute, Sync.
    #[test]
    fn run_query_protocol_sequence() {
        // canned responses per exchange call
        let responses = vec![
            complete1(),                            // Parse → '1'
            param_desc(&[23]),                      // Describe(S) → 't'
            complete2(),                            // Bind → '2'
            row_desc("v", 23),                      // Describe(P) → 'T'
            [data_row(&[Some("5")]), cmd("SELECT 1"), ready()].concat(), // Execute → rows + C + Z
            ready(),                                // Sync → 'Z'
        ];
        let mut t = Script(responses);
        let mut s = Session::new();
        let out = s
            .run_query(&mut t, "SELECT $1::int as v", vec![Value::Number(5.0)], &QueryOptions::default(), H)
            .unwrap();
        assert_eq!(out.result.rows, vec![vec![Value::Number(5.0)]]);
    }

    #[test]
    fn run_query_db_error_wrapped() {
        let responses = vec![
            err("42P01", "nope"), // Parse → error latched
            ready(),              // Sync
        ];
        let mut t = Script(responses);
        let mut s = Session::new();
        let e = s
            .run_query(&mut t, "SELECT bad", vec![], &QueryOptions::default(), H)
            .unwrap_err();
        match e {
            SessionError::Database(pe) => {
                assert_eq!(pe.error.code.as_deref(), Some("42P01"));
                assert_eq!(pe.query.as_deref(), Some("SELECT bad"));
            }
            other => panic!("expected Database, got {:?}", other),
        }
    }

    #[test]
    fn run_exec_simple() {
        let responses = vec![
            [row_desc("v", 23), data_row(&[Some("1")]), cmd("SELECT 1"), ready()].concat(),
            ready(),
        ];
        let mut t = Script(responses);
        let mut s = Session::new();
        let out = s
            .run_exec(&mut t, "SELECT 1 as v", &QueryOptions::default(), H)
            .unwrap();
        assert_eq!(out.results[0].rows, vec![vec![Value::Number(1.0)]]);
    }

    #[test]
    fn describe_query_params() {
        let responses = vec![
            complete1(),
            param_desc(&[23, 25]),
            ready(),
        ];
        let mut t = Script(responses);
        let mut s = Session::new();
        let out = s
            .describe_query(&mut t, "SELECT $1::int, $2::text", &QueryOptions::default())
            .unwrap();
        assert_eq!(out.result.query_params.len(), 2);
        assert_eq!(out.result.query_params[0].data_type_id, 23);
        assert!(out.result.query_params[0].has_serializer);
    }

    #[test]
    fn exec_protocol_collects_events() {
        use pglite_core::session::ExecProtocolOptions;
        // Notification + notice + ready in one blob
        let mut notif = Vec::new();
        notif.extend_from_slice(&12i32.to_be_bytes());
        notif.extend_from_slice(b"ch\0pay\0");
        let mut notice_body = Vec::new();
        notice_body.extend_from_slice(b"SWARNING\0");
        notice_body.extend_from_slice(b"Mcareful\0");
        notice_body.push(0);
        let data = [msg(b'A', &notif), msg(b'N', &notice_body), ready()].concat();

        let mut t = Script(vec![data]);
        let mut s = Session::new();
        let out = s
            .exec_protocol(
                &mut t,
                &msg(b'Q', b"LISTEN ch\0"),
                ExecProtocolOptions::defaults(),
            )
            .unwrap();
        assert_eq!(out.notifications.len(), 1);
        assert_eq!(out.notifications[0].1, "ch");
        assert_eq!(out.notices.len(), 1);
        assert_eq!(out.notices[0].message.as_deref(), Some("careful"));
        // messages parsed
        assert!(out
            .messages
            .iter()
            .any(|m| matches!(m, BackendMessage::ReadyForQuery { .. })));
    }
}
