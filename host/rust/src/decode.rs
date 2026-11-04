//! Scanner-first decoding. Only fully checked bytes reach the owned builder.
//!
//! ```
//! use snug::{decode, DecodeOptions, Value};
//! assert_eq!(decode(&[0x18, 42], &DecodeOptions::any())?, Value::Uint(42));
//! # Ok::<(), snug::Error>(())
//! ```
use crate::snug::cbor::scan::{code_name, error_offset, scan, scan_options};
use crate::{Error, Integer, TypedArray, Value};

/// Permitted root shape; separate from the future wire-profile presets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Top {
    /// Require a map at the codec boundary (current default).
    #[default]
    Map,
    /// Permit any profile-valid item.
    Any,
}
/// Resource limits. Depth is capped at 256, all counts/lengths at i32::MAX−1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Maximum input/output bytes.
    pub max_bytes: u32,
    /// Maximum nesting depth.
    pub max_depth: u16,
    /// Maximum entries in a container.
    pub max_entries: u32,
    /// Maximum items in one document.
    pub max_items: u32,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_bytes: 1_500_000,
            max_depth: 32,
            max_entries: 65_536,
            max_items: 131_072,
        }
    }
}
impl Limits {
    pub(crate) fn check(&self) -> Result<(), Error> {
        if self.max_depth > 256
            || [self.max_bytes, self.max_entries, self.max_items]
                .iter()
                .any(|&n| n >= i32::MAX as u32)
        {
            return Err(Error::Usage("options"));
        }
        Ok(())
    }
}
/// Decode/profile options. This facade selects the restricted Bindle scanner
/// policy. Root shape, COSE labels and limits remain independent settings so
/// future deterministic/bindle presets can use the same API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DecodeOptions {
    /// Required root shape.
    pub top: Top,
    /// Permit safe integer labels in the top-level map.
    pub cose: bool,
    /// Bounded scan resources.
    pub limits: Limits,
}
impl DecodeOptions {
    /// Current Bindle preset (including map root).
    pub fn bindle() -> Self {
        Self::default()
    }
    /// Current wire policy with any root shape.
    pub fn any() -> Self {
        Self {
            top: Top::Any,
            ..Self::default()
        }
    }
}
pub(crate) fn check(bytes: &[u8], options: &DecodeOptions) -> Result<(), Error> {
    options.limits.check()?;
    if bytes.len() >= i32::MAX as usize {
        return Err(Error::cbor("too_large"));
    }
    let l = options.limits;
    let mut o = [0; crate::snug::cbor::codes::SCAN_OPTS_LEN as usize];
    scan_options(
        &mut o,
        (options.top == Top::Any) as i32,
        options.cose as i32,
        l.max_bytes as i32,
        l.max_depth as i32,
        l.max_entries as i32,
        l.max_items as i32,
    );
    let code = scan(bytes, &mut o);
    if code == 0 {
        Ok(())
    } else {
        Err(Error::Cbor {
            code: code_name(code),
            offset: usize::try_from(error_offset(&mut o)).ok(),
        })
    }
}
/// Decode one complete deterministic CBOR document. Byte strings and typed
/// arrays are owned copies. No partial value escapes a refused document.
pub fn decode(bytes: &[u8], options: &DecodeOptions) -> Result<Value, Error> {
    check(bytes, options)?;
    build(bytes)
}

pub(crate) fn build(bytes: &[u8]) -> Result<Value, Error> {
    let mut b = Builder { bytes, at: 0 };
    let v = b.value(0)?;
    if b.at != bytes.len() {
        return Err(Error::Internal);
    }
    Ok(v)
}
struct Builder<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Builder<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], Error> {
        let end = self.at.checked_add(len).ok_or(Error::Internal)?;
        let b = self.bytes.get(self.at..end).ok_or(Error::Internal)?;
        self.at = end;
        Ok(b)
    }
    fn head(&mut self) -> Result<(u8, u8, u64), Error> {
        let h = *self.take(1)?.first().ok_or(Error::Internal)?;
        let ai = h & 31;
        let n = if ai < 24 {
            u64::from(ai)
        } else {
            let width = match ai {
                24 => 1,
                25 => 2,
                26 => 4,
                27 => 8,
                _ => return Err(Error::Internal),
            };
            self.take(width)?
                .iter()
                .fold(0u64, |a, &b| (a << 8) | u64::from(b))
        };
        Ok((h >> 5, ai, n))
    }
    fn integer(v: Value) -> Result<Integer, Error> {
        match v {
            Value::Uint(n) => Ok(Integer::Uint(n)),
            Value::Nint(n) => Ok(Integer::Nint(n)),
            Value::BigInt {
                negative,
                magnitude,
            } => Ok(Integer::BigInt {
                negative,
                magnitude,
            }),
            _ => Err(Error::Internal),
        }
    }
    fn value(&mut self, depth: usize) -> Result<Value, Error> {
        if depth > 258 {
            return Err(Error::Internal);
        }
        let (major, ai, n) = self.head()?;
        Ok(match major {
            0 => Value::Uint(n),
            1 => Value::Nint(n),
            2 | 3 => {
                let len = usize::try_from(n).map_err(|_| Error::Internal)?;
                let b = self.take(len)?;
                if major == 2 {
                    Value::Bytes(b.to_vec())
                } else {
                    Value::Text(
                        std::str::from_utf8(b)
                            .map_err(|_| Error::Internal)?
                            .to_owned(),
                    )
                }
            }
            4 => {
                let mut a = Vec::new();
                for _ in 0..n {
                    a.push(self.value(depth + 1)?);
                }
                Value::Array(a)
            }
            5 => {
                let mut a = Vec::new();
                for _ in 0..n {
                    a.push((self.value(depth + 1)?, self.value(depth + 1)?));
                }
                Value::Map(a)
            }
            6 => {
                let v = self.value(depth + 1)?;
                match (n, v) {
                    (2 | 3, Value::Bytes(magnitude)) => Value::BigInt {
                        negative: n == 3,
                        magnitude,
                    },
                    (4, Value::Array(a)) => {
                        let mut it = a.into_iter();
                        let exp = match it.next() {
                            Some(Value::Uint(e)) => {
                                i64::try_from(e).map_err(|_| Error::Internal)?
                            }
                            Some(Value::Nint(e)) => i64::try_from(-1i128 - i128::from(e))
                                .map_err(|_| Error::Internal)?,
                            _ => return Err(Error::Internal),
                        };
                        Value::Decimal {
                            exponent: exp,
                            mantissa: Self::integer(it.next().ok_or(Error::Internal)?)?,
                        }
                    }
                    (40, Value::Array(a)) => {
                        let mut it = a.into_iter();
                        let shape = match it.next() {
                            Some(Value::Array(a)) => a
                                .into_iter()
                                .map(|v| match v {
                                    Value::Uint(n) => Ok(n),
                                    _ => Err(Error::Internal),
                                })
                                .collect::<Result<Vec<_>, _>>()?,
                            _ => return Err(Error::Internal),
                        };
                        Value::NDArray {
                            shape,
                            data: Box::new(it.next().ok_or(Error::Internal)?),
                        }
                    }
                    (69..=72 | 77..=79 | 84..=86, Value::Bytes(b)) => {
                        Value::TypedArray(typed(n, &b)?)
                    }
                    (_, v) => Value::Tag(n, Box::new(v)),
                }
            }
            7 => match ai {
                20 => Value::Bool(false),
                21 => Value::Bool(true),
                22 => Value::Null,
                25 => Value::Float(half(n as u16)),
                26 => Value::Float(f32::from_bits(n as u32) as f64),
                27 => Value::Float(f64::from_bits(n)),
                _ => return Err(Error::Internal),
            },
            _ => return Err(Error::Internal),
        })
    }
}
pub(crate) fn half(n: u16) -> f64 {
    let sign = if n & 0x8000 == 0 { 1.0 } else { -1.0 };
    let e = (n >> 10) & 31;
    let m = f64::from(n & 1023);
    sign * if e == 0 {
        m * 2f64.powi(-24)
    } else if e == 31 {
        if m == 0.0 {
            f64::INFINITY
        } else {
            f64::NAN
        }
    } else {
        (1024.0 + m) * 2f64.powi(i32::from(e) - 25)
    }
}
fn typed(tag: u64, b: &[u8]) -> Result<TypedArray, Error> {
    macro_rules! read {
        ($v:ident, $t:ty, $w:expr) => {{
            let a = b
                .chunks_exact($w)
                .map(|c| {
                    <[u8; $w]>::try_from(c)
                        .map(<$t>::from_le_bytes)
                        .map_err(|_| Error::Internal)
                })
                .collect::<Result<Vec<_>, _>>()?;
            TypedArray::$v(a)
        }};
    }
    Ok(match tag {
        69 => read!(U16, u16, 2),
        70 => read!(U32, u32, 4),
        71 => read!(U64, u64, 8),
        72 => TypedArray::I8(b.iter().map(|&n| n as i8).collect()),
        77 => read!(I16, i16, 2),
        78 => read!(I32, i32, 4),
        79 => read!(I64, i64, 8),
        84 => read!(F16, u16, 2),
        85 => read!(F32, f32, 4),
        86 => read!(F64, f64, 8),
        _ => return Err(Error::Internal),
    })
}
