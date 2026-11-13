//! Borrowed navigation over a fully checked document. Rust's shared borrow
//! prevents mutation of the input while any view/cursor is alive.
//!
//! ```
//! use snug::{View, DecodeOptions};
//! let bytes = [0xa1, 0x61, b'a', 7];
//! let root = View::open(&bytes, &DecodeOptions::default())?;
//! assert_eq!(root.get("a").and_then(|v| v.uint()), Some(7));
//! assert_eq!(root.raw(), &bytes);
//! # Ok::<(), snug::Error>(())
//! ```
//! The checked borrow cannot be invalidated in safe Rust:
//!
//! ```compile_fail
//! use snug::{View, DecodeOptions};
//! let mut bytes = vec![0xa0];
//! let view = View::open(&bytes, &DecodeOptions::default()).unwrap();
//! bytes[0] = 0xff;
//! println!("{:?}", view.raw());
//! ```
use crate::snug::nav::walk::{nav_child, nav_find, nav_find_any, nav_head, nav_init, nav_skip};
use crate::{DecodeOptions, Error, Value};

fn state() -> [i32; 8] {
    let mut o = [0; 8];
    nav_init(&mut o, i32::MAX);
    o
}
/// A checked item borrowing its original document. Cloning copies only offsets
/// and the shared borrow. No unchecked constructor is public.
#[derive(Clone, Copy, Debug)]
pub struct View<'a> {
    bytes: &'a [u8],
    start: usize,
    end: usize,
    depth: usize,
    // P8.4: some map's keys may be out of canonical order (valid CBOR); lookups compare every key
    unsorted: bool,
}
#[allow(dead_code)] // the sequence reader mints its views with it (D215)
pub(crate) fn checked(bytes: &[u8]) -> View<'_> {
    checked_keys(bytes, false)
}
/// A checked document whose maps may hold keys out of canonical order (valid CBOR).
pub(crate) fn checked_keys(bytes: &[u8], unsorted: bool) -> View<'_> {
    View {
        bytes,
        start: 0,
        end: bytes.len(),
        depth: 0,
        unsorted,
    }
}
/// A checked document that owns its bytes: the input, or -- for
/// valid input that is not its own deterministic form -- its canonical copy
/// (wire order kept), which a borrowing [`View`] cannot alias.
#[derive(Clone, Debug)]
pub struct Document {
    bytes: Vec<u8>,
    unsorted: bool,
}
impl Document {
    /// Check `bytes` and keep them, or their canonical copy, for viewing.
    pub fn open(bytes: &[u8], options: &DecodeOptions) -> Result<Self, Error> {
        let c = crate::decode::check(bytes, options)?;
        Ok(Self { bytes: c.copy.unwrap_or_else(|| bytes.to_vec()), unsorted: c.unsorted })
    }
    pub(crate) fn from_checked(bytes: Vec<u8>, unsorted: bool) -> Self {
        Self { bytes, unsorted }
    }
    /// The root view, borrowing this document.
    pub fn view(&self) -> View<'_> {
        checked_keys(&self.bytes, self.unsorted)
    }
    /// The checked bytes (the canonical copy when one was made).
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}
impl<'a> View<'a> {
    /// Scan the whole document before exposing its root. Borrowed byte/string
    /// accessors retain exactly the input lifetime and perform no copying.
    /// Valid input that is not its own deterministic form cannot be borrowed
    /// (`Error::Usage("owned_view")`): open a [`Document`] instead.
    pub fn open(bytes: &'a [u8], options: &DecodeOptions) -> Result<Self, Error> {
        let c = crate::decode::check(bytes, options)?;
        if c.copy.is_some() {
            return Err(Error::Usage("owned_view"));
        }
        Ok(checked_keys(bytes, c.unsorted))
    }
    fn head(&self) -> Option<(usize, u8, u8, u64)> {
        let mut o = state();
        let p = nav_head(self.bytes, &mut o, self.start as i32, self.end as i32);
        if p < 0 {
            return None;
        }
        Some((
            p as usize,
            o[0] as u8,
            o[1] as u8,
            ((o[2] as u32 as u64) << 32) | o[3] as u32 as u64,
        ))
    }
    fn item(&self, start: usize) -> Option<Self> {
        if start >= self.end {
            return None;
        }
        let end = nav_skip(self.bytes, &mut state(), start as i32, self.end as i32);
        if end < 0 {
            return None;
        }
        Some(Self {
            bytes: self.bytes,
            start,
            end: end as usize,
            depth: self.depth + 1,
            unsorted: self.unsorted,
        })
    }
    /// Absolute byte offset in the original document.
    pub fn offset(&self) -> usize {
        self.start
    }
    /// Physical nesting depth (root is zero; tag content adds one).
    pub fn depth(&self) -> usize {
        self.depth
    }
    /// CBOR major type, 0..7.
    pub fn major(&self) -> u8 {
        self.bytes.get(self.start).map_or(0, |b| b >> 5)
    }
    /// Exact canonical encoding of this item, as a shared borrow.
    pub fn raw(&self) -> &'a [u8] {
        self.bytes.get(self.start..self.end).unwrap_or(&[])
    }
    /// Array/map entry count or string byte length; tags/scalars answer None.
    pub fn len(&self) -> Option<usize> {
        let (_, m, _, n) = self.head()?;
        if (2..=5).contains(&m) {
            usize::try_from(n).ok()
        } else {
            None
        }
    }
    /// Whether an array/map/string is empty. Scalars answer false.
    pub fn is_empty(&self) -> bool {
        self.len() == Some(0)
    }
    /// Array element by sequential navigation, without materializing siblings.
    pub fn at(&self, index: usize) -> Option<Self> {
        if self.major() != 4 || index >= i32::MAX as usize {
            return None;
        }
        let p = nav_child(
            self.bytes,
            &mut state(),
            self.start as i32,
            index as i32,
            self.end as i32,
        );
        if p < 0 {
            None
        } else {
            self.item(p as usize)
        }
    }
    /// Map key and value at a canonical pair index.
    pub fn entry(&self, index: usize) -> Option<(Self, Self)> {
        if self.major() != 5 || index >= i32::MAX as usize {
            return None;
        }
        let p = nav_child(
            self.bytes,
            &mut state(),
            self.start as i32,
            index as i32,
            self.end as i32,
        );
        if p < 0 {
            return None;
        }
        let key = self.item(p as usize)?;
        Some((key, self.item(key.end)?))
    }
    /// Map lookup by text key. Search uses the checked canonical order.
    pub fn get(&self, key: &str) -> Option<Self> {
        self.get_key(&Value::Text(key.to_owned()))
    }
    /// Map lookup by exact key value (including COSE integer labels). The key
    /// must itself be encodable under the current profile; otherwise None.
    pub fn get_key(&self, key: &Value) -> Option<Self> {
        if self.major() != 5 {
            return None;
        }
        let k = crate::encode(key, &crate::EncodeOptions::default()).ok()?;
        let find = if self.unsorted { nav_find_any } else { nav_find };
        let p = find(
            self.bytes,
            &mut state(),
            self.start as i32,
            &k,
            0,
            k.len() as i32,
            self.end as i32,
        );
        if p < 0 {
            None
        } else {
            self.item(p as usize)
        }
    }
    /// Unsigned major-0 value, without narrowing through f64.
    pub fn uint(&self) -> Option<u64> {
        let (_, m, _, n) = self.head()?;
        (m == 0).then_some(n)
    }
    /// Exact major-0/1 value (bignums use `value()` instead).
    pub fn int(&self) -> Option<i128> {
        let (_, m, _, n) = self.head()?;
        match m {
            0 => Some(i128::from(n)),
            1 => Some(-1 - i128::from(n)),
            _ => None,
        }
    }
    /// Floating-point scalar (integer kinds answer None).
    pub fn float(&self) -> Option<f64> {
        let (_, m, ai, n) = self.head()?;
        if m != 7 {
            return None;
        }
        match ai {
            25 => Some(crate::decode::half(n as u16)),
            26 => Some(f32::from_bits(n as u32) as f64),
            27 => Some(f64::from_bits(n)),
            _ => None,
        }
    }
    /// Text content borrowed from the document.
    pub fn text(&self) -> Option<&'a str> {
        std::str::from_utf8(self.content(3)?).ok()
    }
    /// Byte-string content borrowed from the document.
    pub fn bytes(&self) -> Option<&'a [u8]> {
        self.content(2)
    }
    fn content(&self, major: u8) -> Option<&'a [u8]> {
        let (p, m, _, n) = self.head()?;
        if m != major {
            return None;
        }
        self.bytes.get(p..p.checked_add(usize::try_from(n).ok()?)?)
    }
    /// Boolean value (other simple kinds answer None).
    pub fn bool(&self) -> Option<bool> {
        match self.raw().first().copied()? {
            0xf4 => Some(false),
            0xf5 => Some(true),
            _ => None,
        }
    }
    /// A simple value other than false/true/null/undefined: 0..=19 or
    /// 32..=255; every other kind answers None.
    pub fn simple(&self) -> Option<u8> {
        let (_, m, ai, n) = self.head()?;
        match (m, ai) {
            (7, 0..=19) => Some(ai),
            (7, 24) => Some(n as u8),
            _ => None,
        }
    }
    /// Null predicate, false for every other kind.
    pub fn is_null(&self) -> bool {
        self.raw().first() == Some(&0xf6)
    }
    /// Tag number and checked content, including specialized tags.
    pub fn tag(&self) -> Option<(u64, Self)> {
        let (p, m, _, n) = self.head()?;
        if m != 6 {
            return None;
        }
        Some((n, self.item(p)?))
    }
    /// Portable typed-array accessor. Reads little-endian elements safely even
    /// when content is unaligned; no native typed slice aliases input bytes.
    pub fn typed_view(&self) -> Option<TypedView<'a>> {
        let (tag, content) = self.tag()?;
        let width = match tag {
            72 => 1,
            69 | 77 | 84 => 2,
            70 | 78 | 85 => 4,
            71 | 79 | 86 => 8,
            _ => return None,
        };
        Some(TypedView {
            tag,
            width,
            bytes: content.bytes()?,
        })
    }
    /// Materialize just this checked subtree; no new profile scan is needed.
    pub fn value(&self) -> Result<Value, Error> {
        crate::decode::build(self.raw())
    }
    /// Start a cursor at this checked item.
    pub fn cursor(&self) -> Cursor<'a> {
        Cursor {
            current: *self,
            key: None,
            index: 0,
            parents: Vec::new(),
        }
    }
}
/// A portable typed-array element; integers are always exact.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TypedElement {
    /// Unsigned element.
    Uint(u64),
    /// Signed element.
    Int(i64),
    /// IEEE element widened exactly to f64.
    Float(f64),
}
/// Borrowed RFC 8746 content with portable little-endian reads.
#[derive(Debug, Clone, Copy)]
pub struct TypedView<'a> {
    tag: u64,
    width: usize,
    bytes: &'a [u8],
}
impl<'a> TypedView<'a> {
    /// Wire tag.
    pub fn tag(&self) -> u64 {
        self.tag
    }
    /// Element count.
    pub fn len(&self) -> usize {
        self.bytes.len() / self.width
    }
    /// Whether the array has no elements.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
    /// Raw little-endian bytes, potentially unaligned.
    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }
    /// Read an element without allocation. Out-of-bounds indexes answer None.
    pub fn get(&self, index: usize) -> Option<TypedElement> {
        let p = index.checked_mul(self.width)?;
        let b = self.bytes.get(p..p.checked_add(self.width)?)?;
        let n = b.iter().rev().fold(0u64, |a, &b| (a << 8) | u64::from(b));
        Some(match self.tag {
            69..=71 => TypedElement::Uint(n),
            72 => TypedElement::Int(n as i8 as i64),
            77 => TypedElement::Int(n as i16 as i64),
            78 => TypedElement::Int(n as i32 as i64),
            79 => TypedElement::Int(n as i64),
            84 => TypedElement::Float(crate::decode::half(n as u16)),
            85 => TypedElement::Float(f32::from_bits(n as u32) as f64),
            86 => TypedElement::Float(f64::from_bits(n)),
            _ => return None,
        })
    }
}
/// Mutable traversal position. Moving to siblings skips structural heads with
/// the core; scalar content is never materialized. The stack grows only on enter.
pub struct Cursor<'a> {
    current: View<'a>,
    key: Option<View<'a>>,
    index: usize,
    parents: Vec<(View<'a>, usize, Option<View<'a>>)>,
}
impl<'a> Cursor<'a> {
    /// Current checked view, copied without copying bytes.
    pub fn view(&self) -> View<'a> {
        self.current
    }
    /// Map key at this position, or None at array/tag/root positions.
    pub fn key(&self) -> Option<View<'a>> {
        self.key
    }
    /// Zero-based pair/array index; zero at the cursor root.
    pub fn index(&self) -> usize {
        self.index
    }
    /// Enter the first array element/map value/tag content. Empty containers
    /// and scalars leave the position unchanged and answer false.
    pub fn enter(&mut self) -> bool {
        let next = match self.current.major() {
            4 => self.current.at(0).map(|v| (None, v)),
            5 => self.current.entry(0).map(|(k, v)| (Some(k), v)),
            6 => self.current.tag().map(|(_, v)| (None, v)),
            _ => None,
        };
        let Some((key, value)) = next else {
            return false;
        };
        self.parents.push((self.current, self.index, self.key));
        self.current = value;
        self.key = key;
        self.index = 0;
        true
    }
    /// Advance to the next sibling. At the last sibling/root, answer false and
    /// leave position unchanged. Maps advance by whole key/value pairs.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> bool {
        let Some((parent, _, _)) = self.parents.last() else {
            return false;
        };
        if parent.major() == 6 || self.current.end >= parent.end {
            return false;
        }
        let Some(first) = parent.item(self.current.end) else {
            return false;
        };
        let (key, value) = if parent.major() == 5 {
            let Some(v) = parent.item(first.end) else {
                return false;
            };
            (Some(first), v)
        } else {
            (None, first)
        };
        self.current = value;
        self.key = key;
        self.index += 1;
        true
    }
    /// Return to the enclosing item; at the cursor root answer false.
    pub fn up(&mut self) -> bool {
        let Some((view, index, key)) = self.parents.pop() else {
            return false;
        };
        self.current = view;
        self.index = index;
        self.key = key;
        true
    }
}
