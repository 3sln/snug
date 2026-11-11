//! Typed byte builder. Maps are sorted at `end`; the full profile is checked
//! at `finish`. Every error is sticky, and incomplete output cannot escape.
//!
//! ```
//! use snug::{Writer, EncodeOptions};
//! let mut w = Writer::new(&EncodeOptions::default())?;
//! w.begin_map(1)?.key("answer")?.uint(42)?.end()?;
//! let bytes = w.finish()?;
//! assert_eq!(bytes[0], 0xa1);
//! # Ok::<(), snug::Error>(())
//! ```
use crate::{encode::Output, DecodeOptions, EncodeOptions, Error, Integer, TypedArray, Value};

struct Frame {
    map: bool,
    left: usize,
    pairs: Vec<i32>,
}
/// One deterministic document builder. It writes bytes immediately; map closes
/// may allocate temporary permutation storage. No bytes are returned until
/// finish succeeds. It is not a transport streaming API.
pub struct Writer {
    output: Output,
    frames: Vec<Frame>,
    root: bool,
    finished: bool,
    failure: Option<Error>,
}
impl Writer {
    /// Start a builder, checking option ceilings before allocating output.
    pub fn new(options: &EncodeOptions) -> Result<Self, Error> {
        Ok(Self {
            output: Output::new(*options)?,
            frames: Vec::new(),
            root: false,
            finished: false,
            failure: None,
        })
    }
    /// The first error; subsequent calls answer `writer_failed`.
    pub fn failure(&self) -> Option<&Error> {
        self.failure.as_ref()
    }
    fn ready(&mut self) -> Result<(), Error> {
        if self.failure.is_some() {
            return Err(Error::cbor("writer_failed"));
        }
        if self.finished {
            return self.record(Err(Error::cbor("grammar")));
        }
        Ok(())
    }
    fn record<T>(&mut self, r: Result<T, Error>) -> Result<T, Error> {
        if let Err(e) = &r {
            if self.failure.is_none() {
                self.failure = Some(e.clone());
            }
        }
        r
    }
    fn slot(&mut self, key: bool) -> Result<(), Error> {
        self.ready()?;
        let valid = if let Some(f) = self.frames.last_mut() {
            if f.left == 0 || (f.map && (f.left % 2 == 0) != key) || (!f.map && key) {
                false
            } else {
                f.left -= 1;
                true
            }
        } else if self.root || key {
            false
        } else {
            self.root = true;
            true
        };
        if !valid {
            return self.record(Err(Error::cbor("grammar")));
        }
        Ok(())
    }
    /// Write any owned-model value by reference, without cloning its tree.
    pub fn value(&mut self, v: &Value) -> Result<&mut Self, Error> {
        self.slot(false)?;
        let r = self.output.value(v, self.frames.len());
        self.record(r)?;
        Ok(self)
    }
    /// Write an unsigned integer.
    pub fn uint(&mut self, n: u64) -> Result<&mut Self, Error> {
        self.value(&Value::Uint(n))
    }
    /// Write a negative integer using the CBOR argument (−1−n).
    pub fn nint(&mut self, n: u64) -> Result<&mut Self, Error> {
        self.value(&Value::Nint(n))
    }
    /// Write a signed integer, including i128::MIN exactly.
    pub fn int(&mut self, n: i128) -> Result<&mut Self, Error> {
        let argument = if n < 0 { (-1 - n) as u128 } else { n as u128 };
        self.value(&Value::BigInt {
            negative: n < 0,
            magnitude: argument.to_be_bytes().to_vec(),
        })
    }
    /// Write an arbitrary exact integer using unsigned big-endian CBOR
    /// argument bytes. Negative means −1−argument; leading zeroes normalize.
    pub fn bigint(&mut self, negative: bool, magnitude: &[u8]) -> Result<&mut Self, Error> {
        self.slot(false)?;
        let r = self.output.integer(negative, magnitude);
        self.record(r)?;
        Ok(self)
    }
    /// Write a binary64 host value; kin chooses the width (and, under the Bindle
    /// float rules, refuses NaN, infinities, -0 and safe-range integers: `float`).
    pub fn float(&mut self, n: f64) -> Result<&mut Self, Error> {
        self.value(&Value::Float(n))
    }
    /// Write a boolean.
    pub fn bool(&mut self, v: bool) -> Result<&mut Self, Error> {
        self.value(&Value::Bool(v))
    }
    /// Write null.
    pub fn null(&mut self) -> Result<&mut Self, Error> {
        self.value(&Value::Null)
    }
    /// Write undefined (f7); the profile's `undefined_value` decides at finish.
    pub fn undefined(&mut self) -> Result<&mut Self, Error> {
        self.value(&Value::Undefined)
    }
    /// Write a simple value 0..=19 or 32..=255 (D284) in its shortest form;
    /// 20..=31 answer `simple`, and the profile's `undefined_value` decides at finish.
    pub fn simple(&mut self, n: u8) -> Result<&mut Self, Error> {
        self.value(&Value::Simple(n))
    }
    /// Write UTF-8 text. Noncharacters are refused by kin at finish.
    pub fn text(&mut self, v: &str) -> Result<&mut Self, Error> {
        self.slot(false)?;
        let r = self
            .output
            .head(3, v.len() as u64)
            .and_then(|()| self.output.raw(v.as_bytes()));
        self.record(r)?;
        Ok(self)
    }
    /// Write byte content without retaining the supplied slice.
    pub fn bytes(&mut self, v: &[u8]) -> Result<&mut Self, Error> {
        self.slot(false)?;
        let r = self
            .output
            .head(2, v.len() as u64)
            .and_then(|()| self.output.raw(v));
        self.record(r)?;
        Ok(self)
    }
    /// Write a normalized decimal (kin checks normalization at finish).
    pub fn decimal(&mut self, mantissa: Integer, exponent: i64) -> Result<&mut Self, Error> {
        self.value(&Value::Decimal { mantissa, exponent })
    }
    /// Write a typed array, copying its little-endian elements into the output.
    pub fn typed(&mut self, v: &TypedArray) -> Result<&mut Self, Error> {
        self.slot(false)?;
        let r = self.output.typed(v);
        self.record(r)?;
        Ok(self)
    }
    /// Write row-major multidimensional storage, checking shape and content
    /// through kin at finish. The supplied value tree is borrowed, not cloned.
    pub fn ndarray(&mut self, shape: &[u64], data: &Value) -> Result<&mut Self, Error> {
        self.slot(false)?;
        let r = self.output.ndarray(shape, data, self.frames.len());
        self.record(r)?;
        Ok(self)
    }
    fn begin(&mut self, n: usize, map: bool) -> Result<&mut Self, Error> {
        self.slot(false)?;
        let left = n.checked_mul(if map { 2 } else { 1 });
        let r = left.ok_or(Error::cbor("too_many_entries"));
        let left = self.record(r)?;
        let r = self
            .output
            .container(if map { 5 } else { 4 }, n, self.frames.len());
        self.record(r)?;
        self.frames.push(Frame {
            map,
            left,
            pairs: Vec::new(),
        });
        Ok(self)
    }
    /// Begin a definite array owing exactly `n` values.
    pub fn begin_array(&mut self, n: usize) -> Result<&mut Self, Error> {
        self.begin(n, false)
    }
    /// Begin a definite map owing exactly `n` key/value pairs.
    pub fn begin_map(&mut self, n: usize) -> Result<&mut Self, Error> {
        self.begin(n, true)
    }
    /// Write the next map's text key. Input order is unrestricted.
    pub fn key(&mut self, key: &str) -> Result<&mut Self, Error> {
        self.key_value(&Value::Text(key.to_owned()))
    }
    /// Write a key using the value model. The profile's key kinds (and, under
    /// `Keys::Text`, top-level safe integer labels with `cose`) decide at finish.
    pub fn key_value(&mut self, key: &Value) -> Result<&mut Self, Error> {
        self.slot(true)?;
        let start = self.output.bytes.len() as i32;
        let r = self.output.value(key, self.frames.len());
        self.record(r)?;
        let end = self.output.bytes.len() as i32;
        let r = self
            .frames
            .last_mut()
            .ok_or(Error::Internal)
            .map(|f| f.pairs.extend([start, end]));
        self.record(r)?;
        Ok(self)
    }
    /// Close a complete container, sorting maps through kin.
    pub fn end(&mut self) -> Result<&mut Self, Error> {
        self.ready()?;
        if self.frames.last().is_none_or(|f| f.left != 0) {
            return self.record(Err(Error::cbor("grammar")));
        }
        let r = self.frames.pop().ok_or(Error::Internal);
        let f = self.record(r)?;
        if f.map {
            let r = self.output.map_end(&f.pairs);
            self.record(r)?;
        }
        Ok(self)
    }
    /// Check the finished document and transfer the output allocation. The
    /// writer becomes finished; a second finish reports `grammar`.
    pub fn finish(&mut self) -> Result<Vec<u8>, Error> {
        self.ready()?;
        if !self.root || !self.frames.is_empty() {
            return self.record(Err(Error::cbor("grammar")));
        }
        let options: DecodeOptions = self.output.options.decode_options();
        let r = crate::decode::check(&self.output.bytes, &options);
        self.record(r)?;
        self.finished = true;
        Ok(std::mem::take(&mut self.output.bytes))
    }
}
