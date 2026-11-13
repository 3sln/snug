//! Scanner-first decoding. Only fully checked bytes reach the owned builder.
//!
//! ```
//! use snug::{decode, DecodeOptions, Value};
//! assert_eq!(decode(&[0x18, 42], &DecodeOptions::any())?, Value::Uint(42));
//! # Ok::<(), snug::Error>(())
//! ```
use crate::snug::cbor::scan::{code_name, error_offset, scan_cb, scan_options, scan_profile};
use crate::snug::cbor::canon::dc_copy;
use crate::snug::cbor::codes::{CODE_SCRATCH, VC_NONDET, VC_UNSORTED};
use crate::{Error, Integer, TypedArray, Value};

/// Permitted root shape. [`DecodeOptions::default`] (the valid preset)
/// permits any item; [`DecodeOptions::bindle`] requires a map. Not exhaustive
/// (D339), like the other option enums.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum Top {
    /// Require a map at the codec boundary.
    #[default]
    Map,
    /// Permit any profile-valid item.
    Any,
}
/// Map key kinds a profile admits (D120).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
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
#[non_exhaustive]
pub enum Tags {
    /// 2, 3, 4, 40 and the little-endian typed arrays.
    Bindle,
    /// The Bindle set plus 0, 1, 21-24, 32 and 55799 with RFC 8949 content checks.
    Standard,
    /// Any tag number (D180; 64-bit ones too, but not the invalid 65535,
    /// 2^32-1 and 2^64-1), the known tags keeping their content rules.
    Any,
}
/// Scalar float rules (D122).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Floats {
    /// NaN, infinities, -0 and integral floats within ±(2^53-1) refused.
    Bindle,
    /// RFC 8949 §4.2.1: shortest form only; the canonical NaN 0x7e00.
    Deterministic,
}
/// Wire profile options (D120, D260). The `valid` flag admits any valid CBOR
/// (RFC 8949 §5.3); without it every value only removes acceptance relative to
/// RFC 8949 §4.2.1 core deterministic encoding. kin decides every byte.
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
    /// Valid, non-deterministic CBOR (P8.4, D260): indefinite lengths, longer
    /// heads and floats than needed, NaN payloads, keys in any order.
    pub valid: bool,
}
impl Profile {
    /// The valid preset (D260): the deterministic preset's options, admitting
    /// every valid encoding (RFC 8949 §5.3).
    pub const VALID: Profile = Profile {
        keys: Keys::Any,
        tags: Tags::Any,
        floats: Floats::Deterministic,
        undefined_value: true,
        noncharacters: true,
        valid: true,
    };
    /// The deterministic preset (RFC 8949 §4.2.1 checking).
    pub const DETERMINISTIC: Profile = Profile {
        keys: Keys::Any,
        tags: Tags::Any,
        floats: Floats::Deterministic,
        undefined_value: true,
        noncharacters: true,
        valid: false,
    };
    /// The Bindle profile, bit for bit as before P7.1.
    pub const BINDLE: Profile = Profile {
        keys: Keys::Text,
        tags: Tags::Bindle,
        floats: Floats::Bindle,
        undefined_value: false,
        noncharacters: false,
        valid: false,
    };
    /// The kin profile flags (snug.cbor.codes PF_*).
    pub fn flags(&self) -> i32 {
        let keys = match self.keys {
            Keys::Text => 0,
            Keys::Integer => 1,
            Keys::Any => 2,
        };
        let tags = match self.tags {
            Tags::Bindle => 0,
            Tags::Standard => 4,
            Tags::Any => 8,
        };
        keys | tags
            | if self.floats == Floats::Deterministic { 16 } else { 0 }
            | if self.undefined_value { 32 } else { 0 }
            | if self.noncharacters { 64 } else { 0 }
            | if self.valid { 256 } else { 0 }
    }
}
impl Default for Profile {
    fn default() -> Self {
        Self::VALID
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
/// Decode/profile options. The default is the valid preset with any root
/// (D260, D267): any well-formed valid CBOR; [`DecodeOptions::deterministic`]
/// checks RFC 8949 §4.2.1; [`DecodeOptions::bindle`] is the Bindle profile with
/// a map root.
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
            profile: Profile::VALID,
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
    /// The valid preset (the default; any root shape).
    pub fn valid() -> Self {
        Self::default()
    }
    /// The deterministic preset (RFC 8949 §4.2.1 checking; any root shape).
    pub fn deterministic() -> Self {
        Self {
            profile: Profile::DETERMINISTIC,
            ..Self::default()
        }
    }
    /// The default (the valid preset) with any root shape.
    pub fn any() -> Self {
        Self::default()
    }
}
/// What a successful check found (P8.4): the canonical copy when valid input is
/// not its own deterministic form (wire order kept), and whether some map's
/// keys may be out of canonical order.
pub(crate) struct Checked {
    pub(crate) copy: Option<Vec<u8>>,
    pub(crate) unsorted: bool,
}
pub(crate) fn check(bytes: &[u8], options: &DecodeOptions) -> Result<Checked, Error> {
    options.limits.check()?;
    if bytes.len() >= i32::MAX as usize {
        return Err(Error::cbor("too_large"));
    }
    let l = options.limits;
    // The options array's scratch past its 16 frozen words and the canonical
    // buffer (D264), grown on CODE_SCRATCH to the sizes kin asks for.
    let (mut o, mut cb) = (vec![0i32; 16 + 512], vec![0u8; 1024]);
    let grow = |o: &mut Vec<i32>, cb: &mut Vec<u8>| {
        let keep: Vec<i32> = o[..16].to_vec();
        if o[13] as usize > o.len() {
            *o = vec![0; (o[13] as usize).max(2 * o.len())];
            o[..16].copy_from_slice(&keep);
        }
        if o[14] as usize > cb.len() {
            *cb = vec![0; (o[14] as usize).max(2 * cb.len())];
        }
    };
    loop {
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
        let code = scan_cb(bytes, &mut o, &mut cb);
        if code == CODE_SCRATCH {
            grow(&mut o, &mut cb);
            continue;
        }
        if code != 0 {
            return Err(Error::Cbor {
                code: code_name(code),
                offset: usize::try_from(error_offset(&mut o)).ok(),
                subcode: None,
            });
        }
        break;
    }
    let unsorted = o[12] & VC_UNSORTED != 0;
    if o[12] & VC_NONDET == 0 {
        return Ok(Checked { copy: None, unsorted });
    }
    // The DC form of the accepted input (canon.kin dc-copy: the input, then its form).
    let n = bytes.len();
    let need = 2 * n + (n >> 7) + 64;
    if cb.len() < need {
        cb = vec![0; need];
    }
    loop {
        let l = dc_copy(bytes, &mut o, &mut cb);
        if l >= 0 {
            cb.truncate(l as usize);
            cb.drain(..n);
            return Ok(Checked { copy: Some(cb), unsorted });
        }
        let m = 2 * cb.len();
        cb = vec![0; m];
    }
}
/// Decode one complete CBOR document (valid input under the valid preset is
/// read through its canonical copy). Byte strings and typed arrays are owned
/// copies. No partial value escapes a refused document.
pub fn decode(bytes: &[u8], options: &DecodeOptions) -> Result<Value, Error> {
    let c = check(bytes, options)?;
    build(c.copy.as_deref().unwrap_or(bytes))
}

pub(crate) fn build(bytes: &[u8]) -> Result<Value, Error> {
    let mut b = Builder { bytes, at: 0 };
    let v = b.value()?;
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
    /// D357: the value tree is built ITERATIVELY, with the open containers and tags
    /// on a heap stack, so the native stack does not grow with the input's depth
    /// (the recursive builder needed about 8.8 KB per level in a debug build on
    /// Rust 1.98, and overflowed a 2 MiB thread at the 256-level ceiling).
    fn value(&mut self) -> Result<Value, Error> {
        let mut stack: Vec<Open> = Vec::new();
        loop {
            // the checked input's depth is at most 256 (+ tag/embedded slack)
            if stack.len() > 258 {
                return Err(Error::Internal);
            }
            let (major, ai, n) = self.head()?;
            let mut done = match major {
                4 if n > 0 => {
                    stack.push(Open::Array(Vec::new(), n));
                    None
                }
                5 if n > 0 => {
                    stack.push(Open::Map(Vec::new(), None, n));
                    None
                }
                6 => {
                    stack.push(Open::Tag(n));
                    None
                }
                _ => Some(self.leaf(major, ai, n)?),
            };
            while let Some(v) = done.take() {
                match stack.last_mut() {
                    None => return Ok(v),
                    Some(Open::Array(a, left)) => {
                        a.push(v);
                        *left -= 1;
                        if *left == 0 {
                            if let Some(Open::Array(a, _)) = stack.pop() {
                                done = Some(Value::Array(a));
                            }
                        }
                    }
                    Some(Open::Map(a, key, left)) => match key.take() {
                        None => *key = Some(v),
                        Some(k) => {
                            a.push((k, v));
                            *left -= 1;
                            if *left == 0 {
                                if let Some(Open::Map(a, _, _)) = stack.pop() {
                                    done = Some(Value::Map(a));
                                }
                            }
                        }
                    },
                    Some(Open::Tag(n)) => {
                        let n = *n;
                        stack.pop();
                        done = Some(Self::tagged(n, v)?);
                    }
                }
            }
        }
    }
    /// A scalar, or an empty array or map (major 4/5 with no entries).
    fn leaf(&mut self, major: u8, ai: u8, n: u64) -> Result<Value, Error> {
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
            4 => Value::Array(Vec::new()),
            5 => Value::Map(Vec::new()),
            7 => match ai {
                20 => Value::Bool(false),
                21 => Value::Bool(true),
                22 => Value::Null,
                23 => Value::Undefined,
                0..=19 | 24 => Value::Simple(n as u8),
                25 => Value::Float(half(n as u16)),
                26 => Value::Float(f32::from_bits(n as u32) as f64),
                27 => Value::Float(f64::from_bits(n)),
                _ => return Err(Error::Internal),
            },
            _ => return Err(Error::Internal),
        })
    }
    /// A tag's value from its number and its built content.
    fn tagged(n: u64, v: Value) -> Result<Value, Error> {
        Ok(
                match (n, v) {
                    (2 | 3, Value::Bytes(magnitude)) => Value::BigInt {
                        negative: n == 3,
                        magnitude,
                    },
                    // D265/D267: Decimal and NDArray only for content inside their
                    // Bindle invariants; other valid tag-4/40 content stays a Tag.
                    (4, Value::Array(a)) if decimal_ok(&a) => {
                        let mut it = a.into_iter();
                        let exp = match it.next() {
                            Some(Value::Nint(e)) => -1 - e as i64,
                            _ => return Err(Error::Internal),
                        };
                        Value::Decimal {
                            exponent: exp,
                            mantissa: Self::integer(it.next().ok_or(Error::Internal)?)?,
                        }
                    }
                    (40, Value::Array(a)) if ndarray_ok(&a) => {
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
                },
        )
    }
}
/// An open container or tag of the iterative builder: its entries so far and
/// how many are left (a map's pending key), or the tag number.
enum Open {
    Array(Vec<Value>, u64),
    Map(Vec<(Value, Value)>, Option<Value>, u64),
    Tag(u64),
}
fn decimal_ok(a: &[Value]) -> bool {
    // exponent -1024..-1; mantissa an integer or bignum, non-zero, not divisible by 10
    let e = match a.first() {
        Some(Value::Nint(n)) if *n <= 1023 => *n,
        _ => return false,
    };
    let _ = e;
    let m10 = |b: &[u8]| b.iter().fold(0u32, |r, &x| (r * 256 + u32::from(x)) % 10);
    match a.get(1) {
        Some(Value::Uint(m)) => *m != 0 && m % 10 != 0,
        Some(Value::Nint(m)) => (m % 10 + 1) % 10 != 0,
        // a bignum mantissa in preferred serialization only (beyond 64 bits, no leading
        // zero), as the JS builder (D342)
        Some(Value::BigInt { negative, magnitude }) if magnitude.len() >= 9 && magnitude[0] != 0 => {
            let r = m10(magnitude);
            if *negative { (r + 1) % 10 != 0 } else { r != 0 }
        }
        _ => false,
    }
}
fn ndarray_ok(a: &[Value]) -> bool {
    let shape_ok = match a.first() {
        Some(Value::Array(s)) => !s.is_empty() && s.len() <= 8
            && s.iter().all(|d| matches!(d, Value::Uint(n) if *n > 0 && *n < (1u64 << 53))),
        _ => false,
    };
    shape_ok && matches!(a.get(1), Some(Value::Array(_)) | Some(Value::TypedArray(_)))
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
