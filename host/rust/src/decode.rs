//! Scanner-first decoding. Only fully checked bytes reach the owned builder.
//!
//! ```
//! use snug::{decode, DecodeOptions, Value};
//! assert_eq!(decode(&[0x18, 42], &DecodeOptions::any())?, Value::Uint(42));
//! # Ok::<(), snug::Error>(())
//! ```
use crate::snug::cbor::scan::{code_name, error_offset, scan, scan_options, scan_profile};
use crate::{Error, Integer, TypedArray, Value};

/// Permitted root shape. [`DecodeOptions::default`] (the deterministic preset)
/// permits any item; [`DecodeOptions::bindle`] requires a map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Top {
    /// Require a map at the codec boundary.
    #[default]
    Map,
    /// Permit any profile-valid item.
    Any,
}
/// Map key kinds a profile admits (D120).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keys {
    /// Text keys only (plus top-level safe integer labels with `cose`).
    Text,
    /// Text and integer (major 0/1) keys.
    Integer,
    /// Any item as a key, ordered by its complete encoding.
    Any,
}
/// Tag sets (D121).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tags {
    /// 2, 3, 4, 40 and the little-endian typed arrays.
    Bindle,
    /// The Bindle set plus 0, 1, 21-24, 32 and 55799 with RFC 8949 content checks.
    Standard,
}
/// Scalar float rules (D122).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Floats {
    /// NaN, infinities, -0 and integral floats within ±(2^53-1) refused.
    Bindle,
    /// RFC 8949 §4.2.1: shortest form only; the canonical NaN 0x7e00.
    Deterministic,
}
/// Wire profile options (D120). Every value only removes acceptance relative
/// to RFC 8949 §4.2.1 core deterministic encoding; kin decides every byte.
///
/// ```
/// use snug::{decode, DecodeOptions, Profile, Keys, Value};
/// let int_keys = [0xa1, 0x01, 0x02];
/// assert_eq!(decode(&int_keys, &DecodeOptions::default())?, Value::Map(vec![(Value::Uint(1), Value::Uint(2))]));
/// let text_only = DecodeOptions { profile: Profile { keys: Keys::Text, ..Profile::DETERMINISTIC }, ..DecodeOptions::default() };
/// assert_eq!(decode(&int_keys, &text_only).unwrap_err().code(), "key_type");
/// # Ok::<(), snug::Error>(())
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Profile {
    /// Map key kinds.
    pub keys: Keys,
    /// Tag set.
    pub tags: Tags,
    /// Scalar float rules.
    pub floats: Floats,
    /// The simple value undefined (f7).
    pub undefined_value: bool,
    /// Unicode noncharacters in text.
    pub noncharacters: bool,
}
impl Profile {
    /// The deterministic preset (the default).
    pub const DETERMINISTIC: Profile = Profile {
        keys: Keys::Any,
        tags: Tags::Standard,
        floats: Floats::Deterministic,
        undefined_value: true,
        noncharacters: true,
    };
    /// The Bindle profile, bit for bit as before P7.1.
    pub const BINDLE: Profile = Profile {
        keys: Keys::Text,
        tags: Tags::Bindle,
        floats: Floats::Bindle,
        undefined_value: false,
        noncharacters: false,
    };
    /// The kin profile flags (snug.cbor.codes PF_*).
    pub fn flags(&self) -> i32 {
        let keys = match self.keys {
            Keys::Text => 0,
            Keys::Integer => 1,
            Keys::Any => 2,
        };
        keys | if self.tags == Tags::Standard { 4 } else { 0 }
            | if self.floats == Floats::Deterministic { 16 } else { 0 }
            | if self.undefined_value { 32 } else { 0 }
            | if self.noncharacters { 64 } else { 0 }
    }
}
impl Default for Profile {
    fn default() -> Self {
        Self::DETERMINISTIC
    }
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
/// Decode/profile options. The default is the deterministic preset with any
/// root (D081); [`DecodeOptions::bindle`] is the Bindle profile with a map root.
/// Root shape, COSE labels and limits stay independent settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeOptions {
    /// Required root shape.
    pub top: Top,
    /// Under `Keys::Text`: permit safe integer labels in the top-level map.
    pub cose: bool,
    /// Bounded scan resources.
    pub limits: Limits,
    /// The wire profile.
    pub profile: Profile,
}
impl Default for DecodeOptions {
    fn default() -> Self {
        Self {
            top: Top::Any,
            cose: false,
            limits: Limits::default(),
            profile: Profile::DETERMINISTIC,
        }
    }
}
impl DecodeOptions {
    /// The Bindle preset (including map root).
    pub fn bindle() -> Self {
        Self {
            top: Top::Map,
            profile: Profile::BINDLE,
            ..Self::default()
        }
    }
    /// The deterministic preset (the default; any root shape).
    pub fn deterministic() -> Self {
        Self::default()
    }
    /// The deterministic preset with any root shape (the default).
    pub fn any() -> Self {
        Self::default()
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
    scan_profile(&mut o, options.profile.flags());
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
                23 => Value::Undefined,
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
