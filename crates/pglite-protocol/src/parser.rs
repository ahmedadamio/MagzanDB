// PORT STATUS
// source: packages/pg-protocol/src/parser.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-protocol; JS differential tests pending
// open issues: none
//
// Behavioral notes preserved from the reference:
// - Incremental: incomplete message bytes persist across `parse` calls.
// - `length == 0` or an incomplete frame stops the loop and keeps buffering.
// - A `#handlePacket` failure resets the whole pending buffer, then throws.
// - Unknown message codes do NOT throw: they yield a DatabaseError named
//   `error` with `received invalid response: <hex>` via the callback.

use crate::messages::{
    BackendMessage, CopyResponse, ErrorNotice, Field,
};
use crate::reader::{BufferReader, ReadError};
use crate::Mode;

/// every message is prefixed with a single byte
const CODE_LENGTH: usize = 1;
/// every message has an int32 length which includes itself but does
/// NOT include the code in the length
const LEN_LENGTH: usize = 4;
const HEADER_LENGTH: usize = CODE_LENGTH + LEN_LENGTH;

mod codes {
    pub const DATA_ROW: u8 = 0x44; // D
    pub const PARSE_COMPLETE: u8 = 0x31; // 1
    pub const BIND_COMPLETE: u8 = 0x32; // 2
    pub const CLOSE_COMPLETE: u8 = 0x33; // 3
    pub const COMMAND_COMPLETE: u8 = 0x43; // C
    pub const READY_FOR_QUERY: u8 = 0x5a; // Z
    pub const NO_DATA: u8 = 0x6e; // n
    pub const NOTIFICATION_RESPONSE: u8 = 0x41; // A
    pub const AUTHENTICATION_RESPONSE: u8 = 0x52; // R
    pub const PARAMETER_STATUS: u8 = 0x53; // S
    pub const BACKEND_KEY_DATA: u8 = 0x4b; // K
    pub const ERROR_MESSAGE: u8 = 0x45; // E
    pub const NOTICE_MESSAGE: u8 = 0x4e; // N
    pub const ROW_DESCRIPTION: u8 = 0x54; // T
    pub const PARAMETER_DESCRIPTION: u8 = 0x74; // t
    pub const PORTAL_SUSPENDED: u8 = 0x73; // s
    pub const REPLICATION_START: u8 = 0x57; // W
    pub const EMPTY_QUERY: u8 = 0x49; // I
    pub const COPY_IN: u8 = 0x47; // G
    pub const COPY_OUT: u8 = 0x48; // H
    pub const COPY_DONE: u8 = 0x63; // c
    pub const COPY_DATA: u8 = 0x64; // d
}

#[derive(Debug)]
pub enum ParseError {
    /// Propagated body parse failure (TS: RangeError/other thrown out of
    /// `#handlePacket`). The pending buffer has already been reset.
    Read(ReadError),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Read(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for ParseError {}

impl From<ReadError> for ParseError {
    fn from(e: ReadError) -> Self {
        ParseError::Read(e)
    }
}

/// Incremental backend-message parser.
pub struct Parser {
    /// Byte buffer holding received-but-unconsumed data. `offset` marks the
    /// first unconsumed byte; `remaining` counts unconsumed bytes.
    buffer: Vec<u8>,
    buffer_offset: usize,
    buffer_remaining: usize,
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

impl Parser {
    pub fn new() -> Self {
        Parser {
            buffer: Vec::new(),
            buffer_offset: 0,
            buffer_remaining: 0,
        }
    }

    /// Feed bytes; invoke `callback` once per complete message.
    pub fn parse<F>(&mut self, bytes: &[u8], mut callback: F) -> Result<(), ParseError>
    where
        F: FnMut(BackendMessage),
    {
        self.merge_buffer(bytes);
        let buffer_full_length = self.buffer_offset + self.buffer_remaining;
        let mut offset = self.buffer_offset;
        while offset + HEADER_LENGTH <= buffer_full_length {
            let code = self.buffer[offset];
            let length = u32::from_be_bytes([
                self.buffer[offset + 1],
                self.buffer[offset + 2],
                self.buffer[offset + 3],
                self.buffer[offset + 4],
            ]);
            let full_message_length = CODE_LENGTH + length as usize;
            if full_message_length + offset <= buffer_full_length && length > 0 {
                let message = match self.handle_packet(offset + HEADER_LENGTH, code, length) {
                    Ok(m) => m,
                    Err(e) => {
                        self.reset_buffer();
                        return Err(e);
                    }
                };
                callback(message);
                offset += full_message_length;
            } else {
                break;
            }
        }
        if offset == buffer_full_length {
            self.reset_buffer();
        } else {
            self.buffer_remaining = buffer_full_length - offset;
            self.buffer_offset = offset;
        }
        Ok(())
    }

    /// Hard reset — used by the reference when a thrown `DatabaseError`
    /// abandons the stream (`execProtocol`/`execProtocolStream`).
    pub fn reset(&mut self) {
        self.reset_buffer();
    }

    fn reset_buffer(&mut self) {
        self.buffer = Vec::new();
        self.buffer_remaining = 0;
        self.buffer_offset = 0;
    }

    fn merge_buffer(&mut self, bytes: &[u8]) {
        if self.buffer_remaining > 0 {
            let new_length = self.buffer_remaining + bytes.len();
            let new_full_length = new_length + self.buffer_offset;
            if new_full_length > self.buffer.len() {
                // We can't concat the new buffer with the remaining one.
                if new_length <= self.buffer.len()
                    && self.buffer_offset >= self.buffer_remaining
                {
                    // Move the relevant part to the beginning of the buffer
                    // instead of allocating a new buffer.
                    self.buffer
                        .copy_within(self.buffer_offset..self.buffer_offset + self.buffer_remaining, 0);
                    // shrink is implied by cursor bookkeeping below
                } else {
                    // Allocate a new larger buffer
                    let mut new_buffer_length = self.buffer.len() * 2;
                    while new_length >= new_buffer_length {
                        new_buffer_length *= 2;
                    }
                    let mut new_buffer = vec![0; new_buffer_length];
                    new_buffer[..self.buffer_remaining].copy_from_slice(
                        &self.buffer[self.buffer_offset
                            ..self.buffer_offset + self.buffer_remaining],
                    );
                    self.buffer = new_buffer;
                }
                self.buffer_offset = 0;
            }

            // Concat the new buffer with the remaining one.
            let write_at = self.buffer_offset + self.buffer_remaining;
            // Ensure capacity — when the compact/grow branch ran the Vec is
            // already large enough; when it didn't, there was already room.
            if write_at + bytes.len() > self.buffer.len() {
                self.buffer.resize(write_at + bytes.len(), 0);
            }
            self.buffer[write_at..write_at + bytes.len()].copy_from_slice(bytes);
            self.buffer_remaining = new_length;
        } else {
            self.buffer = bytes.to_vec();
            self.buffer_offset = 0;
            self.buffer_remaining = bytes.len();
        }
    }

    fn handle_packet(
        &self,
        offset: usize,
        code: u8,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        match code {
            codes::BIND_COMPLETE => Ok(BackendMessage::BindComplete),
            codes::PARSE_COMPLETE => Ok(BackendMessage::ParseComplete),
            codes::CLOSE_COMPLETE => Ok(BackendMessage::CloseComplete),
            codes::NO_DATA => Ok(BackendMessage::NoData),
            codes::PORTAL_SUSPENDED => Ok(BackendMessage::PortalSuspended),
            codes::COPY_DONE => Ok(BackendMessage::CopyDone),
            codes::REPLICATION_START => Ok(BackendMessage::ReplicationStart),
            codes::EMPTY_QUERY => Ok(BackendMessage::EmptyQuery),
            codes::DATA_ROW => self.parse_data_row_message(offset, length),
            codes::COMMAND_COMPLETE => self.parse_command_complete_message(offset, length),
            codes::READY_FOR_QUERY => self.parse_ready_for_query_message(offset, length),
            codes::NOTIFICATION_RESPONSE => self.parse_notification_message(offset, length),
            codes::AUTHENTICATION_RESPONSE => {
                self.parse_authentication_response(offset, length)
            }
            codes::PARAMETER_STATUS => self.parse_parameter_status_message(offset, length),
            codes::BACKEND_KEY_DATA => self.parse_backend_key_data(offset, length),
            codes::ERROR_MESSAGE => self.parse_error_message(offset, length, true),
            codes::NOTICE_MESSAGE => self.parse_error_message(offset, length, false),
            codes::ROW_DESCRIPTION => self.parse_row_description_message(offset, length),
            codes::PARAMETER_DESCRIPTION => {
                self.parse_parameter_description_message(offset, length)
            }
            codes::COPY_IN => self.parse_copy_message(offset, length, true),
            codes::COPY_OUT => self.parse_copy_message(offset, length, false),
            codes::COPY_DATA => self.parse_copy_data(offset, length),
            _ => Ok(BackendMessage::Error(Box::new(ErrorNotice {
                length,
                message: Some(format!("received invalid response: {:x}", code)),
                ..Default::default()
            }))),
        }
    }

    fn body(&self, offset: usize) -> BufferReader<'_> {
        BufferReader::with_offset(&self.buffer, offset)
    }

    fn parse_ready_for_query_message(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let status = r.string(1)?;
        Ok(BackendMessage::ReadyForQuery { length, status })
    }

    fn parse_command_complete_message(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let text = r.cstring()?;
        Ok(BackendMessage::CommandComplete { length, text })
    }

    fn parse_copy_data(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        // `bytes.slice(offset, offset + (length - 4))`
        let end = offset + (length as usize).saturating_sub(4);
        let chunk = self
            .buffer
            .get(offset..end)
            .ok_or(ParseError::Read(ReadError("copy data out of bounds")))?
            .to_vec();
        Ok(BackendMessage::CopyData { length, chunk })
    }

    fn parse_copy_message(
        &self,
        offset: usize,
        length: u32,
        copy_in: bool,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let is_binary = r.byte()? != 0;
        let column_count = r.int16()?;
        let mut column_types = Vec::with_capacity(column_count.max(0) as usize);
        for _ in 0..column_count {
            column_types.push(r.int16()?);
        }
        let resp = CopyResponse {
            length,
            binary: is_binary,
            column_types,
        };
        Ok(if copy_in {
            BackendMessage::CopyInResponse(resp)
        } else {
            BackendMessage::CopyOutResponse(resp)
        })
    }

    fn parse_notification_message(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let process_id = r.int32()?;
        let channel = r.cstring()?;
        let payload = r.cstring()?;
        Ok(BackendMessage::Notification {
            length,
            process_id,
            channel,
            payload,
        })
    }

    fn parse_row_description_message(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let field_count = r.int16()?;
        let mut fields = Vec::with_capacity(field_count.max(0) as usize);
        for _ in 0..field_count {
            fields.push(Self::parse_field(&mut r)?);
        }
        Ok(BackendMessage::RowDescription { length, fields })
    }

    fn parse_field(r: &mut BufferReader<'_>) -> Result<Field, ParseError> {
        let name = r.cstring()?;
        let table_id = r.int32()? as u32;
        let column_id = r.int16()?;
        let data_type_id = r.int32()? as u32;
        let data_type_size = r.int16()?;
        let data_type_modifier = r.int32()?;
        let mode = Mode::from_int16(r.int16()?);
        Ok(Field {
            name,
            table_id,
            column_id,
            data_type_id,
            data_type_size,
            data_type_modifier,
            format: mode,
        })
    }

    fn parse_parameter_description_message(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let parameter_count = r.uint16()?;
        let mut data_type_ids = Vec::with_capacity(parameter_count as usize);
        for _ in 0..parameter_count {
            data_type_ids.push(r.int32()? as u32);
        }
        Ok(BackendMessage::ParameterDescription {
            length,
            data_type_ids,
        })
    }

    fn parse_data_row_message(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let field_count = r.int16()?;
        let mut fields = Vec::with_capacity(field_count.max(0) as usize);
        for _ in 0..field_count {
            let len = r.int32()?;
            // a -1 for length means the value of the field is null
            fields.push(if len == -1 {
                None
            } else {
                Some(r.string(len.max(0) as usize)?)
            });
        }
        Ok(BackendMessage::DataRow { length, fields })
    }

    fn parse_parameter_status_message(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let name = r.cstring()?;
        let value = r.cstring()?;
        Ok(BackendMessage::ParameterStatus {
            length,
            parameter_name: name,
            parameter_value: value,
        })
    }

    fn parse_backend_key_data(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let process_id = r.int32()?;
        let secret_key = r.int32()?;
        Ok(BackendMessage::BackendKeyData {
            length,
            process_id,
            secret_key,
        })
    }

    fn parse_authentication_response(
        &self,
        offset: usize,
        length: u32,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let code = r.int32()?;
        match code {
            0 => Ok(BackendMessage::AuthenticationOk { length }),
            3 => Ok(BackendMessage::AuthenticationCleartextPassword { length }),
            5 => Ok(BackendMessage::AuthenticationMD5Password {
                length,
                salt: r.bytes(4)?.to_vec(),
            }),
            10 => {
                let mut mechanisms = Vec::new();
                loop {
                    let mechanism = r.cstring()?;
                    if mechanism.is_empty() {
                        return Ok(BackendMessage::AuthenticationSasl {
                            length,
                            mechanisms,
                        });
                    }
                    mechanisms.push(mechanism);
                }
            }
            11 => Ok(BackendMessage::AuthenticationSaslContinue {
                length,
                data: r.string((length as usize).saturating_sub(8))?,
            }),
            12 => Ok(BackendMessage::AuthenticationSaslFinal {
                length,
                data: r.string((length as usize).saturating_sub(8))?,
            }),
            _ => Err(ParseError::Read(ReadError("unknown authenticationOk message type"))),
        }
    }

    /// Parses an `ErrorResponse` (is_error) or `NoticeResponse`.
    fn parse_error_message(
        &self,
        offset: usize,
        length: u32,
        is_error: bool,
    ) -> Result<BackendMessage, ParseError> {
        let mut r = self.body(offset);
        let mut fields = std::collections::HashMap::new();
        let mut field_type = r.string(1)?;
        while field_type != "\0" {
            let value = r.cstring()?;
            fields.insert(field_type, value);
            field_type = r.string(1)?;
        }
        let get = |k: &str| fields.get(k).cloned();
        let message = ErrorNotice {
            length,
            message: get("M"),
            severity: get("S"),
            code: get("C"),
            detail: get("D"),
            hint: get("H"),
            position: get("P"),
            internal_position: get("p"),
            internal_query: get("q"),
            where_: get("W"),
            schema: get("s"),
            table: get("t"),
            column: get("c"),
            data_type: get("d"),
            constraint: get("n"),
            file: get("F"),
            line: get("L"),
            routine: get("R"),
        };
        Ok(if is_error {
            BackendMessage::Error(Box::new(message))
        } else {
            BackendMessage::Notice(Box::new(message))
        })
    }
}
