//! RFC 9165 §3's `.abnf` and `.abnfb` controls: ABNF (RFC 5234 with
//! RFC 7405's case-sensitive strings) over a string's Unicode scalars (`.abnf`)
//! or bytes (`.abnfb`). They are not in a registry unless asked for:
//! [`Controls::with_abnf`] adds both, to the registry given to the compiler and
//! to a Program's loader. Without them a schema using `.abnf` is refused
//! (`unsupported_control`) and a stored Program using it fails to load
//! (`Error::MissingControls`).
//!
//! The controller (a text string, or a byte string holding UTF-8) is one
//! element, the start, then optionally a newline and rules, each line ending with a
//! newline (LF or CRLF). Core rules are not imported. It is checked at compile time:
//! prose-val `<...>`, syntax errors and undefined rules are `control_value`, with the
//! ABNF line and column. Parsing is strict RFC 5234 + RFC 7405 + RFC 9165 §3 unless
//! [`CompileOptions::abnf`](crate::CompileOptions::abnf) is
//! [`AbnfMode::Lenient`](crate::compile::AbnfMode), which also admits snug's
//! non-RFC forms; the mode is in the source key. It is
//! prepared once when a Program is bound. The match is language membership (an
//! Earley recognizer in the generated core, `snug.abnf`), metered against the budget that
//! remains, so JS, Rust and the wasm SDK give the same verdicts and charges.
//!
//! ```
//! use snug::{Schema, CompileOptions, Scratch, controls::Controls};
//! let controls = Controls::new().with_abnf();
//! let options = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
//! let schema = Schema::compile(r#"id = text .abnf "(1*DIGIT)\nDIGIT = %x30-39\n""#, &options)?;
//! assert!(schema.validate(&[0x62, b'4', b'2'], "id", &mut Scratch::new()).is_ok());
//! assert!(schema.validate(&[0x62, b'4', b'x'], "id", &mut Scratch::new()).is_err());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
use crate::controls::{Control, Controls, DEFAULT_MAX_BYTES};
use crate::snug::abnf as ka;
use std::cell::RefCell;
use std::sync::Arc;

/// `.abnf` (scalars) or `.abnfb` (bytes); the item bound defaults to 65,536 bytes
/// and the matcher's scratch cap to 4,194,304 words (16 MiB, the PEG group arena's
/// default).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Abnf {
    bytes: bool,
    max_bytes: u32,
    max_words: i32,
}

impl Abnf {
    /// The `.abnf` control: the string's Unicode scalars.
    pub const fn text() -> Self {
        Abnf { bytes: false, max_bytes: DEFAULT_MAX_BYTES, max_words: ka::ABNF_DEFAULT_WORDS }
    }
    /// The `.abnfb` control: the string's bytes.
    pub const fn bytes() -> Self {
        Abnf { bytes: true, max_bytes: DEFAULT_MAX_BYTES, max_words: ka::ABNF_DEFAULT_WORDS }
    }
    /// The same control with another bound on the item it is asked about.
    pub const fn with_max_bytes(self, max_bytes: u32) -> Self {
        Abnf { max_bytes, ..self }
    }
    /// The same control with another matcher scratch cap, in 32-bit words, clamped to
    /// 65,536..=16,777,216: a match that needs more stops validation with `budget`.
    pub const fn with_max_words(self, max_words: u32) -> Self {
        let w = if max_words < ka::ABNF_MIN_WORDS as u32 { ka::ABNF_MIN_WORDS }
            else if max_words > ka::ABNF_MAX_WORDS as u32 { ka::ABNF_MAX_WORDS } else { max_words as i32 };
        Abnf { max_words: w, ..self }
    }
    /// The name it binds: `abnf` or `abnfb`.
    pub const fn name(&self) -> &'static str {
        if self.bytes { "abnfb" } else { "abnf" }
    }
}

/// A controller on its own (ABNF text): Ok, or why the compiler would refuse it under
/// the default strict parse mode.
pub fn check_abnf(text: &str) -> Result<(), String> {
    check_abnf_in(text, crate::compile::AbnfMode::Strict)
}

/// `check_abnf` under a given parse mode.
pub fn check_abnf_in(text: &str, mode: crate::compile::AbnfMode) -> Result<(), String> {
    let b = text.as_bytes();
    let n = b.len();
    let mut a = Vec::with_capacity(n + 5);
    if n < 24 {
        a.push(0x60 | n as u8);
    } else if n < 256 {
        a.extend([0x78, n as u8]);
    } else if n < 65536 {
        a.extend([0x79, (n >> 8) as u8, n as u8]);
    } else {
        a.push(0x7a);
        a.extend((n as u32).to_be_bytes());
    }
    a.extend_from_slice(b);
    match detail(&a, mode == crate::compile::AbnfMode::Lenient) {
        None => Ok(()),
        Some(d) => Err(d),
    }
}

fn detail(a: &[u8], lenient: bool) -> Option<String> {
    let mut t = vec![0; ka::abnf_words(a.len() as i32) as usize];
    let code = ka::abnf_prep(a, 0, a.len() as i32, &mut t, if lenient { ka::MODE_LENIENT } else { ka::MODE_STRICT });
    if code == 0 {
        return None;
    }
    let line = ka::abnf_error_line(&t);
    // the hint names the option for a strict-only refusal (D340)
    Some(if line > 0 {
        format!("{} at ABNF line {}, column {}{}", ka::abnf_error_name(code), line, ka::abnf_error_column(&t), ka::abnf_error_hint(code))
    } else {
        format!("{}{}", ka::abnf_error_name(code), ka::abnf_error_hint(code))
    })
}

thread_local! {
    /// One scratch per thread, reused (the core never re-enters a run), first sized
    /// by `abnf_scratch_words`. When the core needs more (`abnf_more`: the size it
    /// suggests, within `ABNF_MAX_WORDS`) the run is repeated with that (not
    /// charged), so verdicts and units never depend on its size. Given back
    /// after a run past 2^20 words.
    static SCRATCH: RefCell<Vec<i32>> = RefCell::new(vec![0; 4096]);
}

#[allow(clippy::too_many_arguments)]
fn run(mode: i32, cap: i32, t: &[i32], b: &[u8], s: i32, e: i32, room: i32) -> i32 {
    if t.is_empty() {
        return -2;
    }
    SCRATCH.with(|cell| {
        let mut m = cell.borrow_mut();
        let need = ka::abnf_scratch_words(t, e - s, cap) as usize;
        if m.len() < need {
            m.resize(need, 0);
        }
        // kin's suggestion at least doubles the scratch and never passes the cap, so
        // this reruns at most log2(cap / need) + 1 times (at most 2x the work, uncharged)
        let mut reruns = 0;
        loop {
            let r = ka::abnf_run(t, mode, b, s, e, &mut m, room, cap);
            let more = ka::abnf_more(&m) as usize;
            if r == -1 && more > m.len() {
                assert!(more >= 2 * m.len() && reruns <= 24, "snug: abnf scratch growth");
                reruns += 1;
                m.resize(more, 0);
                continue;
            }
            if m.len() > 1 << 20 {
                *m = vec![0; 4096];
            }
            return r;
        }
    })
}

impl Control for Abnf {
    fn check(&self, a: &[u8], item: &[u8]) -> bool {
        let t = self.prepare(a, 0, a.len() as i32).unwrap_or_default();
        self.run(a, 0, &t, item, 0, item.len() as i32, i32::MAX) >= 0
    }
    fn max_bytes(&self) -> u32 {
        self.max_bytes
    }
    fn argument(&self, a: &[u8]) -> bool {
        detail(a, false).is_none()
    }
    fn argument_detail(&self, a: &[u8]) -> Option<String> {
        detail(a, false)
    }
    fn argument_in(&self, a: &[u8], lenient: bool) -> bool {
        detail(a, lenient).is_none()
    }
    fn argument_detail_in(&self, a: &[u8], lenient: bool) -> Option<String> {
        detail(a, lenient)
    }
    fn prepare(&self, pool: &[u8], ao: i32, al: i32) -> Option<Vec<i32>> {
        // lenient: what the strict default admits means the same there, and the compile
        // already checked the schema's mode (D340)
        let mut t = vec![0; ka::abnf_words(al) as usize];
        if ka::abnf_prep(pool, ao, al, &mut t, ka::MODE_LENIENT) != 0 {
            return Some(Vec::new());
        }
        t.truncate(ka::abnf_table_words(&t) as usize);
        Some(t)
    }
    fn run(&self, _pool: &[u8], _ao: i32, t: &[i32], b: &[u8], s: i32, e: i32, room: i32) -> i32 {
        run(if self.bytes { 1 } else { 0 }, self.max_words, t, b, s, e, room)
    }
}

impl Controls {
    /// Add `.abnf` and `.abnfb` (the built-in names only this module binds).
    pub fn with_abnf(mut self) -> Self {
        self.insert_abnf(Abnf::text());
        self.insert_abnf(Abnf::bytes());
        self
    }
    /// Add one ABNF control under its own name (e.g. with another item bound).
    pub fn insert_abnf(&mut self, control: Abnf) {
        self.map.insert(control.name().to_owned(), Arc::new(control));
    }
}
