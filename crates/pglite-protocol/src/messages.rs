// PORT STATUS
// source: packages/pg-protocol/src/messages.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-protocol
// open issues: JS class identity (instanceof DatabaseError/NoticeMessage) is
//              re-established at the JS boundary by the adapter.

use crate::Mode;

/// Discriminant mirroring the `name` property of every `BackendMessage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageName {
    ParseComplete,
    BindComplete,
    CloseComplete,
    NoData,
    PortalSuspended,
    ReplicationStart,
    EmptyQuery,
    CopyDone,
    CopyData,
    RowDescription,
    ParameterDescription,
    ParameterStatus,
    BackendKeyData,
    Notification,
    ReadyForQuery,
    CommandComplete,
    DataRow,
    CopyInResponse,
    CopyOutResponse,
    AuthenticationOk,
    AuthenticationMD5Password,
    AuthenticationCleartextPassword,
    AuthenticationSasl,
    AuthenticationSaslContinue,
    AuthenticationSaslFinal,
    Error,
    Notice,
}

impl MessageName {
    /// JS `name` string, e.g. `rowDescription`.
    pub fn as_str(self) -> &'static str {
        match self {
            MessageName::ParseComplete => "parseComplete",
            MessageName::BindComplete => "bindComplete",
            MessageName::CloseComplete => "closeComplete",
            MessageName::NoData => "noData",
            MessageName::PortalSuspended => "portalSuspended",
            MessageName::ReplicationStart => "replicationStart",
            MessageName::EmptyQuery => "emptyQuery",
            MessageName::CopyDone => "copyDone",
            MessageName::CopyData => "copyData",
            MessageName::RowDescription => "rowDescription",
            MessageName::ParameterDescription => "parameterDescription",
            MessageName::ParameterStatus => "parameterStatus",
            MessageName::BackendKeyData => "backendKeyData",
            MessageName::Notification => "notification",
            MessageName::ReadyForQuery => "readyForQuery",
            MessageName::CommandComplete => "commandComplete",
            MessageName::DataRow => "dataRow",
            MessageName::CopyInResponse => "copyInResponse",
            MessageName::CopyOutResponse => "copyOutResponse",
            MessageName::AuthenticationOk => "authenticationOk",
            MessageName::AuthenticationMD5Password => "authenticationMD5Password",
            MessageName::AuthenticationCleartextPassword => {
                "authenticationCleartextPassword"
            }
            MessageName::AuthenticationSasl => "authenticationSASL",
            MessageName::AuthenticationSaslContinue => "authenticationSASLContinue",
            MessageName::AuthenticationSaslFinal => "authenticationSASLFinal",
            MessageName::Error => "error",
            MessageName::Notice => "notice",
        }
    }
}

/// `Field` in messages.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub name: String,
    pub table_id: u32,
    pub column_id: i16,
    pub data_type_id: u32,
    pub data_type_size: i16,
    pub data_type_modifier: i32,
    pub format: Mode,
}

/// `CopyResponse` — shared shape of `copyInResponse`/`copyOutResponse`.
#[derive(Debug, Clone, PartialEq)]
pub struct CopyResponse {
    pub length: u32,
    pub binary: bool,
    pub column_types: Vec<i16>,
}

/// Shared field bag for `ErrorResponse` (`error`) and `NoticeResponse`
/// (`notice`). In the reference both classes expose identical `NoticeOrError`
/// properties; `NoticeMessage` is not an `Error` subclass, `DatabaseError` is.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ErrorNotice {
    pub length: u32,
    pub message: Option<String>,
    pub severity: Option<String>,
    pub code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub position: Option<String>,
    pub internal_position: Option<String>,
    pub internal_query: Option<String>,
    pub where_: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub column: Option<String>,
    pub data_type: Option<String>,
    pub constraint: Option<String>,
    pub file: Option<String>,
    pub line: Option<String>,
    pub routine: Option<String>,
}

impl std::fmt::Display for ErrorNotice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `DatabaseError extends Error`: `e.toString()` is `Error: <message>`
        // for name 'error' — the JS name property is 'error'/'notice'.
        f.write_str(self.message.as_deref().unwrap_or_default())
    }
}

impl std::error::Error for ErrorNotice {}

/// One backend message. `length` is the wire length field (includes itself,
/// excludes the 1-byte code) exactly as the reference exposes it.
#[derive(Debug, Clone, PartialEq)]
pub enum BackendMessage {
    ParseComplete,
    BindComplete,
    CloseComplete,
    NoData,
    PortalSuspended,
    ReplicationStart,
    EmptyQuery,
    CopyDone,
    AuthenticationOk {
        length: u32,
    },
    AuthenticationCleartextPassword {
        length: u32,
    },
    AuthenticationMD5Password {
        length: u32,
        salt: Vec<u8>,
    },
    AuthenticationSasl {
        length: u32,
        mechanisms: Vec<String>,
    },
    AuthenticationSaslContinue {
        length: u32,
        data: String,
    },
    AuthenticationSaslFinal {
        length: u32,
        data: String,
    },
    ParameterStatus {
        length: u32,
        parameter_name: String,
        parameter_value: String,
    },
    BackendKeyData {
        length: u32,
        process_id: i32,
        secret_key: i32,
    },
    Notification {
        length: u32,
        process_id: i32,
        channel: String,
        payload: String,
    },
    ReadyForQuery {
        length: u32,
        status: String,
    },
    CommandComplete {
        length: u32,
        text: String,
    },
    DataRow {
        length: u32,
        fields: Vec<Option<String>>,
    },
    RowDescription {
        length: u32,
        fields: Vec<Field>,
    },
    ParameterDescription {
        length: u32,
        data_type_ids: Vec<u32>,
    },
    CopyInResponse(CopyResponse),
    CopyOutResponse(CopyResponse),
    CopyData {
        length: u32,
        chunk: Vec<u8>,
    },
    /// `DatabaseError` in the reference (name `error`).
    Error(Box<ErrorNotice>),
    /// `NoticeMessage` in the reference (name `notice`).
    Notice(Box<ErrorNotice>),
}

impl BackendMessage {
    pub fn name(&self) -> MessageName {
        match self {
            BackendMessage::ParseComplete => MessageName::ParseComplete,
            BackendMessage::BindComplete => MessageName::BindComplete,
            BackendMessage::CloseComplete => MessageName::CloseComplete,
            BackendMessage::NoData => MessageName::NoData,
            BackendMessage::PortalSuspended => MessageName::PortalSuspended,
            BackendMessage::ReplicationStart => MessageName::ReplicationStart,
            BackendMessage::EmptyQuery => MessageName::EmptyQuery,
            BackendMessage::CopyDone => MessageName::CopyDone,
            BackendMessage::AuthenticationOk { .. } => MessageName::AuthenticationOk,
            BackendMessage::AuthenticationCleartextPassword { .. } => {
                MessageName::AuthenticationCleartextPassword
            }
            BackendMessage::AuthenticationMD5Password { .. } => {
                MessageName::AuthenticationMD5Password
            }
            BackendMessage::AuthenticationSasl { .. } => MessageName::AuthenticationSasl,
            BackendMessage::AuthenticationSaslContinue { .. } => {
                MessageName::AuthenticationSaslContinue
            }
            BackendMessage::AuthenticationSaslFinal { .. } => {
                MessageName::AuthenticationSaslFinal
            }
            BackendMessage::ParameterStatus { .. } => MessageName::ParameterStatus,
            BackendMessage::BackendKeyData { .. } => MessageName::BackendKeyData,
            BackendMessage::Notification { .. } => MessageName::Notification,
            BackendMessage::ReadyForQuery { .. } => MessageName::ReadyForQuery,
            BackendMessage::CommandComplete { .. } => MessageName::CommandComplete,
            BackendMessage::DataRow { .. } => MessageName::DataRow,
            BackendMessage::RowDescription { .. } => MessageName::RowDescription,
            BackendMessage::ParameterDescription { .. } => {
                MessageName::ParameterDescription
            }
            BackendMessage::CopyInResponse(_) => MessageName::CopyInResponse,
            BackendMessage::CopyOutResponse(_) => MessageName::CopyOutResponse,
            BackendMessage::CopyData { .. } => MessageName::CopyData,
            BackendMessage::Error(_) => MessageName::Error,
            BackendMessage::Notice(_) => MessageName::Notice,
        }
    }
}
