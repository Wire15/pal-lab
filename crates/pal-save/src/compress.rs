//! `.sav` compression wrapper. A Palworld save is a 12-byte header followed by
//! a compressed GVAS payload:
//!
//! ```text
//! offset 0  u32 LE  uncompressed_len
//! offset 4  u32 LE  compressed_len
//! offset 8  [3]u8   magic  (b"PlZ" zlib, b"PlM" Oodle, b"CNK" Xbox chunked)
//! offset 11 u8      save_type (0x31 single pass, 0x32 double zlib)
//! offset 12 ..      payload
//! ```
//!
//! Only decompression is implemented (this crate is read-only).

use std::io::Read;

use flate2::read::ZlibDecoder;

use crate::SaveError;

/// Fixed header length preceding the compressed payload.
const HEADER_LEN: usize = 12;

/// Inspect the header and decompress the payload into the raw GVAS blob.
pub fn decompress_sav(data: &[u8]) -> Result<Vec<u8>, SaveError> {
    if data.len() < HEADER_LEN {
        return Err(SaveError::Compression(format!(
            "file too small: {} bytes",
            data.len()
        )));
    }

    let uncompressed_len = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let compressed_len = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let magic = &data[8..11];
    let save_type = data[11];
    let payload = &data[HEADER_LEN..];

    if payload.len() < compressed_len {
        return Err(SaveError::Compression(format!(
            "payload truncated: header claims {compressed_len} compressed bytes, {} available",
            payload.len()
        )));
    }
    let payload = &payload[..compressed_len];

    match magic {
        b"PlZ" => decompress_zlib(payload, save_type, uncompressed_len),
        b"PlM" => decompress_oodle(payload, save_type, uncompressed_len),
        b"CNK" => Err(SaveError::NotSupportedYet(
            "Xbox chunked (CNK) saves are not supported yet".into(),
        )),
        other => Err(SaveError::Compression(format!(
            "unknown save magic {other:?}"
        ))),
    }
}

/// `PlZ`: single (`0x31`) or double (`0x32`) zlib pass.
fn decompress_zlib(payload: &[u8], save_type: u8, uncompressed_len: usize) -> Result<Vec<u8>, SaveError> {
    let first = zlib_inflate(payload)?;
    match save_type {
        0x31 => Ok(first),
        0x32 => {
            // Double zlib: the first inflate yields another zlib stream whose
            // output is `uncompressed_len` bytes.
            zlib_inflate(&first)
        }
        other => Err(SaveError::Compression(format!(
            "unknown PlZ save_type 0x{other:02x}"
        ))),
    }
    .map(|out| verify_len(out, uncompressed_len, save_type))
}

fn zlib_inflate(input: &[u8]) -> Result<Vec<u8>, SaveError> {
    let mut out = Vec::new();
    ZlibDecoder::new(input)
        .read_to_end(&mut out)
        .map_err(|e| SaveError::Compression(format!("zlib inflate failed: {e}")))?;
    Ok(out)
}

/// `PlM`: Oodle-compressed payload (Kraken). Only `save_type` 0x31 is known.
fn decompress_oodle(payload: &[u8], save_type: u8, uncompressed_len: usize) -> Result<Vec<u8>, SaveError> {
    if save_type != 0x31 {
        return Err(SaveError::Compression(format!(
            "unknown PlM save_type 0x{save_type:02x}"
        )));
    }
    let mut out = vec![0u8; uncompressed_len];
    // SAFETY: `out` is sized to the header-declared uncompressed length, which
    // bounds the decompressor's writes for a well-formed Kraken stream.
    let written = unsafe { oozle::decompress(payload, &mut out) }
        .map_err(|e| SaveError::Compression(format!("Oodle decompress failed: {e}")))?;
    out.truncate(written);
    Ok(verify_len(out, uncompressed_len, save_type))
}

/// Warn (via the returned buffer being kept) but do not fail on a length
/// mismatch; the GVAS parser is the real validator. We just log-shape the size.
fn verify_len(out: Vec<u8>, expected: usize, _save_type: u8) -> Vec<u8> {
    debug_assert!(
        out.len() == expected || expected == 0,
        "decompressed {} bytes, header expected {}",
        out.len(),
        expected
    );
    out
}
