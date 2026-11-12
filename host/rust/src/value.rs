//! Owned, exact CBOR values. Map iteration preserves canonical wire order on decode.
//!
//! ```
//! use snug::{Value, Integer};
//! let negative_one = Value::Nint(0);
//! let decimal = Value::Decimal { mantissa: Integer::Uint(15), exponent: -1 };
//! ```

/// An exact integer. Negative arguments represent **−1 − argument**, including
/// bignums: `negative: true, magnitude: [1, 0]` represents −257.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Integer {
    /// Major type 0.
    Uint(u64),
    /// Major type 1's unsigned argument, not an absolute magnitude.
    Nint(u64),
    /// Big-endian CBOR argument; encoding removes leading zeroes and uses
    /// major 0/1 when it fits. Decoding bignums retains their exact bytes.
    BigInt {
        /// Whether the integer is negative (tag 3).
        negative: bool,
        /// Unsigned, big-endian argument.
        magnitude: Vec<u8>,
    },
}

/// RFC 8746 arrays. F16 stores IEEE 754 binary16 bits, preserving −0 and
/// infinities; the generated scanner decides which bit patterns are allowed.
#[derive(Debug, Clone, PartialEq)]
pub enum TypedArray {
    /// Little-endian unsigned 16-bit elements (tag 69).
    U16(Vec<u16>),
    /// Little-endian unsigned 32-bit elements (tag 70).
    U32(Vec<u32>),
    /// Little-endian unsigned 64-bit elements (tag 71).
    U64(Vec<u64>),
    /// Signed bytes (tag 72).
    I8(Vec<i8>),
    /// Little-endian signed 16-bit elements (tag 77).
    I16(Vec<i16>),
    /// Little-endian signed 32-bit elements (tag 78).
    I32(Vec<i32>),
    /// Little-endian signed 64-bit elements (tag 79).
    I64(Vec<i64>),
    /// Little-endian binary16 bit patterns (tag 84).
    F16(Vec<u16>),
    /// Little-endian binary32 elements (tag 85).
    F32(Vec<f32>),
    /// Little-endian binary64 elements (tag 86).
    F64(Vec<f64>),
}

/// An owned value. Encoding sorts maps through kin and refuses duplicate keys.
/// Specialized tags decode to their dedicated variants. `Tag` supplies a wire
/// representation for allowed tags; it cannot bypass profile checks.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// Unsigned integer.
    Uint(u64),
    /// Negative integer **−1 − n**.
    Nint(u64),
    /// A bignum (tag 2 or 3) with its content bytes exactly as decoded. In
    /// preferred serialization it is beyond the major 0/1 range; under the
    /// `valid` preset it may have leading zeroes or a small value, and is still
    /// a data item distinct from the integer of the same value (RFC 8949
    /// §5.6.1), as the duplicate-key check and CDDL matching treat it. Encoding
    /// writes its integer in preferred serialization.
    BigInt {
        /// Tag 3 rather than tag 2.
        negative: bool,
        /// Big-endian CBOR argument, using the same convention as `Integer`.
        magnitude: Vec<u8>,
    },
    /// Byte string (copied on decode).
    Bytes(Vec<u8>),
    /// UTF-8 text.
    Text(String),
    /// Definite array.
    Array(Vec<Value>),
    /// Ordered pairs; decoded keys are in canonical encoded-byte order.
    Map(Vec<(Value, Value)>),
    /// Tag number (any the profile admits, D180) and its content; kin checks
    /// the number and the content.
    Tag(u64, Box<Value>),
    /// Normalized tag 4 decimal, mantissa × 10^exponent.
    Decimal {
        /// Exact integer coefficient.
        mantissa: Integer,
        /// Decimal exponent (current profile requires −1024..−1).
        exponent: i64,
    },
    /// RFC 8746 typed array.
    TypedArray(TypedArray),
    /// Tag 40 row-major multidimensional array.
    NDArray {
        /// Dimension sizes; kin checks product and dimension bounds.
        shape: Vec<u64>,
        /// Plain array or typed array storage.
        data: Box<Value>,
    },
    /// Boolean.
    Bool(bool),
    /// Null.
    Null,
    /// The simple value undefined (f7; profiles with `undefined_value`).
    Undefined,
    /// Any other simple value (RFC 8949 §3.3, D284): 0..=19 or 32..=255
    /// (20..=23 are `Bool`/`Null`/`Undefined`, 24..=31 are reserved and refused
    /// on encode, code `simple`). Written in its shortest form; admitted by
    /// profiles with `undefined_value` (the valid and deterministic presets).
    Simple(u8),
    /// Binary64 host value; kin selects the shortest exact wire width.
    Float(f64),
}
