// PORT STATUS
// source: packages/pg-protocol/src/serializer.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-protocol; JS differential tests pending
// open issues: `valueMapper` callback is a JS-side hook; represented here as
//              `Option<&dyn ValueMapper>`.

use crate::writer::Writer;

mod code {
    pub const STARTUP: u8 = 0x70; // 'p'
    pub const QUERY: u8 = 0x51; // 'Q'
    pub const PARSE: u8 = 0x50; // 'P'
    pub const BIND: u8 = 0x42; // 'B'
    pub const EXECUTE: u8 = 0x45; // 'E'
    pub const FLUSH: u8 = 0x48; // 'H'
    pub const SYNC: u8 = 0x53; // 'S'
    pub const END: u8 = 0x58; // 'X'
    pub const CLOSE: u8 = 0x43; // 'C'
    pub const DESCRIBE: u8 = 0x44; // 'D'
    pub const COPY_FROM_CHUNK: u8 = 0x64; // 'd'
    pub const COPY_DONE: u8 = 0x63; // 'c'
    pub const COPY_FAIL: u8 = 0x66; // 'f'
}

/// `LegalValue = string | ArrayBuffer | ArrayBufferView | null`
#[derive(Debug, Clone, PartialEq)]
pub enum LegalValue {
    Null,
    Text(String),
    Binary(Vec<u8>),
}

/// `ValueMapper = (param: unknown, index: number) => LegalValue`
pub trait ValueMapper {
    fn map(&self, param: &LegalValue, index: usize) -> LegalValue;
}

impl<F> ValueMapper for F
where
    F: Fn(&LegalValue, usize) -> LegalValue,
{
    fn map(&self, param: &LegalValue, index: usize) -> LegalValue {
        self(param, index)
    }
}

const PARAM_TYPE_STRING: i16 = 0;
const PARAM_TYPE_BINARY: i16 = 1;

pub struct ParseOpts<'a> {
    pub name: Option<&'a str>,
    pub types: Option<&'a [u32]>,
    pub text: &'a str,
}

pub struct BindOpts<'a> {
    pub portal: Option<&'a str>,
    pub binary: bool,
    pub statement: Option<&'a str>,
    pub values: &'a [LegalValue],
    pub value_mapper: Option<&'a dyn ValueMapper>,
}

impl<'a> Default for BindOpts<'a> {
    fn default() -> Self {
        BindOpts {
            portal: None,
            binary: false,
            statement: None,
            values: &[],
            value_mapper: None,
        }
    }
}

#[derive(Default)]
pub struct ExecOpts<'a> {
    pub portal: Option<&'a str>,
    pub rows: Option<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PortalType {
    Statement, // 'S'
    Portal,    // 'P'
}

pub struct PortalOpts<'a> {
    pub r#type: PortalType,
    pub name: Option<&'a str>,
}

/// The `serialize` namespace from the reference. State is internal; every
/// call produces identical bytes to the TS implementation.
pub mod serialize {
    use super::*;

    pub fn startup(opts: &[(String, String)]) -> Vec<u8> {
        let mut writer = Writer::default();
        // protocol version
        writer.add_int16(3).add_int16(0);
        for (key, value) in opts {
            writer.add_cstring(key).add_cstring(value);
        }
        writer
            .add_cstring("client_encoding")
            .add_cstring("UTF8");
        let body_buffer = writer.add_cstring("").flush(None);
        // this message is sent without a code
        let length = (body_buffer.len() + 4) as i32;
        let mut w = Writer::default();
        w.add_int32(length).add(&body_buffer);
        w.flush(None)
    }

    pub fn request_ssl() -> Vec<u8> {
        let mut out = Vec::with_capacity(8);
        out.extend_from_slice(&8i32.to_be_bytes());
        out.extend_from_slice(&80877103i32.to_be_bytes());
        out
    }

    pub fn password(password: &str) -> Vec<u8> {
        let mut w = Writer::default();
        w.add_cstring(password).flush(Some(code::STARTUP))
    }

    pub fn send_sasl_initial_response_message(
        mechanism: &str,
        initial_response: &str,
    ) -> Vec<u8> {
        let mut w = Writer::default();
        w.add_cstring(mechanism)
            .add_int32(initial_response.len() as i32)
            .add_string(initial_response);
        w.flush(Some(code::STARTUP))
    }

    pub fn send_scram_client_final_message(additional_data: &str) -> Vec<u8> {
        let mut w = Writer::default();
        w.add_string(additional_data).flush(Some(code::STARTUP))
    }

    pub fn query(text: &str) -> Vec<u8> {
        let mut w = Writer::default();
        w.add_cstring(text).flush(Some(code::QUERY))
    }

    // TODO(port): the reference emits `console.error` warnings when the
    // statement name exceeds 63 chars. The Rust side returns the flag so the
    // adapter can reproduce the side channel.
    pub fn parse(query: &ParseOpts<'_>) -> (Vec<u8>, bool) {
        let name = query.name.unwrap_or("");
        let name_too_long = name.len() > 63;
        let mut writer = Writer::default();
        writer
            .add_cstring(name)
            .add_cstring(query.text)
            .add_int16(query.types.map(|t| t.len() as i16).unwrap_or(0));
        if let Some(types) = query.types {
            for t in types {
                writer.add_int32(*t as i32);
            }
        }
        (writer.flush(Some(code::PARSE)), name_too_long)
    }

    fn write_values(
        writer: &mut Writer,
        param_writer: &mut Writer,
        values: &[LegalValue],
        value_mapper: Option<&dyn ValueMapper>,
    ) {
        for (i, value) in values.iter().enumerate() {
            let owned;
            let mapped_val = match value_mapper {
                Some(m) => {
                    owned = m.map(value, i);
                    &owned
                }
                None => value,
            };
            match mapped_val {
                LegalValue::Null => {
                    // add the param type (string) to the writer
                    writer.add_int16(PARAM_TYPE_STRING);
                    // write -1 to the param writer to indicate null
                    param_writer.add_int32(-1);
                }
                LegalValue::Binary(buffer) => {
                    // add the param type (binary) to the writer
                    writer.add_int16(PARAM_TYPE_BINARY);
                    param_writer.add_int32(buffer.len() as i32);
                    param_writer.add(buffer);
                }
                LegalValue::Text(s) => {
                    writer.add_int16(PARAM_TYPE_STRING);
                    param_writer.add_int32(s.len() as i32);
                    param_writer.add_string(s);
                }
            }
        }
    }

    pub fn bind(config: &BindOpts<'_>) -> Vec<u8> {
        let portal = config.portal.unwrap_or("");
        let statement = config.statement.unwrap_or("");
        let binary = config.binary;
        let values = config.values;
        let len = values.len();

        let mut writer = Writer::default();
        let mut param_writer = Writer::default();

        writer.add_cstring(portal).add_cstring(statement);
        writer.add_uint16(len as u16);

        write_values(&mut writer, &mut param_writer, values, config.value_mapper);

        writer.add_uint16(len as u16);
        let params = param_writer.flush(None);
        writer.add(&params);

        // format code
        writer.add_int16(if binary {
            PARAM_TYPE_BINARY
        } else {
            PARAM_TYPE_STRING
        });
        writer.flush(Some(code::BIND))
    }

    pub fn execute(config: Option<&ExecOpts<'_>>) -> Vec<u8> {
        // happy path for most queries
        if config.is_none()
            || (config.unwrap().portal.is_none() && config.unwrap().rows.is_none())
        {
            return EMPTY_EXECUTE.to_vec();
        }
        let config = config.unwrap();
        let portal = config.portal.unwrap_or("");
        let rows = config.rows.unwrap_or(0);

        let portal_length = portal.len();
        let len = 4 + portal_length + 1 + 4;
        let mut buffer = vec![0u8; 1 + len];
        buffer[0] = code::EXECUTE;
        buffer[1..5].copy_from_slice(&(len as i32).to_be_bytes());
        buffer[5..5 + portal_length].copy_from_slice(portal.as_bytes());
        buffer[portal_length + 5] = 0; // null terminate portal cString
        let n = buffer.len();
        buffer[n - 4..].copy_from_slice(&rows.to_be_bytes());
        buffer
    }

    pub fn cancel(process_id: i32, secret_key: i32) -> Vec<u8> {
        let mut buffer = Vec::with_capacity(16);
        buffer.extend_from_slice(&16i32.to_be_bytes());
        buffer.extend_from_slice(&1234i16.to_be_bytes());
        buffer.extend_from_slice(&5678i16.to_be_bytes());
        buffer.extend_from_slice(&process_id.to_be_bytes());
        buffer.extend_from_slice(&secret_key.to_be_bytes());
        buffer
    }

    fn cstring_message(code: u8, string: &str) -> Vec<u8> {
        let mut w = Writer::default();
        w.add_cstring(string);
        w.flush(Some(code))
    }

    pub fn describe(msg: &PortalOpts<'_>) -> Vec<u8> {
        match msg.name {
            Some(name) => {
                let type_char = match msg.r#type {
                    PortalType::Statement => 'S',
                    PortalType::Portal => 'P',
                };
                cstring_message(code::DESCRIBE, &format!("{}{}", type_char, name))
            }
            None => match msg.r#type {
                PortalType::Portal => EMPTY_DESCRIBE_PORTAL.to_vec(),
                PortalType::Statement => EMPTY_DESCRIBE_STATEMENT.to_vec(),
            },
        }
    }

    pub fn close(msg: &PortalOpts<'_>) -> Vec<u8> {
        let type_char = match msg.r#type {
            PortalType::Statement => 'S',
            PortalType::Portal => 'P',
        };
        let text = format!("{}{}", type_char, msg.name.unwrap_or(""));
        cstring_message(code::CLOSE, &text)
    }

    pub fn copy_data(chunk: &[u8]) -> Vec<u8> {
        let mut w = Writer::default();
        w.add(chunk).flush(Some(code::COPY_FROM_CHUNK))
    }

    pub fn copy_fail(message: &str) -> Vec<u8> {
        cstring_message(code::COPY_FAIL, message)
    }

    const fn code_only_buffer(code: u8) -> [u8; 5] {
        [code, 0x00, 0x00, 0x00, 0x04]
    }

    const EMPTY_EXECUTE: [u8; 10] = [0x45, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00];
    const EMPTY_DESCRIBE_PORTAL: [u8; 7] = [code::DESCRIBE, 0, 0, 0, 6, b'P', 0];
    const EMPTY_DESCRIBE_STATEMENT: [u8; 7] = [code::DESCRIBE, 0, 0, 0, 6, b'S', 0];
    const FLUSH_BUFFER: [u8; 5] = code_only_buffer(code::FLUSH);
    const SYNC_BUFFER: [u8; 5] = code_only_buffer(code::SYNC);
    const END_BUFFER: [u8; 5] = code_only_buffer(code::END);
    const COPY_DONE_BUFFER: [u8; 5] = code_only_buffer(code::COPY_DONE);

    pub fn flush() -> Vec<u8> {
        FLUSH_BUFFER.to_vec()
    }

    pub fn sync() -> Vec<u8> {
        SYNC_BUFFER.to_vec()
    }

    pub fn end() -> Vec<u8> {
        END_BUFFER.to_vec()
    }

    pub fn copy_done() -> Vec<u8> {
        COPY_DONE_BUFFER.to_vec()
    }
}
