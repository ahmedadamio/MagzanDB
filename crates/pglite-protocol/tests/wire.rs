// Wire-format tests — byte-exact expectations derived from the reference
// TS implementation (pg-protocol serializer/parser).
use pglite_protocol::messages::BackendMessage;
use pglite_protocol::parser::Parser;
use pglite_protocol::serializer::{
    serialize, BindOpts, ExecOpts, LegalValue, ParseOpts, PortalOpts, PortalType,
};

#[test]
fn query_bytes() {
    let b = serialize::query("SELECT 1");
    // 'Q' + len(4=4+8+1) + "SELECT 1" + \0
    assert_eq!(
        b,
        [0x51, 0, 0, 0, 13, b'S', b'E', b'L', b'E', b'C', b'T', b' ', b'1', 0]
    );
}

#[test]
fn code_only_buffers() {
    assert_eq!(serialize::sync(), [b'S', 0, 0, 0, 4]);
    assert_eq!(serialize::flush(), [b'H', 0, 0, 0, 4]);
    assert_eq!(serialize::end(), [b'X', 0, 0, 0, 4]);
    assert_eq!(serialize::copy_done(), [b'c', 0, 0, 0, 4]);
}

#[test]
fn empty_execute_fastpath() {
    assert_eq!(
        serialize::execute(None::<&ExecOpts>),
        [0x45, 0, 0, 0, 9, 0, 0, 0, 0, 0]
    );
}

#[test]
fn describe_buffers() {
    assert_eq!(
        serialize::describe(&PortalOpts {
            r#type: PortalType::Portal,
            name: None
        }),
        [0x44, 0, 0, 0, 6, b'P', 0]
    );
    assert_eq!(
        serialize::describe(&PortalOpts {
            r#type: PortalType::Statement,
            name: None
        }),
        [0x44, 0, 0, 0, 6, b'S', 0]
    );
    // named portal → cstring_message path: len = 4 + "Px\0"(3) = 7
    assert_eq!(
        serialize::describe(&PortalOpts {
            r#type: PortalType::Portal,
            name: Some("x")
        }),
        [0x44, 0, 0, 0, 7, b'P', b'x', 0]
    );
}

#[test]
fn parse_bytes() {
    let (b, too_long) = serialize::parse(&ParseOpts {
        name: None,
        text: "SELECT $1",
        types: Some(&[23]),
    });
    assert!(!too_long);
    // 'P' + len + ""\0 + "SELECT $1"\0 + int16(1) + int32(23)
    let expect_len = 4 + 1 + 10 + 2 + 4;
    assert_eq!(b[0], 0x50);
    assert_eq!(i32::from_be_bytes(b[1..5].try_into().unwrap()) as usize, expect_len);
    assert_eq!(&b[5..6], &[0]);
    assert_eq!(&b[6..16], b"SELECT $1\0");
    assert_eq!(&b[16..18], &[0, 1]);
    assert_eq!(&b[18..22], &[0, 0, 0, 23]);
    assert_eq!(b.len(), 1 + expect_len);
}

#[test]
fn parse_no_types() {
    let (b, _) = serialize::parse(&ParseOpts {
        name: None,
        text: "X",
        types: None,
    });
    // len = 4 + 1 + 2 + 2 = 9
    assert_eq!(b, [0x50, 0, 0, 0, 9, 0, b'X', 0, 0, 0]);
}

#[test]
fn bind_text_and_null() {
    let b = serialize::bind(&BindOpts {
        values: &[LegalValue::Text("42".into()), LegalValue::Null],
        ..Default::default()
    });
    // 'B' + len + portal\0 + stmt\0 + nparams(2) + fmts(0,0) + nparams(2)
    //   + (len 2 + "42") + (-1) + result fmt(0)
    // len = 4 + 1 + 1 + 2 + 4 + 2 + (4+2) + 4 + 2 = 26
    let expect = [
        0x42, 0, 0, 0, 26, // header+len
        0, 0, // portal, statement cstrings
        0, 2, // 2 params
        0, 0, 0, 0, // formats: text, text
        0, 2, // 2 param values
        0, 0, 0, 2, b'4', b'2', // "42"
        0xFF, 0xFF, 0xFF, 0xFF, // null
        0, 0, // result format text
    ];
    assert_eq!(b, expect);
}

#[test]
fn bind_binary() {
    let b = serialize::bind(&BindOpts {
        binary: true,
        values: &[LegalValue::Binary(vec![1, 2, 3])],
        ..Default::default()
    });
    assert_eq!(b[0], 0x42);
    // last 2 bytes = result format 1 (binary)
    assert_eq!(&b[b.len() - 2..], &[0, 1]);
    // contains the binary payload
    assert!(b.windows(7).any(|w| w == [0, 0, 0, 3, 1, 2, 3]));
}

#[test]
fn startup_packet() {
    let b = serialize::startup(&[
        ("user".to_string(), "postgres".to_string()),
        ("database".to_string(), "postgres".to_string()),
    ]);
    // length-prefixed, first byte 0 (the startup discriminator in the adapter)
    assert_eq!(b[0], 0);
    let len = i32::from_be_bytes(b[0..4].try_into().unwrap()) as usize;
    // len covers itself through end of packet
    assert_eq!(len, b.len());
    // version 3.0
    assert_eq!(&b[4..8], &[0, 3, 0, 0]);
    // ends with double NUL after client_encoding UTF8
    assert_eq!(&b[b.len() - 2..], &[0, 0]);
    let body = &b[8..];
    assert!(body.windows(5).any(|w| w == *b"user\0"));
    assert!(body.windows(16).any(|w| w == *b"client_encoding\0"));
}

#[test]
fn cancel_bytes() {
    let b = serialize::cancel(0x01020304, 0x05060708);
    assert_eq!(
        b,
        [
            0, 0, 0, 16, // len 16
            0x04, 0xD2, 0x16, 0x2E, // 1234/5678
            1, 2, 3, 4, // pid
            5, 6, 7, 8, // key
        ]
    );
}

#[test]
fn copy_fail_and_data() {
    assert_eq!(serialize::copy_fail("oops"), [0x66, 0, 0, 0, 9, b'o', b'o', b'p', b's', 0]);
    assert_eq!(serialize::copy_data(&[9, 8]), [0x64, 0, 0, 0, 6, 9, 8]);
}

// ---------------------------------------------------------------------------
// parser side
// ---------------------------------------------------------------------------

fn be32(v: i32) -> [u8; 4] {
    v.to_be_bytes()
}

fn msg(code: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![code];
    out.extend_from_slice(&be32(body.len() as i32 + 4));
    out.extend_from_slice(body);
    out
}

#[test]
fn parse_ready_for_query() {
    let bytes = msg(b'Z', b"I");
    let mut p = Parser::new();
    let mut got = Vec::new();
    p.parse(&bytes, |m| got.push(m)).unwrap();
    assert_eq!(
        got,
        vec![BackendMessage::ReadyForQuery {
            length: 5,
            status: "I".into()
        }]
    );
}

#[test]
fn parse_command_complete_and_data_row() {
    let mut stream = Vec::new();
    // RowDescription: 1 field "n" oid 23
    let mut rd = Vec::new();
    rd.extend_from_slice(&1i16.to_be_bytes());
    rd.extend_from_slice(b"n\0");
    rd.extend_from_slice(&0u32.to_be_bytes()); // table
    rd.extend_from_slice(&0i16.to_be_bytes()); // col
    rd.extend_from_slice(&23u32.to_be_bytes()); // oid
    rd.extend_from_slice(&4i16.to_be_bytes()); // size
    rd.extend_from_slice(&(-1i32).to_be_bytes()); // modifier
    rd.extend_from_slice(&0i16.to_be_bytes()); // format text
    stream.extend_from_slice(&msg(b'T', &rd));
    // DataRow: one field "42"
    let mut dr = Vec::new();
    dr.extend_from_slice(&1i16.to_be_bytes());
    dr.extend_from_slice(&2i32.to_be_bytes());
    dr.extend_from_slice(b"42");
    stream.extend_from_slice(&msg(b'D', &dr));
    // CommandComplete "SELECT 1"
    stream.extend_from_slice(&msg(b'C', b"SELECT 1\0"));
    stream.extend_from_slice(&msg(b'Z', b"I"));

    let mut p = Parser::new();
    let mut got = Vec::new();
    p.parse(&stream, |m| got.push(m)).unwrap();
    assert_eq!(got.len(), 4);
    match &got[0] {
        BackendMessage::RowDescription { fields, .. } => {
            assert_eq!(fields[0].name, "n");
            assert_eq!(fields[0].data_type_id, 23);
        }
        m => panic!("expected rowDescription, got {:?}", m.name()),
    }
    match &got[1] {
        BackendMessage::DataRow { fields, .. } => {
            assert_eq!(fields[0].as_deref(), Some("42"));
        }
        m => panic!("expected dataRow, got {:?}", m.name()),
    }
    match &got[2] {
        BackendMessage::CommandComplete { text, .. } => assert_eq!(text, "SELECT 1"),
        m => panic!("expected commandComplete, got {:?}", m.name()),
    }
}

#[test]
fn parse_incremental_split() {
    // split inside a message — parser must hold state
    let mut stream = Vec::new();
    stream.extend_from_slice(&msg(b'Z', b"I"));
    stream.extend_from_slice(&msg(b'C', b"SELECT 7\0"));
    let mut p = Parser::new();
    let mut got = Vec::new();
    // feed byte-by-byte
    for (i, b) in stream.iter().enumerate() {
        let r = p.parse(&[*b], |m| got.push(m));
        assert!(r.is_ok(), "parse failed at byte {}", i);
    }
    assert_eq!(got.len(), 2);
}

#[test]
fn parse_error_and_notice() {
    // 'E' fields: S severity, C code, M message, each code byte + cstring, \0
    let mut body = Vec::new();
    body.extend_from_slice(b"SERROR\0");
    body.extend_from_slice(b"C42P01\0");
    body.extend_from_slice(b"Mbad thing\0");
    body.push(0);
    let bytes = msg(b'E', &body);
    let mut p = Parser::new();
    let mut got = Vec::new();
    p.parse(&bytes, |m| got.push(m)).unwrap();
    match &got[0] {
        BackendMessage::Error(e) => {
            assert_eq!(e.severity.as_deref(), Some("ERROR"));
            assert_eq!(e.code.as_deref(), Some("42P01"));
            assert_eq!(e.message.as_deref(), Some("bad thing"));
        }
        m => panic!("expected error, got {:?}", m.name()),
    }
}

#[test]
fn parse_notification() {
    let mut body = Vec::new();
    body.extend_from_slice(&777i32.to_be_bytes());
    body.extend_from_slice(b"chan\0");
    body.extend_from_slice(b"payload\0");
    let bytes = msg(b'A', &body);
    let mut p = Parser::new();
    let mut got = Vec::new();
    p.parse(&bytes, |m| got.push(m)).unwrap();
    match &got[0] {
        BackendMessage::Notification {
            process_id,
            channel,
            payload,
            ..
        } => {
            assert_eq!(*process_id, 777);
            assert_eq!(channel, "chan");
            assert_eq!(payload, "payload");
        }
        m => panic!("expected notification, got {:?}", m.name()),
    }
}
