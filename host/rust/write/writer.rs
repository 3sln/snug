//! A minimal Rust Writer over the kin writer primitives (snug.write.*, P5.4),
//! for the cross-host parity gate (`bb write-test`). The same grammar as the
//! JS Writer (host/js/src/writer.mjs): a count of remaining items per open
//! container, keys before values in maps, exactly one root, and a failure
//! that leaves the writer failed for good. Values arrive in the host-to-kin
//! representation: integers as a sign and big-endian magnitude bytes of the
//! CBOR argument, floats as binary64 bits, text as UTF-8.
use crate::snug::write::float::put_float;
use crate::snug::write::int::put_int;
use crate::snug::write::map::{close_map, S_BUDGET, S_COMPARES};
use crate::snug::write::out::{key_after, put_head, WR_NEED};

/// A refusal or misuse: a cbor.mjs-style code, never a value.
#[derive(Debug, Clone, PartialEq)]
pub struct Fault(pub &'static str);

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Root,
    Array,
    Map,
    Done,
    Failed,
}

struct Frame {
    kind: Kind,
    left: i64,
    base: usize,
}

pub struct Writer {
    buf: Vec<u8>,
    pos: usize,
    kind: Kind,
    left: i64,
    base: usize,
    depth: usize,
    stack: Vec<Frame>,
    pairs: Vec<i32>,
    tmp: Vec<u8>,
    x: Vec<i32>,
    s: [i32; 4],
    items: u64,
    sorted: bool,
    pub max_depth: usize,
    pub max_entries: u64,
    pub max_items: u64,
}

fn code_name(code: i32) -> &'static str {
    match code {
        5 => "key_type",
        6 => "key_order",
        7 => "duplicate_key",
        9 => "float",
        12 => "bignum",
        _ => "malformed",
    }
}

/// Noncharacters (U+FDD0..U+FDEF, U+xFFFE/U+xFFFF), refused in text as the JS host does.
fn scalar_text(s: &str) -> bool {
    s.chars().all(|c| {
        let u = c as u32;
        !((0xFDD0..=0xFDEF).contains(&u) || (u & 0xFFFE) == 0xFFFE)
    })
}

impl Default for Writer {
    fn default() -> Self {
        Self::new(false)
    }
}

impl Writer {
    pub fn new(keys_sorted: bool) -> Writer {
        Writer {
            buf: vec![0; 64],
            pos: 0,
            kind: Kind::Root,
            left: 1,
            base: 0,
            depth: 0,
            stack: Vec::new(),
            pairs: Vec::new(),
            tmp: Vec::new(),
            x: Vec::new(),
            s: [0; 4],
            items: 0,
            sorted: keys_sorted,
            max_depth: 32,
            max_entries: 65_536,
            max_items: 131_072,
        }
    }

    fn fail(&mut self, code: &'static str) -> Fault {
        if self.kind != Kind::Failed {
            self.kind = Kind::Failed;
            self.left = 0;
        }
        Fault(code)
    }
    fn misuse(&mut self) -> Fault {
        if self.kind == Kind::Failed {
            return Fault("writer_failed");
        }
        self.fail("grammar")
    }
    fn slot(&mut self) -> Result<(), Fault> {
        if self.left == 0 || (self.kind == Kind::Map && self.left % 2 == 0) {
            return Err(self.misuse());
        }
        self.left -= 1;
        self.count()
    }
    fn count(&mut self) -> Result<(), Fault> {
        self.items += 1;
        if self.items > self.max_items {
            return Err(self.fail("too_many_items"));
        }
        Ok(())
    }
    fn ensure(&mut self, need: usize) -> Result<(), Fault> {
        let want = self.pos + need;
        if want > i32::MAX as usize {
            return Err(self.fail("too_large"));
        }
        if want > self.buf.len() {
            let mut size = self.buf.len() * 2;
            while size < want {
                size *= 2;
            }
            self.buf.resize(size.min(i32::MAX as usize), 0);
        }
        Ok(())
    }
    /// After a kin write answered r < 0: grow for a short answer, else the refusal.
    fn short(&mut self, r: i32) -> Result<(), Fault> {
        let need = -(r as i64) - WR_NEED as i64;
        if need <= 0 {
            return Err(self.fail(code_name(-r)));
        }
        self.ensure(need as usize)
    }
    fn head(&mut self, major: i32, hi: i32, lo: i32) -> Result<(), Fault> {
        let mut p = put_head(&mut self.buf, self.pos as i32, major, hi, lo);
        if p < 0 {
            self.short(p)?;
            p = put_head(&mut self.buf, self.pos as i32, major, hi, lo);
        }
        if p < 0 {
            return Err(self.fail("malformed"));
        }
        self.pos = p as usize;
        Ok(())
    }
    fn raw(&mut self, b: &[u8]) -> Result<(), Fault> {
        self.ensure(b.len())?;
        self.buf[self.pos..self.pos + b.len()].copy_from_slice(b);
        self.pos += b.len();
        Ok(())
    }
    fn text_bytes(&mut self, s: &str, code: &'static str) -> Result<(), Fault> {
        if !scalar_text(s) {
            return Err(self.fail(code));
        }
        let b = s.as_bytes();
        if b.len() > i32::MAX as usize {
            return Err(self.fail("too_large"));
        }
        self.head(3, 0, b.len() as i32)?;
        self.raw(b)
    }

    /// An integer: `negative` with the big-endian magnitude of its CBOR argument (n, or -1 - n).
    pub fn int(&mut self, negative: bool, magnitude: &[u8]) -> Result<(), Fault> {
        self.slot()?;
        let significant = magnitude.iter().position(|&b| b != 0).map_or(0, |i| magnitude.len() - i);
        if significant > 8 && self.depth >= self.max_depth {
            return Err(self.fail("depth"));
        }
        // At most 129 significant bytes go to kin: enough for its refusal beyond 128.
        let m = &magnitude[magnitude.len() - significant.min(129)..];
        let neg = if negative { 1 } else { 0 };
        let mut p = put_int(&mut self.buf, self.pos as i32, neg, m, 0, m.len() as i32);
        if p < 0 {
            self.short(p)?;
            p = put_int(&mut self.buf, self.pos as i32, neg, m, 0, m.len() as i32);
        }
        if p < 0 {
            return Err(self.fail(code_name(-p)));
        }
        self.pos = p as usize;
        Ok(())
    }
    /// A float from its binary64 bits (kin chooses the width or refuses).
    pub fn float_bits(&mut self, hi: i32, lo: i32) -> Result<(), Fault> {
        self.slot()?;
        let mut p = put_float(&mut self.buf, self.pos as i32, hi, lo);
        if p < 0 {
            self.short(p)?;
            p = put_float(&mut self.buf, self.pos as i32, hi, lo);
        }
        if p < 0 {
            return Err(self.fail(code_name(-p)));
        }
        self.pos = p as usize;
        Ok(())
    }
    pub fn bool(&mut self, v: bool) -> Result<(), Fault> {
        self.slot()?;
        self.head(7, 0, if v { 21 } else { 20 })
    }
    pub fn null(&mut self) -> Result<(), Fault> {
        self.slot()?;
        self.head(7, 0, 22)
    }
    pub fn text(&mut self, s: &str) -> Result<(), Fault> {
        self.slot()?;
        self.text_bytes(s, "text")
    }
    pub fn bytes(&mut self, b: &[u8]) -> Result<(), Fault> {
        self.slot()?;
        if b.len() > i32::MAX as usize {
            return Err(self.fail("too_large"));
        }
        self.head(2, 0, b.len() as i32)?;
        self.raw(b)
    }
    fn begin(&mut self, n: u64, major: i32, kind: Kind) -> Result<(), Fault> {
        self.slot()?;
        if self.depth >= self.max_depth {
            return Err(self.fail("depth"));
        }
        if n > self.max_entries {
            return Err(self.fail("too_many_entries"));
        }
        self.head(major, (n >> 32) as i32, n as u32 as i32)?;
        self.stack.push(Frame { kind: self.kind, left: self.left, base: self.base });
        self.depth += 1;
        self.kind = kind;
        self.left = if kind == Kind::Map { 2 * n as i64 } else { n as i64 };
        self.base = self.pairs.len();
        Ok(())
    }
    pub fn begin_array(&mut self, n: u64) -> Result<(), Fault> {
        self.begin(n, 4, Kind::Array)
    }
    pub fn begin_map(&mut self, n: u64) -> Result<(), Fault> {
        self.begin(n, 5, Kind::Map)
    }
    pub fn key(&mut self, k: &str) -> Result<(), Fault> {
        if self.kind != Kind::Map || self.left == 0 || self.left % 2 == 1 {
            return Err(self.misuse());
        }
        self.left -= 1;
        self.count()?;
        let ks = self.pos as i32;
        self.text_bytes(k, "key_type")?;
        let at = self.pairs.len();
        if self.sorted && at > self.base {
            let r = key_after(&self.buf, self.pairs[at - 2], self.pairs[at - 1], ks, self.pos as i32);
            if r < 0 {
                return Err(self.fail(code_name(-r)));
            }
        }
        self.pairs.push(ks);
        self.pairs.push(self.pos as i32);
        Ok(())
    }
    pub fn end(&mut self) -> Result<(), Fault> {
        if self.kind != Kind::Array && self.kind != Kind::Map {
            return Err(self.misuse());
        }
        if self.left != 0 {
            return Err(self.fail("grammar"));
        }
        if self.kind == Kind::Map {
            let n = ((self.pairs.len() - self.base) / 2) as i32;
            if !self.sorted && n >= 2 {
                self.s[S_COMPARES as usize] = 0;
                self.s[S_BUDGET as usize] = i32::MAX;
                loop {
                    let r = close_map(&mut self.buf, &self.pairs, self.base as i32, n, self.pos as i32, &mut self.tmp, &mut self.x, &mut self.s);
                    if r == 0 {
                        break;
                    }
                    let need = -(r as i64) - WR_NEED as i64;
                    if need < 0 {
                        return Err(self.fail(code_name(-r)));
                    }
                    if self.x.len() < 2 * n as usize {
                        self.x.resize(2 * n as usize, 0);
                    }
                    if self.tmp.len() < need as usize {
                        self.tmp.resize(need as usize, 0);
                    }
                }
            }
            self.pairs.truncate(self.base);
        }
        let f = self.stack.pop().ok_or(Fault("malformed"))?;
        self.depth -= 1;
        self.kind = f.kind;
        self.left = f.left;
        self.base = f.base;
        Ok(())
    }
    /// The comparisons the last map close charged.
    pub fn compares(&self) -> i32 {
        self.s[S_COMPARES as usize]
    }
    pub fn finish(&mut self) -> Result<Vec<u8>, Fault> {
        if self.kind != Kind::Root || self.left != 0 {
            return Err(self.misuse());
        }
        self.kind = Kind::Done;
        Ok(self.buf[..self.pos].to_vec())
    }
}
