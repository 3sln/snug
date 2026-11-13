//! Deterministic encoding through the generated writer primitives.
//!
//! ```
//! use snug::{encode, EncodeOptions, Value};
//! assert_eq!(encode(&Value::Uint(42), &EncodeOptions::default())?, [0x18, 42]);
//! # Ok::<(), snug::Error>(())
//! ```
use crate::snug::{
    cbor::scan::code_name,
    write::{float::{put_float, put_float_rfc}, int::put_int, map::close_map, out::put_head},
};
use crate::{DecodeOptions, Error, Floats, Integer, Limits, Profile, Top, TypedArray, Value};

/// Encoder options. Encoding permits any root. Output bytes are bounded during
/// growth, unlike JS's finish-only maxBytes check; the core checks the final result
/// against the profile (the valid preset by default; the bytes are
/// deterministic under every preset).
#[derive(Debug, Clone, Copy)]
pub struct EncodeOptions {
    /// Under `Keys::Text`: permit safe integer labels in the top-level map.
    pub cose: bool,
    /// Output, nesting, entry and item bounds.
    pub limits: Limits,
    /// The wire profile: it decides float forms and what the final check admits.
    pub profile: Profile,
}
impl Default for EncodeOptions {
    fn default() -> Self {
        Self {
            cose: false,
            limits: Limits::default(),
            profile: Profile::VALID,
        }
    }
}
impl EncodeOptions {
    /// The Bindle profile.
    pub fn bindle() -> Self {
        Self {
            profile: Profile::BINDLE,
            ..Self::default()
        }
    }
    pub(crate) fn decode_options(self) -> DecodeOptions {
        DecodeOptions {
            top: Top::Any,
            cose: self.cose,
            limits: self.limits,
            profile: self.profile,
        }
    }
}
/// Encode a complete value, sorting maps through the core and checking the complete
/// result with the generated scanner before returning bytes.
pub fn encode(value: &Value, options: &EncodeOptions) -> Result<Vec<u8>, Error> {
    let mut writer = crate::Writer::new(options)?;
    writer.value(value)?;
    writer.finish()
}

/// An open container of the iterative writer: the entries left, its depth,
/// and for a map the pairs' byte offsets, their bignum notes, the value to write
/// after the key in flight and the bignum count before that key.
enum Walk<'v> {
    Array(std::slice::Iter<'v, Value>, usize),
    Map {
        it: std::slice::Iter<'v, (Value, Value)>,
        depth: usize,
        pairs: Vec<i32>,
        normalized: Vec<bool>,
        value: Option<&'v Value>,
        norms: usize,
    },
}

pub(crate) struct Output {
    pub(crate) bytes: Vec<u8>,
    pub(crate) options: EncodeOptions,
    /// Bignums outside preferred serialization written as their integer so far.
    pub(crate) norms: usize,
}
impl Output {
    pub(crate) fn new(options: EncodeOptions) -> Result<Self, Error> {
        options.limits.check()?;
        Ok(Self {
            bytes: Vec::new(),
            options,
            norms: 0,
        })
    }
    /// A bignum's magnitude outside preferred serialization (a leading zero, or a
    /// value major type 0/1 holds) is about to be written as its integer.
    fn note_bignum(&mut self, magnitude: &[u8]) {
        if magnitude.len() < 9 || magnitude[0] == 0 {
            self.norms += 1;
        }
    }
    pub(crate) fn raw(&mut self, b: &[u8]) -> Result<(), Error> {
        let end = self
            .bytes
            .len()
            .checked_add(b.len())
            .ok_or(Error::cbor("too_large"))?;
        if end > self.options.limits.max_bytes as usize {
            return Err(Error::cbor("too_large"));
        }
        self.bytes.extend_from_slice(b);
        Ok(())
    }
    pub(crate) fn head(&mut self, major: i32, n: u64) -> Result<(), Error> {
        let mut buf = [0; 9];
        let end = put_head(&mut buf, 0, major, (n >> 32) as i32, n as i32);
        self.written(&buf, end)
    }
    fn written(&mut self, b: &[u8], end: i32) -> Result<(), Error> {
        if end < 0 {
            return Err(Error::cbor(code_name(-end)));
        }
        self.raw(b.get(..end as usize).ok_or(Error::Internal)?)
    }
    pub(crate) fn integer(&mut self, negative: bool, magnitude: &[u8]) -> Result<(), Error> {
        // Kin needs at most 129 significant bytes to decide its 128-byte cap.
        let first = magnitude
            .iter()
            .position(|&b| b != 0)
            .unwrap_or(magnitude.len());
        let significant = magnitude.get(first..).ok_or(Error::Internal)?;
        let m = significant
            .get(..significant.len().min(129))
            .ok_or(Error::Internal)?;
        let mut b = [0; 140];
        let end = put_int(&mut b, 0, negative as i32, m, 0, m.len() as i32);
        self.written(&b, end)
    }
    fn exact(&mut self, v: &Integer) -> Result<(), Error> {
        match v {
            Integer::Uint(n) => self.integer(false, &n.to_be_bytes()),
            Integer::Nint(n) => self.integer(true, &n.to_be_bytes()),
            Integer::BigInt {
                negative,
                magnitude,
            } => {
                self.note_bignum(magnitude);
                self.integer(*negative, magnitude)
            }
        }
    }
    pub(crate) fn container(&mut self, major: i32, n: usize, depth: usize) -> Result<(), Error> {
        if depth >= self.options.limits.max_depth as usize {
            return Err(Error::cbor("depth"));
        }
        if n > self.options.limits.max_entries as usize {
            return Err(Error::cbor("too_many_entries"));
        }
        self.head(major, n as u64)
    }
    /// Sort a map's pairs through the core. `normalized[i]`: pair i's key holds a bignum
    /// written as its integer (a duplicate among such keys is `duplicate_key`
    /// with the subcode `normalized`).
    pub(crate) fn map_end(&mut self, pairs: &[i32], normalized: &[bool]) -> Result<(), Error> {
        let n = pairs.len() / 2;
        if n < 2 {
            return Ok(());
        }
        let mut tmp = vec![0; self.bytes.len()];
        let mut order = vec![0; pairs.len()];
        let mut s = [0, i32::MAX, 0, 0];
        let end = self.bytes.len() as i32;
        let r = close_map(
            &mut self.bytes,
            pairs,
            0,
            n as i32,
            end,
            &mut tmp,
            &mut order,
            &mut s,
        );
        if r == -7 && normalized.iter().any(|&x| x) {
            // close-map moves nothing on a refusal: the keys are still where `pairs` says
            let key = |i: usize| &self.bytes[pairs[2 * i] as usize..pairs[2 * i + 1] as usize];
            let mut seen: std::collections::HashMap<&[u8], bool> = std::collections::HashMap::new();
            for i in 0..n {
                let norm = normalized.get(i).copied().unwrap_or(false);
                let g = seen.get(key(i)).copied();
                if g.is_some_and(|g| g || norm) {
                    return Err(Error::Cbor { code: "duplicate_key", offset: None, subcode: Some("normalized") });
                }
                seen.insert(key(i), g.unwrap_or(false) || norm);
            }
        }
        if r != 0 {
            return Err(if r == -40 {
                Error::cbor("budget")
            } else {
                Error::cbor(code_name(-r))
            });
        }
        Ok(())
    }
    /// The tree is walked ITERATIVELY -- the open arrays and maps on a heap
    /// stack, a tag's or ndarray's content taken next -- so the native stack does
    /// not grow with the value's depth (the recursive writer needed about 6.3 KB
    /// per level in a debug build on Rust 1.98). The depth bound is unchanged.
    pub(crate) fn value(&mut self, v: &Value, depth: usize) -> Result<(), Error> {
        let mut stack: Vec<Walk<'_>> = Vec::new();
        let mut next = Some((v, depth));
        loop {
            if let Some((v, depth)) = next.take() {
                if depth > self.options.limits.max_depth as usize {
                    return Err(Error::cbor("depth"));
                }
                match v {
                    Value::Array(a) => {
                        self.container(4, a.len(), depth)?;
                        stack.push(Walk::Array(a.iter(), depth));
                    }
                    Value::Map(a) => {
                        self.container(5, a.len(), depth)?;
                        stack.push(Walk::Map {
                            it: a.iter(),
                            depth,
                            pairs: Vec::new(),
                            normalized: Vec::new(),
                            value: None,
                            norms: 0,
                        });
                    }
                    Value::Tag(n, c) => {
                        self.head(6, *n)?;
                        next = Some((c, depth + 1));
                        continue;
                    }
                    Value::NDArray { shape, data } => {
                        self.ndarray_head(shape)?;
                        next = Some((data, depth + 2));
                        continue;
                    }
                    _ => self.scalar(v)?,
                }
            }
            match stack.last_mut() {
                None => return Ok(()),
                Some(Walk::Array(it, depth)) => match it.next() {
                    Some(c) => next = Some((c, *depth + 1)),
                    None => {
                        stack.pop();
                    }
                },
                Some(Walk::Map {
                    it,
                    depth,
                    pairs,
                    normalized,
                    value,
                    norms,
                }) => {
                    if let Some(val) = value.take() {
                        // the key just written: its bignum note, then the value
                        normalized.push(self.norms != *norms);
                        pairs.push(self.bytes.len() as i32);
                        next = Some((val, *depth + 1));
                    } else if let Some((k, val)) = it.next() {
                        pairs.push(self.bytes.len() as i32);
                        *norms = self.norms;
                        *value = Some(val);
                        next = Some((k, *depth + 1));
                    } else if let Some(Walk::Map {
                        pairs, normalized, ..
                    }) = stack.pop()
                    {
                        self.map_end(&pairs, &normalized)?;
                    }
                }
            }
        }
    }
    fn scalar(&mut self, v: &Value) -> Result<(), Error> {
        match v {
            Value::Uint(n) => self.integer(false, &n.to_be_bytes()),
            Value::Nint(n) => self.integer(true, &n.to_be_bytes()),
            Value::BigInt {
                negative,
                magnitude,
            } => {
                self.note_bignum(magnitude);
                self.integer(*negative, magnitude)
            }
            Value::Bytes(b) => {
                self.head(2, b.len() as u64)?;
                self.raw(b)
            }
            Value::Text(s) => {
                self.head(3, s.len() as u64)?;
                self.raw(s.as_bytes())
            }
            // containers and tags are value()'s, never a scalar's
            Value::Array(_) | Value::Map(_) | Value::Tag(..) | Value::NDArray { .. } => Err(Error::Internal),
            Value::Decimal { mantissa, exponent } => {
                self.head(6, 4)?;
                self.head(4, 2)?;
                if *exponent >= 0 {
                    self.integer(false, &(*exponent as u64).to_be_bytes())?;
                } else {
                    self.integer(
                        true,
                        &((-1i128 - i128::from(*exponent)) as u64).to_be_bytes(),
                    )?;
                }
                self.exact(mantissa)
            }
            Value::TypedArray(a) => self.typed(a),
            Value::Bool(v) => self.head(7, if *v { 21 } else { 20 }),
            Value::Null => self.head(7, 22),
            Value::Undefined => self.head(7, 23),
            Value::Simple(n) => {
                if (20..=31).contains(n) {
                    return Err(Error::cbor("simple"));
                }
                self.head(7, u64::from(*n))
            }
            Value::Float(n) => {
                let bits = n.to_bits();
                let mut b = [0; 9];
                let r = if self.options.profile.floats == Floats::Deterministic {
                    put_float_rfc(&mut b, 0, (bits >> 32) as i32, bits as i32)
                } else {
                    put_float(&mut b, 0, (bits >> 32) as i32, bits as i32)
                };
                self.written(&b, r)
            }
        }
    }
    pub(crate) fn ndarray(
        &mut self,
        shape: &[u64],
        data: &Value,
        depth: usize,
    ) -> Result<(), Error> {
        self.ndarray_head(shape)?;
        self.value(data, depth + 2)
    }
    /// Tag 40, its two-element array's head and the shape array.
    fn ndarray_head(&mut self, shape: &[u64]) -> Result<(), Error> {
        self.head(6, 40)?;
        self.head(4, 2)?;
        self.head(4, shape.len() as u64)?;
        for &n in shape {
            self.integer(false, &n.to_be_bytes())?;
        }
        Ok(())
    }
    pub(crate) fn typed(&mut self, a: &TypedArray) -> Result<(), Error> {
        macro_rules! put {
            ($tag:expr, $a:expr, $w:expr) => {{
                self.head(6, $tag)?;
                let len = $a.len().checked_mul($w).ok_or(Error::cbor("too_large"))?;
                self.head(2, len as u64)?;
                for n in $a {
                    self.raw(&n.to_le_bytes())?;
                }
                Ok(())
            }};
        }
        match a {
            TypedArray::U16(a) => put!(69, a, 2),
            TypedArray::U32(a) => put!(70, a, 4),
            TypedArray::U64(a) => put!(71, a, 8),
            TypedArray::I8(a) => put!(72, a, 1),
            TypedArray::I16(a) => put!(77, a, 2),
            TypedArray::I32(a) => put!(78, a, 4),
            TypedArray::I64(a) => put!(79, a, 8),
            TypedArray::F16(a) => put!(84, a, 2),
            TypedArray::F32(a) => put!(85, a, 4),
            TypedArray::F64(a) => put!(86, a, 8),
        }
    }
}
