//! Little-endian binary reader over a decompressed GVAS blob. Mirrors the
//! primitive readers in cheahjs/palworld-save-tools `archive.py` (which is the
//! correct reference for GVAS property *encoding*, even though its compression
//! handling is stale).

use pal_data::types::Guid;

use crate::SaveError;

/// Cursor over an in-memory GVAS blob. Never allocates for reads; slices point
/// back into the borrowed buffer.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    #[inline]
    pub fn pos(&self) -> usize {
        self.pos
    }

    #[inline]
    pub fn eof(&self) -> bool {
        self.pos >= self.buf.len()
    }

    #[inline]
    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    #[inline]
    fn take(&mut self, n: usize) -> Result<&'a [u8], SaveError> {
        let end = self.pos.checked_add(n).ok_or_else(|| {
            SaveError::Gvas(format!("read overflow: {n} bytes at {}", self.pos))
        })?;
        if end > self.buf.len() {
            return Err(SaveError::Gvas(format!(
                "unexpected eof: need {n} bytes at offset {}, buffer len {}",
                self.pos,
                self.buf.len()
            )));
        }
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    #[inline]
    pub fn skip(&mut self, n: usize) -> Result<(), SaveError> {
        self.take(n).map(|_| ())
    }

    #[inline]
    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], SaveError> {
        self.take(n)
    }

    #[inline]
    pub fn u8(&mut self) -> Result<u8, SaveError> {
        Ok(self.take(1)?[0])
    }

    #[inline]
    pub fn bool(&mut self) -> Result<bool, SaveError> {
        Ok(self.u8()? != 0)
    }

    #[inline]
    pub fn u16(&mut self) -> Result<u16, SaveError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    #[inline]
    pub fn i16(&mut self) -> Result<i16, SaveError> {
        Ok(self.u16()? as i16)
    }

    #[inline]
    pub fn u32(&mut self) -> Result<u32, SaveError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    #[inline]
    pub fn i32(&mut self) -> Result<i32, SaveError> {
        Ok(self.u32()? as i32)
    }

    #[inline]
    pub fn u64(&mut self) -> Result<u64, SaveError> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    #[inline]
    pub fn i64(&mut self) -> Result<i64, SaveError> {
        Ok(self.u64()? as i64)
    }

    #[inline]
    pub fn f32(&mut self) -> Result<f32, SaveError> {
        Ok(f32::from_bits(self.u32()?))
    }

    #[inline]
    pub fn f64(&mut self) -> Result<f64, SaveError> {
        Ok(f64::from_bits(self.u64()?))
    }

    #[inline]
    pub fn guid(&mut self) -> Result<Guid, SaveError> {
        let b = self.take(16)?;
        let mut g = [0u8; 16];
        g.copy_from_slice(b);
        Ok(g)
    }

    /// A GVAS "optional guid": one flag byte, followed by 16 bytes iff set.
    #[inline]
    pub fn optional_guid(&mut self) -> Result<Option<Guid>, SaveError> {
        if self.u8()? != 0 {
            Ok(Some(self.guid()?))
        } else {
            Ok(None)
        }
    }

    /// UE `FString`: `i32` length prefix. Zero => empty. Positive => ASCII/UTF-8
    /// with a trailing NUL. Negative => UTF-16LE, `-len` code units incl. NUL.
    pub fn fstring(&mut self) -> Result<String, SaveError> {
        let size = self.i32()?;
        if size == 0 {
            return Ok(String::new());
        }
        if size < 0 {
            let units = (-size) as usize;
            let raw = self.take(units * 2)?;
            // Drop the trailing UTF-16 NUL (last 2 bytes).
            let body = &raw[..raw.len().saturating_sub(2)];
            let u16s: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            Ok(String::from_utf16_lossy(&u16s))
        } else {
            let n = size as usize;
            let raw = self.take(n)?;
            // Drop the trailing NUL.
            let body = &raw[..raw.len().saturating_sub(1)];
            Ok(String::from_utf8_lossy(body).into_owned())
        }
    }
}
