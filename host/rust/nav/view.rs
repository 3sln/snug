//! A minimal Rust view over checked Bindle CBOR (architecture §16, P5 first
//! slice): open = the full profile scan, then navigation by the generated kin
//! primitives (`snug::nav::walk`). Borrowed only: the view holds `&[u8]`, so
//! the borrow checker enforces the no-mutation contract the JS host documents.
use crate::snug::cbor::scan::{scan, scan_options};
use crate::snug::nav::walk::{
    nav_child, nav_find, nav_head, nav_init, nav_length, nav_skip, N_HI, N_LO, N_MAJOR,
    NAV_WORDS,
};

/// The profile limits of cbor.mjs's LIMITS (host/js/src/limits.mjs).
pub const MAX_BYTES: i32 = 1_500_000;
pub const MAX_DEPTH: i32 = 32;
pub const MAX_ENTRIES: i32 = 65_536;
pub const MAX_ITEMS: i32 = 131_072;

#[derive(Clone, Copy)]
pub struct View<'a> {
    b: &'a [u8],
    pos: i32,
}

/// A refusal: the scanner's code (cbor.mjs's CBORFault code as an integer).
#[derive(Debug, PartialEq, Eq)]
pub struct Refused(pub i32);

impl<'a> View<'a> {
    /// Check `b` in full (top-level map unless `top_any`), then view its root.
    pub fn open(b: &'a [u8], top_any: bool) -> Result<View<'a>, Refused> {
        if b.len() >= i32::MAX as usize {
            return Err(Refused(20));
        }
        let mut o = [0i32; 16];
        scan_options(&mut o, top_any as i32, 0, MAX_BYTES, MAX_DEPTH, MAX_ENTRIES, MAX_ITEMS);
        let c = scan(b, &mut o);
        if c != 0 {
            return Err(Refused(c));
        }
        Ok(View { b, pos: 0 })
    }
    fn state() -> [i32; NAV_WORDS as usize] {
        let mut o = [0i32; NAV_WORDS as usize];
        nav_init(&mut o, i32::MAX);
        o
    }
    fn end(&self) -> i32 {
        self.b.len() as i32
    }
    /// The major type (0..7).
    pub fn major(&self) -> i32 {
        let mut o = Self::state();
        nav_head(self.b, &mut o, self.pos, self.end());
        o[N_MAJOR as usize]
    }
    /// An array's or map's entry count, a string's byte length.
    pub fn len(&self) -> Option<usize> {
        let mut o = Self::state();
        let n = nav_length(self.b, &mut o, self.pos, self.end());
        if n >= 0 && o[N_MAJOR as usize] != 6 {
            return Some(n as usize);
        }
        nav_head(self.b, &mut o, self.pos, self.end());
        let m = o[N_MAJOR as usize];
        if m == 2 || m == 3 {
            Some(o[N_LO as usize] as usize)
        } else {
            None
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == Some(0)
    }
    /// The canonical encoding of this item.
    pub fn raw(&self) -> &'a [u8] {
        let mut o = Self::state();
        let e = nav_skip(self.b, &mut o, self.pos, self.end());
        &self.b[self.pos as usize..e as usize]
    }
    /// Element i of an array.
    pub fn at(&self, i: usize) -> Option<View<'a>> {
        if self.major() != 4 || i >= i32::MAX as usize {
            return None;
        }
        let mut o = Self::state();
        let p = nav_child(self.b, &mut o, self.pos, i as i32, self.end());
        (p >= 0).then_some(View { b: self.b, pos: p })
    }
    /// The value under a text key of a map.
    pub fn get(&self, key: &str) -> Option<View<'a>> {
        let k = encode_text_key(key);
        let mut o = Self::state();
        let p = nav_find(self.b, &mut o, self.pos, &k, 0, k.len() as i32, self.end());
        (p >= 0).then_some(View { b: self.b, pos: p })
    }
    /// An unsigned integer (major 0).
    pub fn uint(&self) -> Option<u64> {
        let mut o = Self::state();
        nav_head(self.b, &mut o, self.pos, self.end());
        (o[N_MAJOR as usize] == 0).then(|| ((o[N_HI as usize] as u32 as u64) << 32) | o[N_LO as usize] as u32 as u64)
    }
    /// A text string, borrowed.
    pub fn text(&self) -> Option<&'a str> {
        let mut o = Self::state();
        let c = nav_head(self.b, &mut o, self.pos, self.end());
        if o[N_MAJOR as usize] != 3 {
            return None;
        }
        let n = o[N_LO as usize] as usize;
        std::str::from_utf8(&self.b[c as usize..c as usize + n]).ok()
    }
}

/// The deterministic encoding of a text string (a map key).
pub fn encode_text_key(s: &str) -> Vec<u8> {
    let n = s.len();
    let mut k = Vec::with_capacity(n + 9);
    if n < 24 {
        k.push(0x60 | n as u8);
    } else if n < 256 {
        k.extend_from_slice(&[0x78, n as u8]);
    } else if n < 65536 {
        k.push(0x79);
        k.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        k.push(0x7a);
        k.extend_from_slice(&(n as u32).to_be_bytes());
    }
    k.extend_from_slice(s.as_bytes());
    k
}
