//! Extension controls (D082, D140-D142): custom CDDL control operators whose
//! verdict is a host predicate over the item's encoded bytes.
//!
//! A registry ([`Controls`]) is given to the compiler (an unregistered
//! `.name` is a schema error naming it) and again when a serialised Program
//! that uses controls is loaded (a missing one is
//! `Error::MissingControls`). kin decides when a control is asked: only for an
//! item its leaf is queried for, whole, after the profile walk. A predicate
//! must be a pure function of its two inputs; `max_bytes` bounds the item it is
//! asked about (a longer item fails the control with the reason
//! `control_size`, under every source).
//!
//! **Budget (D193).** Every call is charged a fixed number of units, then the
//! predicate's [`Control::cost`] (by default one unit per item byte), BEFORE it
//! runs; a cost above what the budget has left stops validation with `budget`
//! without calling. The VM cannot interrupt or measure host code: what a
//! predicate does with its CPU is the host's responsibility, and `cost` is how
//! a host keeps a slow predicate inside the budget (the default budget assumes
//! roughly 20 ns of CPU per unit). The generic controls ([`Chars`],
//! [`Unique`], [`Samelen`]) instead meter their own work in kin, against the
//! budget that remains, so JS and Rust charge them identically.
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
use std::cell::RefCell;
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
    /// The budget units charged BEFORE `check` is asked about an item of
    /// `item_bytes` bytes (default: one per byte). A cost above what remains
    /// stops validation with `budget` without calling `check`.
    fn cost(&self, item_bytes: u32) -> u64 {
        u64::from(item_bytes)
    }
    /// Why `argument` is refused, when `argument` answers false (shown in the
    /// schema error; snug's ABNF controls only, D334).
    #[doc(hidden)]
    fn argument_detail(&self, _argument: &[u8]) -> Option<String> {
        None
    }
    /// `argument` under the compile's ABNF parse mode, `abnf_lenient` (D340); other
    /// controls ignore the mode.
    #[doc(hidden)]
    fn argument_in(&self, argument: &[u8], _abnf_lenient: bool) -> bool {
        self.argument(argument)
    }
    /// `argument_detail` under the compile's ABNF parse mode (D340).
    #[doc(hidden)]
    fn argument_detail_in(&self, argument: &[u8], _abnf_lenient: bool) -> Option<String> {
        self.argument_detail(argument)
    }
    /// Metered in kin (snug's generic and ABNF controls only; not a public contract):
    /// the argument prepared once per EXT leaf, or None for a host predicate.
    #[doc(hidden)]
    fn prepare(&self, _pool: &[u8], _ao: i32, _al: i32) -> Option<Vec<i32>> {
        None
    }
    /// Metered run (with `prepare`): a verdict word, see `snug.vm.controls`.
    #[doc(hidden)]
    fn run(&self, _pool: &[u8], _ao: i32, _prepared: &[i32], _b: &[u8], _s: i32, _e: i32, _room: i32) -> i32 {
        -1
    }
}

/// The verdict word of one port call (D190): a metered control's run, else
/// `cost` checked against `room`, then `check`.
#[doc(hidden)]
pub fn port(c: &dyn Control, prepared: Option<&[i32]>, pool: &[u8], ao: i32, al: i32, b: &[u8], s: i32, e: i32,
            room: i32) -> i32 {
    if let Some(t) = prepared {
        return c.run(pool, ao, t, b, s, e, room);
    }
    let units = c.cost((e - s) as u32);
    if units > room.max(0) as u64 || units > 0x7fff_fffd {
        return -1;
    }
    let u = units as i32;
    if c.check(&pool[ao as usize..(ao + al) as usize], &b[s as usize..e as usize]) { u } else { -2 - u }
}

/// A Program's EXT leaves' prepared arguments for the metered controls among
/// `bound` (id order): (id, argument offset) -> table.
#[doc(hidden)]
pub fn prepare_all(p: &[i32], b: &[u8], bound: &[Arc<dyn Control>]) -> BTreeMap<(i32, i32), Vec<i32>> {
    let mut out = BTreeMap::new();
    if p.len() < 64 {
        return out;
    }
    let (at, n) = (p[43].max(0) as usize, p[16].max(0) as usize);
    for l in 0..n {
        let o = at + 8 * l;
        if o + 4 >= p.len() || p[o] & 255 != 18 {
            continue;
        }
        let (id, ao, al) = (p[o + 2], p[o + 3], p[o + 4]);
        if let Some(c) = bound.get(id as usize) {
            if !out.contains_key(&(id, ao)) {
                if let Some(t) = c.prepare(b, ao, al) {
                    out.insert((id, ao), t);
                }
            }
        }
    }
    out
}

thread_local! {
    /// One meter + `.unique` scratch per thread, reused (kin never re-enters a
    /// run); three words per element of the largest array asked about (the
    /// profile walk bounds elements by the entries limit), given back past 2^20.
    static SCRATCH: RefCell<Vec<i32>> = RefCell::new(vec![0; 64]);
}

fn metered(need: i32, room: i32, f: impl FnOnce(&mut [i32]) -> i32) -> i32 {
    SCRATCH.with(|cell| {
        let mut t = cell.borrow_mut();
        if t.len() < need as usize {
            t.resize(need as usize, 0);
        }
        kc::meter_init(&mut t, room);
        let r = f(&mut t);
        if t.len() > 1 << 20 {
            *t = vec![0; 64];
        }
        r
    })
}

/// A metered control asked directly (no budget): prepare, run, the verdict.
fn direct(c: &dyn Control, a: &[u8], item: &[u8]) -> bool {
    let t = c.prepare(a, 0, a.len() as i32).unwrap_or_default();
    c.run(a, 0, &t, item, 0, item.len() as i32, i32::MAX) >= 0
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
        direct(self, a, item)
    }
    fn argument(&self, a: &[u8]) -> bool {
        kc::chars_arg(a, 0, a.len() as i32)
    }
    fn prepare(&self, pool: &[u8], ao: i32, al: i32) -> Option<Vec<i32>> {
        let mut t = vec![0; 2];
        Some(if kc::chars_prep(pool, ao, al, &mut t) == 0 { t } else { vec![1, 0] })
    }
    fn run(&self, _pool: &[u8], _ao: i32, t: &[i32], b: &[u8], s: i32, e: i32, room: i32) -> i32 {
        metered(kc::M_WORDS, room, |m| kc::chars_run(t, b, s, e, m))
    }
}

/// `.unique <any>`: an array whose elements' encodings are pairwise distinct.
pub struct Unique;
impl Control for Unique {
    fn check(&self, a: &[u8], item: &[u8]) -> bool {
        direct(self, a, item)
    }
    fn argument(&self, a: &[u8]) -> bool {
        kc::any_arg(a, 0, a.len() as i32)
    }
    fn prepare(&self, _pool: &[u8], _ao: i32, _al: i32) -> Option<Vec<i32>> {
        Some(Vec::new())
    }
    fn run(&self, _pool: &[u8], _ao: i32, _t: &[i32], b: &[u8], s: i32, e: i32, room: i32) -> i32 {
        metered(kc::unique_words(b, s, e), room, |m| kc::unique_run(b, s, e, m))
    }
}

/// `.samelen "a"` / `.samelen ["a", "b"]`: the named members of a map, where
/// present, hold arrays or typed arrays of one element count.
pub struct Samelen;
impl Control for Samelen {
    fn check(&self, a: &[u8], item: &[u8]) -> bool {
        direct(self, a, item)
    }
    fn argument(&self, a: &[u8]) -> bool {
        kc::names_arg(a, 0, a.len() as i32)
    }
    fn prepare(&self, pool: &[u8], ao: i32, al: i32) -> Option<Vec<i32>> {
        let mut t = vec![0; kc::samelen_words(pool, ao, al) as usize];
        Some(if kc::samelen_prep(pool, ao, al, &mut t) == 0 { t } else { Vec::new() })
    }
    fn run(&self, pool: &[u8], ao: i32, t: &[i32], b: &[u8], s: i32, e: i32, room: i32) -> i32 {
        if t.is_empty() {
            return -2;
        }
        metered(kc::M_WORDS, room, |m| kc::samelen_run(pool, ao, t, b, s, e, m))
    }
}
