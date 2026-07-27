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
use oozextract::Extractor;

use crate::SaveError;

/// Fixed header length preceding the compressed payload.
const HEADER_LEN: usize = 12;

/// Upper bound on the decompressed GVAS blob. Real files: `Level.sav` ~30 MB,
/// and a `*_dps.sav` (dimensional pal storage) legitimately decompresses to
/// ~73 MB from ~40 KB — a ~1850x ratio, because the storage is mostly empty.
/// 512 MiB clears real saves with wide headroom while still rejecting a forged
/// `uncompressed_len` that would otherwise drive a multi-gigabyte allocation
/// (the Oodle path allocates `uncompressed_len` bytes up front). A ratio-based
/// guard is deliberately NOT used: real dps ratios (~1850x) make any ratio
/// ceiling that passes real data too loose to add protection over this bound.
const MAX_UNCOMPRESSED_LEN: usize = 512 * 1024 * 1024;

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

    // Guard the decompressed size BEFORE dispatching: a forged header must fail
    // as a clean `SaveError::Compression`, never a giant allocation.
    if uncompressed_len > MAX_UNCOMPRESSED_LEN {
        return Err(SaveError::Compression(format!(
            "implausible uncompressed length {uncompressed_len} exceeds {MAX_UNCOMPRESSED_LEN}-byte ceiling"
        )));
    }

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
fn decompress_zlib(
    payload: &[u8],
    save_type: u8,
    _uncompressed_len: usize,
) -> Result<Vec<u8>, SaveError> {
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
}

fn zlib_inflate(input: &[u8]) -> Result<Vec<u8>, SaveError> {
    let mut out = Vec::new();
    ZlibDecoder::new(input)
        .read_to_end(&mut out)
        .map_err(|e| SaveError::Compression(format!("zlib inflate failed: {e}")))?;
    Ok(out)
}

/// `PlM`: Oodle-compressed payload (Kraken). Only `save_type` 0x31 is known.
fn decompress_oodle(
    payload: &[u8],
    save_type: u8,
    uncompressed_len: usize,
) -> Result<Vec<u8>, SaveError> {
    if save_type != 0x31 {
        return Err(SaveError::Compression(format!(
            "unknown PlM save_type 0x{save_type:02x}"
        )));
    }
    oodle_decompress(payload, uncompressed_len)
}

/// Decode the Oodle Kraken payload with the pure-Rust `oozextract` crate. The
/// destination is sized to exactly `expected_len`; unlike the former C++ ooz
/// path, oozextract is memory-safe and requires no over-allocated scratch pad.
/// Validates that the decoder produced exactly `expected_len` bytes.
fn oodle_decompress(src: &[u8], expected_len: usize) -> Result<Vec<u8>, SaveError> {
    let mut out = vec![0u8; expected_len];
    let written = Extractor::new()
        .read_from_slice(src, &mut out)
        .map_err(|_| SaveError::Compression("Oodle Kraken decompress failed".into()))?;
    if written != expected_len {
        return Err(SaveError::Compression(format!(
            "Oodle decompressed {written} bytes, header expected {expected_len}"
        )));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a `.sav` header + payload with the given size fields, `PlM` magic.
    fn forged(uncompressed_len: u32, compressed_len: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
        out.extend_from_slice(&uncompressed_len.to_le_bytes());
        out.extend_from_slice(&compressed_len.to_le_bytes());
        out.extend_from_slice(b"PlM");
        out.push(0x31);
        out.extend_from_slice(payload);
        out
    }

    /// A header claiming ~4 GB uncompressed must be rejected as a clean
    /// `SaveError::Compression` before any allocation is attempted.
    #[test]
    fn oversized_uncompressed_len_rejected() {
        let data = forged(u32::MAX, 4, &[0u8; 4]);
        match decompress_sav(&data) {
            Err(SaveError::Compression(msg)) => {
                assert!(msg.contains("implausible"), "unexpected message: {msg}");
            }
            other => panic!("expected compression error, got {other:?}"),
        }
    }

    /// A `CNK`-magic (Xbox / Game Pass chunked) save must surface as the
    /// distinct `NotSupportedYet` variant — not a generic `Compression` error —
    /// so the UI can show the convert-to-Steam guidance. Synthetic 12-byte
    /// header: uncompressed_len=64, compressed_len=0, magic=b"CNK", type=0x31.
    #[test]
    fn cnk_magic_detected_as_not_supported() {
        let mut data = Vec::with_capacity(HEADER_LEN);
        data.extend_from_slice(&64u32.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(b"CNK");
        data.push(0x31);
        match decompress_sav(&data) {
            Err(SaveError::NotSupportedYet(msg)) => {
                assert!(msg.contains("CNK"), "unexpected message: {msg}");
            }
            other => panic!("expected NotSupportedYet, got {other:?}"),
        }
    }
}
