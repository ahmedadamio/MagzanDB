// PORT STATUS
// source: packages/pglite/src/templating.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-core; adapter differential tests pending
// open issues: none

//! Port of the tagged-template helpers. `TemplateStringsArray` crosses the
//! boundary as `{strings, raw}` (the adapter captures `.raw` verbatim);
//! interpolated values may themselves be parts/containers (nested templates).

use crate::value::Value;

/// Values that can appear inside a template interpolation.
#[derive(Debug, Clone)]
pub enum TemplateValue {
    /// `identifier`/`raw` output — spliced into the string, not a param.
    Part(String),
    /// `sql` output — strings+values collapse in place.
    Container {
        strings: Vec<String>,
        raw: Vec<String>,
        values: Vec<TemplateValue>,
    },
    /// Ordinary param value.
    Plain(Value),
}

/// Result of `sql`/`identifier`/`raw`/`query` tag functions.
#[derive(Debug, Clone)]
pub struct TemplatedQuery {
    pub query: String,
    pub params: Vec<Value>,
}

fn add_to_last_and_push_with_suffix(arr: &mut Vec<String>, suffix: &str, values: &[String]) {
    let last_arr_idx = arr.len() - 1;
    let last_val_idx = values.len().wrapping_sub(1);

    // no-op
    if values.is_empty() {
        return;
    }

    // overwrite last element
    if values.len() == 1 {
        arr[last_arr_idx] = format!("{}{}{}", arr[last_arr_idx], values[0], suffix);
        return;
    }

    // sandwich values between array and suffix
    arr[last_arr_idx] = format!("{}{}", arr[last_arr_idx], values[0]);
    arr.extend_from_slice(&values[1..last_val_idx]);
    arr.push(format!("{}{}", values[last_val_idx], suffix));
}

/// `sql(strings, ...values)` — collapses nested parts/containers.
/// `strings`/`raw` are the cooked and raw halves of the template array.
pub fn sql_tag(strings: &[String], raw: &[String], values: Vec<TemplateValue>) -> (Vec<String>, Vec<String>, Vec<TemplateValue>) {
    let mut parsed_strings = vec![strings[0].clone()];
    let mut parsed_raw = vec![raw[0].clone()];
    let mut parsed_values: Vec<TemplateValue> = Vec::new();

    for (i, value) in values.into_iter().enumerate() {
        let next_string_idx = i + 1;
        let next_str = strings.get(next_string_idx).cloned().unwrap_or_default();
        let next_raw = raw.get(next_string_idx).cloned().unwrap_or_default();

        match value {
            // if value is a template tag, collapse into last string
            TemplateValue::Part(s) => {
                add_to_last_and_push_with_suffix(&mut parsed_strings, &next_str, &[s.clone()]);
                add_to_last_and_push_with_suffix(&mut parsed_raw, &next_raw, &[s]);
            }
            // if value is an output of `sql`, append in place
            TemplateValue::Container {
                strings: vstrings,
                raw: vraw,
                values: vvalues,
            } => {
                add_to_last_and_push_with_suffix(&mut parsed_strings, &next_str, &vstrings);
                add_to_last_and_push_with_suffix(&mut parsed_raw, &next_raw, &vraw);
                parsed_values.extend(vvalues);
            }
            // otherwise keep reconstructing
            TemplateValue::Plain(_) => {
                parsed_strings.push(next_str);
                parsed_raw.push(next_raw);
                parsed_values.push(TemplateValue::Plain(match value {
                    TemplateValue::Plain(v) => v,
                    _ => unreachable!(),
                }));
            }
        }
    }

    (parsed_strings, parsed_raw, parsed_values)
}

/// `identifier` — wrap text in double quotes (identifier position).
pub fn identifier(raw_joined: &str) -> TemplateValue {
    // `String.raw(strings, ...values)` is computed adapter-side and arrives
    // already joined.
    TemplateValue::Part(format!("\"{}\"", raw_joined))
}

/// `raw` — splice text verbatim.
pub fn raw_tag(raw_joined: &str) -> TemplateValue {
    TemplateValue::Part(raw_joined.to_string())
}

/// `query(strings, ...values)` → `{query, params}` with `$n` placeholders.
pub fn query(strings: &[String], raw: &[String], values: Vec<TemplateValue>) -> TemplatedQuery {
    let (parts, _raw, params) = sql_tag(strings, raw, values);
    let mut query = parts[0].clone();
    for (idx, param) in params.iter().enumerate() {
        query.push_str(&format!("${}", idx + 1));
        if let Some(next) = parts.get(idx + 1) {
            query.push_str(next);
        }
        let _ = param;
    }
    let params: Vec<Value> = params
        .into_iter()
        .map(|p| match p {
            TemplateValue::Plain(v) => v,
            _ => Value::Undefined,
        })
        .collect();
    TemplatedQuery { query, params }
}
