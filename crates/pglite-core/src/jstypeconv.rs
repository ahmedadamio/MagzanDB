// PORT STATUS
// source: implicit JS coercions used by types.ts/base.ts (`+x`, `x.toString()`,
//         `new Date(x).toISOString()`)
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-core
// open issues: TODO(port): `js_to_string(Date)` — JS `Date.prototype.toString`
//              ("Wed Oct 23 …") differs from ISO; adapter-side values should
//              pre-stringify Date params when no serializer matches.

//! JavaScript-compatible number/string conversions needed by the ported
//! serializers. These must match ECMA-262, not Rust defaults:
//! - `f64::to_string` never uses exponent notation (JS does outside
//!   1e-6 ≤ |n| < 1e21) and prints `-0` (JS prints `0`).
//! - `f64::from_str` rejects leading whitespace, `""`, hex/octal/binary,
//!   `Infinity` (bare), etc. that `Number(x)` accepts.

use crate::value::Value;

/// `Number(x)` / `+x` for string input (ECMA-262 StrToNumber).
pub fn str_to_number(s: &str) -> f64 {
    // StringNumericLiteral: trim leading/trailing whitespace.
    let t = s.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return 0.0;
    }
    if t == "Infinity" || t == "+Infinity" {
        return f64::INFINITY;
    }
    if t == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    let (sign, body) = match t.strip_prefix('-') {
        Some(b) => (-1.0, b),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    // Non-decimal integer literals.
    if let Some(rest) = body
        .strip_prefix("0x")
        .or_else(|| body.strip_prefix("0X"))
    {
        return sign
            * i128::from_str_radix(rest, 16)
                .map(|v| v as f64)
                .unwrap_or(f64::NAN);
    }
    if let Some(rest) = body
        .strip_prefix("0o")
        .or_else(|| body.strip_prefix("0O"))
    {
        return sign
            * i128::from_str_radix(rest, 8)
                .map(|v| v as f64)
                .unwrap_or(f64::NAN);
    }
    if let Some(rest) = body
        .strip_prefix("0b")
        .or_else(|| body.strip_prefix("0B"))
    {
        return sign
            * i128::from_str_radix(rest, 2)
                .map(|v| v as f64)
                .unwrap_or(f64::NAN);
    }
    // Decimal grammar: [digits][.digits][e[+-]digits] with optional leading '.'
    if !is_valid_decimal(body) {
        return f64::NAN;
    }
    sign * body.parse::<f64>().unwrap_or(f64::NAN)
}

fn is_valid_decimal(s: &str) -> bool {
    let mut chars = s.chars().peekable();
    let mut digits = false;
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            digits = true;
            chars.next();
        } else {
            break;
        }
    }
    if chars.peek() == Some(&'.') {
        chars.next();
        while let Some(&c) = chars.peek() {
            if c.is_ascii_digit() {
                digits = true;
                chars.next();
            } else {
                break;
            }
        }
    }
    if !digits {
        return false;
    }
    if let Some(&c) = chars.peek() {
        if c == 'e' || c == 'E' {
            chars.next();
            if matches!(chars.peek(), Some('+') | Some('-')) {
                chars.next();
            }
            let mut exp_digits = false;
            while let Some(&c) = chars.peek() {
                if c.is_ascii_digit() {
                    exp_digits = true;
                    chars.next();
                } else {
                    return false;
                }
            }
            return exp_digits;
        }
        return false;
    }
    true
}

/// Public wrapper for `is_js_whitespace` (used by `parseInt` semantics in
/// results.rs).
pub fn is_js_whitespace_pub(c: char) -> bool {
    is_js_whitespace(c)
}

fn is_js_whitespace(c: char) -> bool {
    // ECMA-262 WhiteSpace + LineTerminator set.
    matches!(
        c,
        '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
            | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}'
            | '\u{205F}' | '\u{3000}' | '\u{FEFF}' | '\n' | '\r'
    )
}

/// `Number.prototype.toString(x)` (radix 10) — ECMA-262 §20.1.3.6.
/// Produces JS formatting incl. exponent thresholds and `-0` → `"0"`.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    if n == f64::INFINITY {
        return "Infinity".to_string();
    }
    if n == f64::NEG_INFINITY {
        return "-Infinity".to_string();
    }
    let neg = n < 0.0;
    let x = n.abs();

    // Shortest round-trip decimal digits + exponent.
    let (digits, exp10) = shortest_digits(x);
    let k = digits.len() as i32; // k = number of significant digits
    let n_exp = exp10; // decimal point sits after position `n_exp`

    let mut s = String::new();
    if k <= n_exp && n_exp <= 21 {
        // digits followed by (n_exp - k) zeros
        s.push_str(&digits);
        for _ in 0..(n_exp - k) {
            s.push('0');
        }
    } else if 0 < n_exp && n_exp <= 21 {
        s.push_str(&digits[..n_exp as usize]);
        s.push('.');
        s.push_str(&digits[n_exp as usize..]);
    } else if -6 < n_exp && n_exp <= 0 {
        s.push_str("0.");
        for _ in 0..(-n_exp) {
            s.push('0');
        }
        s.push_str(&digits);
    } else if k == 1 {
        s.push_str(&digits);
        s.push('e');
        s.push_str(if n_exp - 1 >= 0 { "+" } else { "-" });
        s.push_str(&(n_exp - 1).abs().to_string());
    } else {
        s.push_str(&digits[..1]);
        s.push('.');
        s.push_str(&digits[1..]);
        s.push('e');
        s.push_str(if n_exp - 1 >= 0 { "+" } else { "-" });
        s.push_str(&(n_exp - 1).abs().to_string());
    }
    if neg {
        format!("-{}", s)
    } else {
        s
    }
}

/// Shortest round-trip decimal representation → (digit string, exponent such
/// that value ≈ 0.digits × 10^exp with the point after the first digit, i.e.
/// digits[0] is the most significant). `exp10` is the ECMA-262 `n`: the power
/// of the digit after the decimal point position, i.e. value =
/// digits × 10^(exp10 - len(digits)) with point after digit `exp10`.
fn shortest_digits(x: f64) -> (String, i32) {
    // Use Rust's shortest round-trip formatter, then re-express as digits+exp.
    let repr = format!("{:e}", x); // e.g. "1.2345e7", "5e0", "2.5e-3"
    let (mantissa, exp) = repr.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    // value = digits[0].digits[1..] × 10^exp → point after `exp + 1` digits
    (digits, exp + 1)
}

/// `x.toString()` for the param fallback in `#runQuery` — when no serializer
/// matches a param, the reference calls JS `.toString()` on it.
pub fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Undefined => "undefined".to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => number_to_string(*n),
        Value::BigInt(s) => s.clone(),
        Value::String(s) => s.clone(),
        // Uint8Array.prototype.toString() → comma-joined bytes ("1,2,3").
        Value::Bytes(b) => b
            .iter()
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join(","),
        // TODO(port): JS Date.toString() is "Www Mmm DD YYYY HH:mm:ss GMT±…".
        // The adapter should stringify Date params itself when it cannot use
        // the date serializer; retained here only as a fallback.
        Value::Date(crate::value::DateRepr::FromString(s)) => s.clone(),
        Value::Date(crate::value::DateRepr::FromMillis(ms)) => {
            epoch_millis_to_iso(*ms)
        }
        Value::Json(j) => j.to_string(),
        // Array.prototype.toString() → join(',')
        Value::Array(xs) => xs.iter().map(js_to_string).collect::<Vec<_>>().join(","),
        // Object.prototype.toString() → "[object Object]"
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `new Date(ms).toISOString()` — epoch millis → `YYYY-MM-DDTHH:mm:ss.sssZ`.
/// Implemented without a date dependency (deterministic civil conversion).
pub fn epoch_millis_to_iso(ms: f64) -> String {
    if !ms.is_finite() {
        // Invalid Date has no toISOString (throws RangeError in JS); callers
        // mapping this path should treat it as a serialize error.
        return "Invalid Date".to_string();
    }
    let days_ms = ms.rem_euclid(86_400_000.0);
    let days = ms.div_euclid(86_400_000.0) as i64;
    let millis = (days_ms % 1000.0) as u32;
    let secs = (days_ms / 1000.0) as u32;
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, mo, d, h, m, s, millis
    )
}

/// Howard Hinnant's civil_from_days — days since 1970-01-01 → (y, m, d).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
