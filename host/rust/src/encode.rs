//! Deterministic encoding through generated kin writer primitives.
//!
//! ```
//! use snug::{encode, EncodeOptions, Value};
//! assert_eq!(encode(&Value::Uint(42), &EncodeOptions::default())?, [0x18, 42]);
//! # Ok::<(), snug::Error>(())
//! ```
use crate::snug::{
    cbor::scan::code_name,
    write::{float::put_float, int::put_int, map::close_map, out::put_head},
};
use crate::{DecodeOptions, Error, Integer, Limits, Top, TypedArray, Value};

/// Encoder options. Encoding permits any root. Output bytes are bounded during
/// growth, unlike JS's finish-only maxBytes check; kin checks the final profile.
#[derive(Debug, Clone, Copy, Default)]
pub struct EncodeOptions {
    /// Permit safe integer labels in the top-level map.
    pub cose: bool,
    /// Output, nesting, entry and item bounds.
    pub limits: Limits,
}
impl EncodeOptions {
    pub(crate) fn decode_options(self) -> DecodeOptions {
        DecodeOptions {
            top: Top::Any,
            cose: self.cose,
            limits: self.limits,
        }
    }
}
/// Encode a complete value, sorting maps through kin and checking the complete
/// result with the generated scanner before returning bytes.
pub fn encode(value: &Value, options: &EncodeOptions) -> Result<Vec<u8>, Error> {
    let mut writer = crate::Writer::new(options)?;
    writer.value(value)?;
    writer.finish()
}

pub(crate) struct Output {
    pub(crate) bytes: Vec<u8>,
    pub(crate) options: EncodeOptions,
}
impl Output {
    pub(crate) fn new(options: EncodeOptions) -> Result<Self, Error> {
        options.limits.check()?;
        Ok(Self {
            bytes: Vec::new(),
            options,
        })
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
            } => self.integer(*negative, magnitude),
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
    pub(crate) fn map_end(&mut self, pairs: &[i32]) -> Result<(), Error> {
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
        if r != 0 {
            return Err(if r == -40 {
                Error::cbor("budget")
            } else {
                Error::cbor(code_name(-r))
            });
        }
        Ok(())
    }
    pub(crate) fn value(&mut self, v: &Value, depth: usize) -> Result<(), Error> {
        // The host recursion is bounded before descending into caller-built trees.
        if depth > self.options.limits.max_depth as usize {
            return Err(Error::cbor("depth"));
        }
        match v {
            Value::Uint(n) => self.integer(false, &n.to_be_bytes()),
            Value::Nint(n) => self.integer(true, &n.to_be_bytes()),
            Value::BigInt {
                negative,
                magnitude,
            } => self.integer(*negative, magnitude),
            Value::Bytes(b) => {
                self.head(2, b.len() as u64)?;
                self.raw(b)
            }
            Value::Text(s) => {
                self.head(3, s.len() as u64)?;
                self.raw(s.as_bytes())
            }
            Value::Array(a) => {
                self.container(4, a.len(), depth)?;
                for v in a {
                    self.value(v, depth + 1)?;
                }
                Ok(())
            }
            Value::Map(a) => {
                self.container(5, a.len(), depth)?;
                let mut pairs = Vec::new();
                for (k, v) in a {
                    pairs.push(self.bytes.len() as i32);
                    self.value(k, depth + 1)?;
                    pairs.push(self.bytes.len() as i32);
                    self.value(v, depth + 1)?;
                }
                self.map_end(&pairs)
            }
            Value::Tag(n, v) => {
                self.head(6, *n)?;
                self.value(v, depth + 1)
            }
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
            Value::NDArray { shape, data } => self.ndarray(shape, data, depth),
            Value::Bool(v) => self.head(7, if *v { 21 } else { 20 }),
            Value::Null => self.head(7, 22),
            Value::Float(n) => {
                let bits = n.to_bits();
                let mut b = [0; 9];
                let r = put_float(&mut b, 0, (bits >> 32) as i32, bits as i32);
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
        self.head(6, 40)?;
        self.head(4, 2)?;
        self.head(4, shape.len() as u64)?;
        for &n in shape {
            self.integer(false, &n.to_be_bytes())?;
        }
        self.value(data, depth + 2)
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
