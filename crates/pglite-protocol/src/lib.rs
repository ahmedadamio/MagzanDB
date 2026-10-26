// PORT STATUS
// source: packages/pg-protocol/src/{index,types}.ts
// baseline: e752dbe (pglite monorepo)
// stage: implemented
// verification: cargo test -p pglite-protocol (native)
// open issues: none

pub mod messages;
pub mod parser;
pub mod reader;
pub mod serializer;
pub mod string_utils;
pub mod writer;

pub use messages::BackendMessage;
pub use parser::Parser;
pub use serializer::{serialize, LegalValue};

/// `packages/pg-protocol/src/types.ts` — `Modes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Text,
    Binary,
}

impl Mode {
    pub fn from_int16(v: i16) -> Mode {
        if v == 0 {
            Mode::Text
        } else {
            Mode::Binary
        }
    }
}
