// PORT STATUS
// source: packages/pg-protocol/src/string-utils.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-protocol
// open issues: none — Rust strings are already UTF-8 so `byte_length_utf8` is
//              `str::len`; kept for callers that count UTF-16 text.

/// Port of `byteLengthUtf8`. In the TypeScript source this counts the UTF-8
/// length of a JS (UTF-16) string including surrogate-pair handling. Rust
/// `&str` is already UTF-8, so the length is `s.len()`; this helper remains
/// only where the caller's contract mirrors the TS signature.
pub fn byte_length_utf8(s: &str) -> usize {
    s.len()
}
