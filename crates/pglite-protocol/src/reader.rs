// PORT STATUS
// source: packages/pg-protocol/src/buffer-reader.ts
// baseline: e752dbe
// stage: implemented
// verification: cargo test -p pglite-protocol
// open issues: none
//
// PORT NOTE: the TS reader decodes with `TextDecoder('utf-8')` whose default
// is lossy (U+FFFD for malformed input); `String::from_utf8_lossy` matches.
// Out-of-bounds reads in TS throw a RangeError that propagates out of
// `Parser.parse` after a buffer reset — here they surface as `Err(ReadError)`
// which `Parser::parse` handles identically.

/// Error returned when a read would pass the end of the buffer.
/// Equivalent to the RangeError thrown by `DataView` reads in the reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadError(pub &'static str);

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for ReadError {}

pub struct BufferReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BufferReader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        BufferReader { bytes, offset: 0 }
    }

    /// Equivalent to `setBuffer(offset, buffer)` in the reference.
    pub fn with_offset(bytes: &'a [u8], offset: usize) -> Self {
        BufferReader { bytes, offset }
    }

    pub fn int16(&mut self) -> Result<i16, ReadError> {
        let b = self.take(2)?;
        Ok(i16::from_be_bytes([b[0], b[1]]))
    }

    pub fn uint16(&mut self) -> Result<u16, ReadError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    pub fn byte(&mut self) -> Result<u8, ReadError> {
        Ok(self.take(1)?[0])
    }

    pub fn int32(&mut self) -> Result<i32, ReadError> {
        let b = self.take(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn string(&mut self, length: usize) -> Result<String, ReadError> {
        let b = self.take(length)?;
        Ok(String::from_utf8_lossy(b).into_owned())
    }

    pub fn cstring(&mut self) -> Result<String, ReadError> {
        let start = self.offset;
        let mut end = start;
        loop {
            match self.bytes.get(end) {
                Some(&b) if b != 0 => end += 1,
                Some(_) => break,
                None => return Err(ReadError("unterminated cstring")),
            }
        }
        let result = String::from_utf8_lossy(&self.bytes[start..end]).into_owned();
        self.offset = end + 1;
        Ok(result)
    }

    pub fn bytes(&mut self, length: usize) -> Result<&'a [u8], ReadError> {
        self.take(length)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], ReadError> {
        let end = self.offset.checked_add(n).ok_or(ReadError("overflow"))?;
        let slice = self
            .bytes
            .get(self.offset..end)
            .ok_or(ReadError("read past end of buffer"))?;
        self.offset = end;
        Ok(slice)
    }
}
