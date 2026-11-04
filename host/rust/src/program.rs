//! Versioned, SHA-256 checked Program containers (D084/D100).
//!
//! ```
//! use snug::{Schema, CompileOptions, Program};
//! let schema = Schema::compile("r = uint", &CompileOptions::default())?;
//! let container = schema.program().serialize()?;
//! let program = Program::deserialize(&container)?;
//! assert_eq!(program.source_key(), schema.program().source_key());
//! # Ok::<(), snug::Error>(())
//! ```
use crate::{schema, sha256::sha256, Error};
use std::sync::Arc;

const HEADER: usize = 96;
const MAX_BODY: usize = 64 * 1024 * 1024;
/// Immutable, verified Program. Clones share owned storage; no mutable words or
/// pool escape. A digest detects corruption, **not** malicious Programs. Load
/// only from trusted compiler/cache origins, as required by D084.
#[derive(Debug, Clone)]
pub struct Program(Arc<Inner>);
#[derive(Debug)]
struct Inner {
    words: Vec<i32>,
    pool: Vec<u8>,
    host: schema::Program,
    version: String,
    rules: Vec<String>,
}

fn word(bytes: &[u8], at: usize) -> Result<u32, Error> {
    let end = at.checked_add(4).ok_or(Error::Program("length"))?;
    let w: [u8; 4] = bytes
        .get(at..end)
        .ok_or(Error::Program("length"))?
        .try_into()
        .map_err(|_| Error::Program("length"))?;
    Ok(u32::from_le_bytes(w))
}
fn digest(bytes: &[u8]) -> Result<[u8; 32], Error> {
    let mut preimage = bytes.get(..56).ok_or(Error::Program("length"))?.to_vec();
    preimage.extend_from_slice(bytes.get(88..).ok_or(Error::Program("length"))?);
    Ok(sha256(&preimage))
}
fn body_len(words: usize, pool: usize) -> Result<usize, Error> {
    let n = words
        .checked_mul(4)
        .and_then(|n| n.checked_add(pool))
        .ok_or(Error::Program("too_large"))?;
    if n > MAX_BODY {
        return Err(Error::Program("too_large"));
    }
    Ok(n)
}
impl Program {
    /// Copy and run kin's structural verifier on raw Program words and pool.
    /// Prefer deserialization for a persisted JS or Rust Program.
    pub fn from_parts(words: &[i32], pool: &[u8]) -> Result<Self, Error> {
        Self::with_version(words, pool, crate::compile::snug_version().to_owned())
    }
    fn with_version(words: &[i32], pool: &[u8], version: String) -> Result<Self, Error> {
        body_len(words.len(), pool.len())?;
        let host = schema::Program::new(words, pool).map_err(|_| Error::Program("verify"))?;
        let count = usize::try_from(*words.get(15).ok_or(Error::Program("verify"))?)
            .map_err(|_| Error::Program("verify"))?;
        let base = usize::try_from(*words.get(42).ok_or(Error::Program("verify"))?)
            .map_err(|_| Error::Program("verify"))?;
        let mut rules = Vec::new();
        for i in 0..count {
            let at = base
                .checked_add(i.checked_mul(5).ok_or(Error::Internal)?)
                .ok_or(Error::Internal)?;
            let off = usize::try_from(*words.get(at).ok_or(Error::Internal)?)
                .map_err(|_| Error::Internal)?;
            let len = usize::try_from(*words.get(at + 1).ok_or(Error::Internal)?)
                .map_err(|_| Error::Internal)?;
            let b = pool
                .get(off..off.checked_add(len).ok_or(Error::Internal)?)
                .ok_or(Error::Internal)?;
            rules.push(
                std::str::from_utf8(b)
                    .map_err(|_| Error::Internal)?
                    .to_owned(),
            );
        }
        Ok(Self(Arc::new(Inner {
            words: words.to_vec(),
            pool: pool.to_vec(),
            host,
            version,
            rules,
        })))
    }
    pub(crate) fn host(&self) -> &schema::Program {
        &self.0.host
    }
    /// Immutable words; little-endian serialization is explicit on every host.
    pub fn words(&self) -> &[i32] {
        &self.0.words
    }
    /// Immutable byte pool.
    pub fn pool(&self) -> &[u8] {
        &self.0.pool
    }
    /// Validatable rule names in the compiler's UTF-8 sort order.
    pub fn rules(&self) -> &[String] {
        &self.0.rules
    }
    /// Informational producer version, preserved by reserialization.
    pub fn producer_version(&self) -> &str {
        &self.0.version
    }
    /// SHA-256 source cache key as 64 lowercase hexadecimal digits.
    pub fn source_key(&self) -> String {
        self.words()
            .get(7..15)
            .unwrap_or(&[])
            .iter()
            .map(|&w| format!("{:08x}", w as u32))
            .collect()
    }
    /// Emit docs/program.md's container, byte-identical to JavaScript. Current
    /// format major/minor is 1.0; producer version is provenance only.
    pub fn serialize(&self) -> Result<Vec<u8>, Error> {
        let size = body_len(self.words().len(), self.pool().len())?;
        let mut out = vec![0u8; HEADER];
        out.get_mut(..8)
            .ok_or(Error::Internal)?
            .copy_from_slice(b"snugprog");
        let format = *self.words().get(1).ok_or(Error::Internal)? as u32;
        for (at, n) in [
            (8, 1),
            (12, format),
            (16, self.words().len() as u32),
            (20, self.pool().len() as u32),
        ] {
            out.get_mut(at..at + 4)
                .ok_or(Error::Internal)?
                .copy_from_slice(&n.to_le_bytes());
        }
        let v = self.producer_version().as_bytes();
        if v.is_empty() || v.len() > 32 || !v.iter().all(|&b| (0x21..=0x7e).contains(&b)) {
            return Err(Error::Program("version"));
        }
        out.get_mut(24..24 + v.len())
            .ok_or(Error::Internal)?
            .copy_from_slice(v);
        out.reserve(size);
        for &w in self.words() {
            out.extend_from_slice(&w.to_le_bytes());
        }
        out.extend_from_slice(self.pool());
        let hash = digest(&out)?;
        out.get_mut(56..88)
            .ok_or(Error::Internal)?
            .copy_from_slice(&hash);
        Ok(out)
    }
    /// Check framing, format compatibility, canonical version padding, reserved
    /// bytes, SHA-256 and finally kin vm-verify before owning a Program.
    pub fn deserialize(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() < HEADER {
            return Err(Error::Program("length"));
        }
        if bytes.len() > HEADER + MAX_BODY {
            return Err(Error::Program("too_large"));
        }
        if bytes.get(..8) != Some(b"snugprog".as_slice()) {
            return Err(Error::Program("magic"));
        }
        if word(bytes, 8)? != 1 {
            return Err(Error::Program("container_version"));
        }
        let format = word(bytes, 12)?;
        if format & 0xffff != 1 || format >> 16 > 0 {
            return Err(Error::Program("format_version"));
        }
        let (nw, nb) = (word(bytes, 16)? as usize, word(bytes, 20)? as usize);
        let size = nw
            .checked_mul(4)
            .and_then(|n| n.checked_add(nb))
            .and_then(|n| n.checked_add(HEADER))
            .ok_or(Error::Program("length"))?;
        if nw < 64 || size != bytes.len() {
            return Err(Error::Program("length"));
        }
        let version = bytes.get(24..56).ok_or(Error::Program("length"))?;
        let len = version
            .iter()
            .take_while(|&&b| (0x21..=0x7e).contains(&b))
            .count();
        if len == 0
            || version
                .get(len..)
                .ok_or(Error::Internal)?
                .iter()
                .any(|&b| b != 0)
        {
            return Err(Error::Program("version"));
        }
        if bytes
            .get(88..HEADER)
            .ok_or(Error::Internal)?
            .iter()
            .any(|&b| b != 0)
        {
            return Err(Error::Program("reserved"));
        }
        if bytes.get(56..88) != Some(digest(bytes)?.as_slice()) {
            return Err(Error::Program("digest"));
        }
        let words_end = HEADER + nw * 4;
        let words = bytes
            .get(HEADER..words_end)
            .ok_or(Error::Internal)?
            .chunks_exact(4)
            .map(|b| {
                <[u8; 4]>::try_from(b)
                    .map(i32::from_le_bytes)
                    .map_err(|_| Error::Internal)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if words.get(1).copied().map(|w| w as u32) != Some(format) {
            return Err(Error::Program("format_version"));
        }
        let version = std::str::from_utf8(version.get(..len).ok_or(Error::Internal)?)
            .map_err(|_| Error::Program("version"))?
            .to_owned();
        Self::with_version(
            &words,
            bytes.get(words_end..).ok_or(Error::Internal)?,
            version,
        )
    }
}
