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

/// Length of the outer `CNK` wrapper that precedes the authoritative inner
/// header in Xbox / Game Pass "chunked" blobs.
const CNK_WRAPPER_LEN: usize = 12;

/// Inspect the header and decompress the payload into the raw GVAS blob.
pub fn decompress_sav(data: &[u8]) -> Result<Vec<u8>, SaveError> {
    if data.len() < HEADER_LEN {
        return Err(SaveError::Compression(format!(
            "file too small: {} bytes",
            data.len()
        )));
    }

    let magic = &data[8..11];
    // `CNK` (Xbox / Game Pass chunked): the 12-byte outer header is a wrapper
    // whose length fields are ignored; the authoritative header lives at
    // offset 12. Handle it before the outer guards, which would otherwise apply
    // to the ignored outer lengths.
    if magic == b"CNK" {
        return decompress_cnk(data);
    }

    let uncompressed_len = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let compressed_len = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
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
        other => Err(SaveError::Compression(format!(
            "unknown save magic {other:?}"
        ))),
    }
}

/// `CNK`: Xbox / Game Pass "chunked" wrapper. A 12-byte outer header (its
/// `uncompressed_len` / `compressed_len` both ignored) is prefixed onto an
/// otherwise-standard PlZ blob: the authoritative header sits at offset 12 and
/// its zlib payload begins at offset 24. There is no chunk offset table — the
/// inner magic MUST be `PlZ` (never `PlM`/`CNK`). The `MAX_UNCOMPRESSED_LEN`
/// guard and the truncation check are re-applied to the INNER length fields.
fn decompress_cnk(data: &[u8]) -> Result<Vec<u8>, SaveError> {
    // Payload starts after the outer wrapper plus the inner header.
    const PAYLOAD_START: usize = CNK_WRAPPER_LEN + HEADER_LEN;
    if data.len() < PAYLOAD_START {
        return Err(SaveError::Compression(format!(
            "CNK file too small: {} bytes, need at least {PAYLOAD_START}",
            data.len()
        )));
    }

    let uncompressed_len = u32::from_le_bytes([data[12], data[13], data[14], data[15]]) as usize;
    let compressed_len = u32::from_le_bytes([data[16], data[17], data[18], data[19]]) as usize;
    let inner_magic = &data[20..23];
    let save_type = data[23];

    if inner_magic != b"PlZ" {
        return Err(SaveError::Compression(format!(
            "CNK inner magic {inner_magic:?}, expected b\"PlZ\""
        )));
    }

    let payload = &data[PAYLOAD_START..];
    if payload.len() < compressed_len {
        return Err(SaveError::Compression(format!(
            "CNK payload truncated: header claims {compressed_len} compressed bytes, {} available",
            payload.len()
        )));
    }
    let payload = &payload[..compressed_len];

    if uncompressed_len > MAX_UNCOMPRESSED_LEN {
        return Err(SaveError::Compression(format!(
            "implausible CNK uncompressed length {uncompressed_len} exceeds {MAX_UNCOMPRESSED_LEN}-byte ceiling"
        )));
    }

    decompress_zlib(payload, save_type, uncompressed_len)
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

    /// Build a single-pass PlZ blob: 12-byte header + a real zlib stream of
    /// `raw`. `decompress_sav` on this yields `raw` byte-identically.
    fn plz(raw: &[u8]) -> Vec<u8> {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(raw).unwrap();
        let comp = enc.finish().unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        out.extend_from_slice(&(comp.len() as u32).to_le_bytes());
        out.extend_from_slice(b"PlZ");
        out.push(0x31);
        out.extend_from_slice(&comp);
        out
    }

    /// Prefix the 12-byte outer `CNK` wrapper (both length fields ignored) onto
    /// an existing blob — exactly how Xbox chunked saves nest a PlZ payload.
    fn cnk_wrap(inner: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&0u32.to_le_bytes()); // outer uncompressed_len (ignored)
        out.extend_from_slice(&0u32.to_le_bytes()); // outer compressed_len (ignored)
        out.extend_from_slice(b"CNK");
        out.push(0x31);
        out.extend_from_slice(inner);
        out
    }

    /// A CNK-wrapped copy of a PlZ blob decompresses byte-identically to the
    /// unwrapped PlZ blob — the wrapper is transparent.
    #[test]
    fn cnk_roundtrips_identical_to_plz() {
        let raw = b"the quick brown fox jumps over the lazy dog, repeatedly.".repeat(40);
        let plz_blob = plz(&raw);
        let cnk_blob = cnk_wrap(&plz_blob);
        let via_plz = decompress_sav(&plz_blob).expect("PlZ decompress");
        let via_cnk = decompress_sav(&cnk_blob).expect("CNK decompress");
        assert_eq!(via_plz, raw.as_slice());
        assert_eq!(via_cnk, via_plz, "CNK wrapper must be byte-transparent");
    }

    /// A CNK blob whose inner compressed_len claims more bytes than are present
    /// fails cleanly as a truncation error, never a panic.
    #[test]
    fn cnk_truncated_inner_len_rejected() {
        let mut cnk_blob = cnk_wrap(&plz(b"hello world"));
        // Overwrite the inner compressed_len (bytes 16..20) with a huge value.
        cnk_blob[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        match decompress_sav(&cnk_blob) {
            Err(SaveError::Compression(msg)) => {
                assert!(msg.contains("truncated"), "unexpected message: {msg}");
            }
            other => panic!("expected truncation error, got {other:?}"),
        }
    }

    /// A CNK blob shorter than the 24-byte double header fails cleanly.
    #[test]
    fn cnk_too_small_rejected() {
        let mut data = Vec::new();
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(b"CNK");
        data.push(0x31);
        match decompress_sav(&data) {
            Err(SaveError::Compression(msg)) => {
                assert!(msg.contains("too small"), "unexpected message: {msg}");
            }
            other => panic!("expected too-small error, got {other:?}"),
        }
    }

    /// A CNK inner magic other than `PlZ` (here a nested `PlM`) is rejected —
    /// the chunked wrapper only ever nests zlib.
    #[test]
    fn cnk_non_plz_inner_rejected() {
        // Inner header at offset 12: forge a PlM inner magic.
        let inner = forged(64, 4, &[0u8; 4]); // PlM header + payload
        let cnk_blob = cnk_wrap(&inner);
        match decompress_sav(&cnk_blob) {
            Err(SaveError::Compression(msg)) => {
                assert!(msg.contains("PlZ"), "unexpected message: {msg}");
            }
            other => panic!("expected inner-magic error, got {other:?}"),
        }
    }
}
