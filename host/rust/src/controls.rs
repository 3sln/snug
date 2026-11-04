//! Extension controls (D082, D140-D142): custom CDDL control operators whose
//! verdict is a host predicate over the item's encoded bytes.
//!
//! A registry ([`Controls`]) is given to the compiler (an unregistered
//! `.name` is a schema error naming it) and again when a serialised Program
//! that uses controls is loaded (a missing one is
//! `Error::MissingControls`). kin decides when a control is asked: only for an
//! item its leaf is queried for, whole, after the profile walk, and charged one
//! budget unit per item byte. A predicate must be a pure function of its two
//! inputs; `max_bytes` bounds the item it is asked about (a longer item fails
//! the control with the reason `control_size`, under every source).
//!
//! ```
//! use snug::{Schema, CompileOptions, Scratch, controls::Controls};
//! let controls = Controls::generic();
//! let options = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
//! let schema = Schema::compile("name = tstr .chars (1..3)", &options)?;
//! assert!(schema.validate(&[0x62, b'h', b'i'], "name", &mut Scratch::new()).is_ok());
//! assert!(schema.validate(&[0x64, b'a', b'b', b'c', b'd'], "name", &mut Scratch::new()).is_err());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
use crate::snug::vm::controls as kc;
use std::collections::BTreeMap;
use std::sync::Arc;

/// The default bound on the item a control is asked about.
pub const DEFAULT_MAX_BYTES: u32 = 65536;

/// One extension control's predicate (a trait object in a [`Controls`] registry).
pub trait Control: Send + Sync {
    /// The verdict for `item` (its whole encoding) under the control's `argument`
    /// (the encoding the compiler made of the controller).
    fn check(&self, argument: &[u8], item: &[u8]) -> bool;
    /// Items longer than this fail the control without asking (`control_size`).
    fn max_bytes(&self) -> u32 {
        DEFAULT_MAX_BYTES
    }
    /// Whether an argument is acceptable, asked once per use at compile time.
    fn argument(&self, _argument: &[u8]) -> bool {
        true
    }
}

impl<F: Fn(&[u8], &[u8]) -> bool + Send + Sync> Control for F {
    fn check(&self, argument: &[u8], item: &[u8]) -> bool {
        self(argument, item)
    }
}

/// A registry of named controls (names: an identifier that is not a built-in control).
#[derive(Clone, Default)]
pub struct Controls {
    pub(crate) map: BTreeMap<String, Arc<dyn Control>>,
    /// Admit them under the `bus` compiler profile (refused there by default).
    pub in_bus: bool,
}

impl std::fmt::Debug for Controls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Controls").field("names", &self.map.keys().collect::<Vec<_>>()).field("in_bus", &self.in_bus).finish()
    }
}

const BUILTIN: [&str; 21] = ["size", "bits", "lt", "le", "gt", "ge", "eq", "ne", "and", "within", "regexp",
    "cbor", "cborseq", "default", "feature", "cat", "det", "plus", "pcre", "abnf", "abnfb"];

fn name_ok(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty() && b.len() <= 64 && !BUILTIN.contains(&name)
        && b.iter().enumerate().all(|(i, &c)| c.is_ascii_alphabetic() || c == b'_' || (i > 0 && (c.is_ascii_digit() || c == b'-')))
}

impl Controls {
    pub fn new() -> Self {
        Self::default()
    }
    /// The generic controls `.chars`, `.unique` and `.samelen`.
    pub fn generic() -> Self {
        Self::new().with("chars", Chars).with("unique", Unique).with("samelen", Samelen)
    }
    /// Register `control` as `.name` (replacing one of that name). Panics on a
    /// name that is not an identifier or is a built-in control's.
    pub fn with(mut self, name: &str, control: impl Control + 'static) -> Self {
        self.insert(name, Arc::new(control));
        self
    }
    /// Register a shared control as `.name`; see [`Controls::with`].
    pub fn insert(&mut self, name: &str, control: Arc<dyn Control>) {
        assert!(name_ok(name), "snug: invalid control name");
        self.map.insert(name.to_owned(), control);
    }
    pub fn get(&self, name: &str) -> Option<&Arc<dyn Control>> {
        self.map.get(name)
    }
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.map.keys().map(String::as_str)
    }
    /// The registry words after the compile options (snug.compile.ext): BTreeMap order
    /// is bytewise name order, as kin requires.
    #[doc(hidden)]
    pub fn words(&self) -> Vec<i32> {
        if self.map.is_empty() {
            return Vec::new();
        }
        let mut w = vec![self.map.len() as i32, self.in_bus as i32];
        for (name, c) in &self.map {
            w.push(name.len() as i32);
            w.push(c.max_bytes().min(i32::MAX as u32) as i32);
            w.extend(name.bytes().map(i32::from));
        }
        w
    }
}

/// The names of a Program's extension controls, in id order (format 1.1, D141).
pub fn program_controls(p: &[i32], b: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    if p.len() < 64 {
        return names;
    }
    let (n, mut i) = (p[30].max(0) as usize, p[31].max(0) as usize);
    let end = i + p[39].max(0) as usize;
    while names.len() < n && i < end && i < b.len() {
        let (mut len, mut c) = ((b[i] & 31) as usize, i + 1);
        if len == 24 {
            len = b[c] as usize;
            c += 1;
        }
        names.push(String::from_utf8_lossy(&b[c..c + len]).into_owned());
        i = c + len;
    }
    names
}

/// `.chars n` / `.chars lo..hi`: a text string of that many code points.
pub struct Chars;
impl Control for Chars {
    fn check(&self, a: &[u8], item: &[u8]) -> bool {
        kc::chars_ok(a, 0, a.len() as i32, item, 0, item.len() as i32)
    }
    fn argument(&self, a: &[u8]) -> bool {
        kc::chars_arg(a, 0, a.len() as i32)
    }
}

/// `.unique <any>`: an array whose elements' encodings are pairwise distinct.
pub struct Unique;
impl Control for Unique {
    fn check(&self, _a: &[u8], item: &[u8]) -> bool {
        let mut t = vec![0i32; kc::unique_words(item.len() as i32) as usize];
        kc::unique_ok(item, 0, item.len() as i32, &mut t)
    }
    fn argument(&self, a: &[u8]) -> bool {
        kc::any_arg(a, 0, a.len() as i32)
    }
}

/// `.samelen "a"` / `.samelen ["a", "b"]`: the named members of a map, where
/// present, hold arrays or typed arrays of one element count.
pub struct Samelen;
impl Control for Samelen {
    fn check(&self, a: &[u8], item: &[u8]) -> bool {
        kc::samelen_ok(a, 0, a.len() as i32, item, 0, item.len() as i32)
    }
    fn argument(&self, a: &[u8]) -> bool {
        kc::names_arg(a, 0, a.len() as i32)
    }
}
