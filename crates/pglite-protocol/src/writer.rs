// PORT STATUS
// source: packages/pg-protocol/src/buffer-writer.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-protocol
// open issues: none
//
// PORT NOTE: the TS Writer keeps a fixed-size DataView it replaces on `flush`.
// This port keeps the identical layout (5-byte reserved header, same growth
// formula) over a `Vec<u8>` whose length tracks the allocated view size.

/// Growing buffer for building protocol messages.
/// Layout: `[code:1][length:i32][body…]` — `offset` starts at 5 to reserve the
/// header; `flush(code)` patches code+length and yields the finished message.
pub struct Writer {
    buf: Vec<u8>,
    offset: usize,
    size: usize,
}

const HEADER_POSITION: usize = 0;

impl Default for Writer {
    fn default() -> Self {
        Self::new(256)
    }
}

impl Writer {
    pub fn new(size: usize) -> Self {
        Writer {
            buf: vec![0; size],
            offset: 5,
            size,
        }
    }

    /// Exponential growth factor of around ~1.5, same as the reference.
    fn ensure(&mut self, size: usize) {
        let remaining = self.buf.len() - self.offset;
        if remaining < size {
            let new_size = self.buf.len() + (self.buf.len() >> 1) + size;
            self.buf.resize(new_size, 0);
        }
    }

    pub fn add_int32(&mut self, num: i32) -> &mut Self {
        self.ensure(4);
        self.buf[self.offset..self.offset + 4].copy_from_slice(&num.to_be_bytes());
        self.offset += 4;
        self
    }

    pub fn add_int16(&mut self, num: i16) -> &mut Self {
        self.ensure(2);
        self.buf[self.offset..self.offset + 2].copy_from_slice(&num.to_be_bytes());
        self.offset += 2;
        self
    }

    pub fn add_uint16(&mut self, num: u16) -> &mut Self {
        self.ensure(2);
        self.buf[self.offset..self.offset + 2].copy_from_slice(&num.to_be_bytes());
        self.offset += 2;
        self
    }

    pub fn add_cstring(&mut self, string: &str) -> &mut Self {
        if !string.is_empty() {
            self.add_string(string);
        }
        self.ensure(1);
        self.buf[self.offset] = 0;
        self.offset += 1;
        self
    }

    pub fn add_string(&mut self, string: &str) -> &mut Self {
        let bytes = string.as_bytes();
        self.ensure(bytes.len());
        self.buf[self.offset..self.offset + bytes.len()].copy_from_slice(bytes);
        self.offset += bytes.len();
        self
    }

    pub fn add(&mut self, other: &[u8]) -> &mut Self {
        self.ensure(other.len());
        self.buf[self.offset..self.offset + other.len()].copy_from_slice(other);
        self.offset += other.len();
        self
    }

    fn join(&mut self, code: Option<u8>) -> &[u8] {
        if let Some(code) = code {
            self.buf[HEADER_POSITION] = code;
            // length is everything in this packet minus the code
            let length = (self.offset - (HEADER_POSITION + 1)) as i32;
            self.buf[HEADER_POSITION + 1..HEADER_POSITION + 5]
                .copy_from_slice(&length.to_be_bytes());
        }
        let start = if code.is_some() { 0 } else { 5 };
        &self.buf[start..self.offset]
    }

    /// Patch the header and return the finished message; resets the buffer.
    pub fn flush(&mut self, code: Option<u8>) -> Vec<u8> {
        let result = self.join(code).to_vec();
        self.offset = 5;
        self.buf = vec![0; self.size];
        result
    }
}
