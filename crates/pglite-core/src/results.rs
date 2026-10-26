// PORT STATUS
// source: packages/pglite/src/parse.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-core; adapter differential tests pending
// open issues: none

use crate::types::{parse_type, CodecError, HostCallbacks, ParserOverrides};
use crate::value::Value;
use pglite_protocol::messages::BackendMessage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowMode {
    Object,
    Array,
}

/// `{ name, dataTypeID }` in RowDescription order.
#[derive(Debug, Clone)]
pub struct ResultField {
    pub name: String,
    pub data_type_id: u32,
}

/// `Results<T>` — `rows` keeps raw `Vec<Value>` per row; object materialization
/// (`Object.fromEntries`, incl. duplicate-name last-wins) happens at the JS
/// boundary so JS property-order/override semantics are preserved verbatim.
#[derive(Debug, Clone)]
pub struct Results {
    pub rows: Vec<Vec<Value>>,
    pub affected_rows: i64,
    pub command: Option<String>,
    /// Present only when the command tag carried a numeric row count.
    pub row_count: Option<i64>,
    pub fields: Vec<ResultField>,
    /// Set when the query produced a `/dev/blob` payload (COPY binary etc).
    /// The blob itself stays host-side; this flag gates the property.
    pub has_blob: bool,
}

/// `parseResults(messages, defaultParsers, options, blob)` — builds one
/// `Results` per `commandComplete`.
pub fn parse_results(
    messages: &[BackendMessage],
    parsers: &ParserOverrides,
    row_mode: RowMode,
    blob: bool,
    host: &dyn HostCallbacks,
) -> Result<Vec<Results>, CodecError> {
    let mut result_sets: Vec<Results> = Vec::new();
    let mut current: Results = Results {
        rows: Vec::new(),
        affected_rows: 0,
        command: None,
        row_count: None,
        fields: Vec::new(),
        has_blob: false,
    };
    let mut affected_rows: i64 = 0;

    for message in messages {
        match message {
            BackendMessage::RowDescription { fields, .. } => {
                current.fields = fields
                    .iter()
                    .map(|f| ResultField {
                        name: f.name.clone(),
                        data_type_id: f.data_type_id,
                    })
                    .collect();
            }
            BackendMessage::DataRow { fields: row_fields, .. } => {
                match row_mode {
                    RowMode::Array => {
                        let mut row = Vec::with_capacity(row_fields.len());
                        for (i, field) in row_fields.iter().enumerate() {
                            let oid = current
                                .fields
                                .get(i)
                                .map(|f| f.data_type_id)
                                .unwrap_or(0);
                            row.push(parse_type(
                                field.as_deref(),
                                oid,
                                parsers,
                                host,
                            )?);
                        }
                        current.rows.push(row);
                    }
                    RowMode::Object => {
                        let mut row = Vec::with_capacity(row_fields.len());
                        for (i, field) in row_fields.iter().enumerate() {
                            let oid = current
                                .fields
                                .get(i)
                                .map(|f| f.data_type_id)
                                .unwrap_or(0);
                            row.push(parse_type(
                                field.as_deref(),
                                oid,
                                parsers,
                                host,
                            )?);
                        }
                        current.rows.push(row);
                    }
                }
            }
            BackendMessage::CommandComplete { text, .. } => {
                // A command tag that carries a row count ends in it
                // ("SELECT 2", "UPDATE 3", "INSERT 0 5"); all other tags end
                // in a word ("CREATE TABLE").
                let parts: Vec<&str> = text.split(' ').collect();
                let command = parts[0];
                let row_count = parse_int10(parts[parts.len() - 1]);

                match command {
                    "INSERT" | "UPDATE" | "DELETE" | "COPY" | "MERGE" => {
                        if let Some(rc) = row_count {
                            affected_rows += rc;
                        }
                    }
                    _ => {}
                }

                let result = Results {
                    command: Some(command.to_string()),
                    affected_rows,
                    row_count,
                    has_blob: blob,
                    rows: std::mem::take(&mut current.rows),
                    fields: std::mem::take(&mut current.fields),
                };
                result_sets.push(result);
                current = Results {
                    rows: Vec::new(),
                    affected_rows: 0,
                    command: None,
                    row_count: None,
                    fields: Vec::new(),
                    has_blob: false,
                };
            }
            _ => {}
        }
    }

    if result_sets.is_empty() {
        result_sets.push(Results {
            rows: Vec::new(),
            affected_rows: 0,
            command: None,
            row_count: None,
            fields: Vec::new(),
            has_blob: false,
        });
    }

    Ok(result_sets)
}

/// `parseInt(s, 10)` — JS semantics differ from `str::parse`: leading
/// whitespace ok, stops at first invalid char, `""`/all-invalid → NaN.
fn parse_int10(s: &str) -> Option<i64> {
    let t = s.trim_start_matches(crate::jstypeconv::is_js_whitespace_pub);
    let (neg, body) = if let Some(b) = t.strip_prefix('-') {
        (true, b)
    } else {
        (false, t.strip_prefix('+').unwrap_or(t))
    };
    let digits: String = body.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits
        .parse::<i64>()
        .ok()
        .map(|v| if neg { -v } else { v })
        // JS parseInt can exceed i64 — saturate (count fields realistically fit).
        .or(Some(if neg { i64::MIN } else { i64::MAX }))
}

/// `parseDescribeStatementResults` — first ParameterDescription's OIDs.
pub fn parse_describe_statement_results(messages: &[BackendMessage]) -> Vec<u32> {
    for m in messages {
        if let BackendMessage::ParameterDescription { data_type_ids, .. } = m {
            return data_type_ids.clone();
        }
    }
    Vec::new()
}
