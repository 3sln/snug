//! Validation against a compiled schema (P3.4): the Rust host of the kin VM
//! (`snug::vm`). Every accept/refuse decision is kin's; this module owns the
//! Program (copied on load and verified by `vm-verify`), a caller-owned
//! scratch (`&mut Scratch`: the JS single-isolate argument is not assumed here,
//! architecture §8), the limit words and the shape of the result. Paths are
//! rendered from the Program's key table only (program.md §9.3).
use crate::snug::cbor::scan::code_name;
use crate::snug::program::verify::vm_verify;
use crate::snug::vm::api::{vm_rule_index, vm_scratch_init, vm_scratch_words, vm_validate, vm_validate_span};

/// A verified Program (docs/program.md format 1) from a store the host trusts.
#[derive(Debug, Clone)]
pub struct Program {
    p: Vec<i32>,
    b: Vec<u8>,
}

/// `vm-verify` refused the Program: the word (or pool byte) offset and check id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refused {
    pub at: i32,
    pub check: i32,
}

impl Program {
    /// Verify and keep a private copy (program.md §11: P and B must not change
    /// between verification and validation).
    pub fn new(p: &[i32], b: &[u8]) -> Result<Program, Refused> {
        let nl = if p.len() > 16 { p[16].clamp(0, 1 << 20) } else { 0 };
        let mut s = vec![0i32; 48 + 2 * nl as usize + 64];
        s[16] = 1;
        s[17] = nl;
        if vm_verify(p, b, &mut s) != 0 {
            return Err(Refused { at: s[35], check: s[36] });
        }
        Ok(Program { p: p.to_vec(), b: b.to_vec() })
    }
    /// A rule's index (its position in RULES), or None.
    pub fn rule(&self, name: &str) -> Option<i32> {
        let i = vm_rule_index(&self.p, &self.b, name.as_bytes());
        if i < 0 { None } else { Some(i) }
    }
    /// The text (or integer label) of key `id` from KEYS.
    pub fn key_name(&self, id: i32) -> String {
        let at = self.p[46] as usize + 2 * id as usize;
        let (off, len) = (self.p[at] as usize, self.p[at + 1] as usize);
        let k = &self.b[off..off + len];
        let (major, ai) = (k[0] >> 5, k[0] & 31);
        let (arg, h): (u64, usize) = match ai {
            24 => (k[1] as u64, 2),
            25 => (u16::from_be_bytes([k[1], k[2]]) as u64, 3),
            26 => (u32::from_be_bytes([k[1], k[2], k[3], k[4]]) as u64, 5),
            27 => (u64::from_be_bytes([k[1], k[2], k[3], k[4], k[5], k[6], k[7], k[8]]), 9),
            _ => (ai as u64, 1),
        };
        match major {
            3 => String::from_utf8_lossy(&k[h..h + arg as usize]).into_owned(),
            0 => arg.to_string(),
            _ => format!("-{}", arg as u128 + 1),
        }
    }
}

/// The VM's scratch: one per validating thread or context, reused across
/// calls and Programs, grown by program.md §13.1's protocol.
#[derive(Debug, Default)]
pub struct Scratch {
    s: Vec<i32>,
    cap: i32,
}

impl Scratch {
    pub fn new() -> Scratch {
        Scratch::default()
    }
    fn lease(&mut self, prog: &Program, rule: i32) -> &mut [i32] {
        let cap = self.cap.max(prog.p[16]);
        let need = vm_scratch_words(&prog.p, rule, cap) as usize;
        if cap > self.cap || need > self.s.len() {
            self.s = vec![0; need.max(self.s.len())];
            self.cap = cap;
            vm_scratch_init(&mut self.s, cap);
        }
        &mut self.s
    }
}

/// Per-call options; a limit only lowers the compiled one (None = compiled).
#[derive(Debug, Clone, Default)]
pub struct Options {
    pub top_map: bool,
    pub cose: bool,
    pub max_bytes: Option<i32>,
    pub max_depth: Option<i32>,
    pub max_entries: Option<i32>,
    pub max_items: Option<i32>,
    pub max_bignum_bytes: Option<i32>,
    pub budget: Option<i32>,
}

impl Options {
    fn words(&self) -> [i32; 8] {
        let l = |v: Option<i32>| v.map(|x| x.max(0)).unwrap_or(-1);
        [if self.top_map { 0 } else { 1 }, self.cose as i32, l(self.max_bytes), l(self.max_depth),
         l(self.max_entries), l(self.max_items), l(self.max_bignum_bytes), l(self.budget)]
    }
}

/// One path segment (program.md §9.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Index(i32),
    Key(String),
    AnyKey,
    Tag,
    Embedded,
    EmbeddedItem(i32),
}

/// A refusal: reason code and name, embedded subcode, byte offset, path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: i32,
    pub reason: &'static str,
    pub subcode: Option<&'static str>,
    pub offset: i32,
    pub path: Vec<Segment>,
    pub budget_used: i32,
}

/// The name of a reason code: `cbor/<code>` for profile refusals.
pub fn reason_name(code: i32) -> &'static str {
    match code {
        1 => "cbor/truncated", 2 => "cbor/non_shortest", 3 => "cbor/indefinite", 4 => "cbor/malformed",
        5 => "cbor/key_type", 6 => "cbor/key_order", 7 => "cbor/duplicate_key", 8 => "cbor/text",
        9 => "cbor/float", 10 => "cbor/simple", 11 => "cbor/tag", 12 => "cbor/bignum", 13 => "cbor/decimal",
        14 => "cbor/typed_array", 15 => "cbor/ndarray", 16 => "cbor/trailing", 17 => "cbor/depth",
        18 => "cbor/too_many_entries", 19 => "cbor/too_many_items", 20 => "cbor/too_large", 21 => "cbor/not_map",
        32 => "type", 33 => "missing", 34 => "unexpected", 35 => "value", 36 => "size", 37 => "range",
        38 => "pattern", 39 => "tag", 40 => "bits", 41 => "embedded", 48 => "budget",
        _ => if code > 0 && code < 32 { code_name(code) } else { "unknown" },
    }
}

fn result(prog: &Program, out: &[i32]) -> Result<(), Failure> {
    if out[0] == 0 {
        return Ok(());
    }
    let mut path = Vec::new();
    for i in 0..out[6] as usize {
        let (k, v) = (out[8 + 2 * i], out[9 + 2 * i]);
        path.push(match k {
            0 => Segment::Index(v),
            1 => Segment::Key(prog.key_name(v)),
            2 => Segment::AnyKey,
            3 => Segment::Tag,
            4 => Segment::Embedded,
            _ => Segment::EmbeddedItem(v),
        });
    }
    Err(Failure {
        code: out[0],
        reason: reason_name(out[0]),
        subcode: if out[0] == 41 { Some(reason_name(out[1])) } else { None },
        offset: out[2],
        path,
        budget_used: out[3],
    })
}

/// Validate `bytes` against `rule` (an index from `Program::rule`).
pub fn validate(prog: &Program, rule: i32, bytes: &[u8], opts: &Options, scratch: &mut Scratch) -> Result<(), Failure> {
    let mut out = [0i32; 8 + 2 * 257];
    let lim = opts.words();
    let s = scratch.lease(prog, rule);
    let c = vm_validate(&prog.p, &prog.b, rule, bytes, &lim, s, &mut out);
    assert!(c >= 0, "snug: vm-validate answered {} for a verified Program", c);
    result(prog, &out)
}

/// `validateAt` (architecture §16.3): the item spanning `bytes[start..end]` as its
/// own document, depth and item accounting continuing from `depth`, `items`.
pub fn validate_at(prog: &Program, rule: i32, bytes: &[u8], start: i32, end: i32, depth: i32, items: i32,
                   opts: &Options, scratch: &mut Scratch) -> Result<(), Failure> {
    let mut out = [0i32; 8 + 2 * 257];
    let mut lim = opts.words();
    lim[0] = if opts.top_map { 0 } else { 1 };
    let s = scratch.lease(prog, rule);
    let c = vm_validate_span(&prog.p, &prog.b, rule, bytes, start, end, depth, items, &lim, s, &mut out);
    assert!(c >= 0, "snug: vm-validate-span answered {} for a verified Program", c);
    result(prog, &out)
}

// ---------------------------------------------------------------- sessions (P6.2)

use crate::snug::vm::session::{vms_arena, vms_init, vms_keep, vms_need_length, vms_need_offset, vms_position, vms_step, vms_words};

const VMS_NEED: i32 = -64;
const VMS_YIELD: i32 = -65;

/// What one [`Session::step`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Give a window holding `[offset, offset + len)`; no byte before `keep` is asked for again.
    Need { offset: i32, len: i32, keep: i32 },
    /// The work quantum is spent: give a window holding `position`.
    Yield { position: i32, keep: i32 },
    /// The verdict, as [`validate`]'s.
    Done(Result<(), Failure>),
}

/// A resumable validation (architecture §17, P6.2) of one message of a declared
/// length over windows of it. It owns its scratch, session array and key arena
/// (never shared between sessions); the Program is borrowed.
pub struct Session<'p> {
    prog: &'p Program,
    s: Vec<i32>,
    ss: Vec<i32>,
    ka: Vec<u8>,
    out: Vec<i32>,
    done: Option<Result<(), Failure>>,
}

impl<'p> Session<'p> {
    /// A session on `rule` over a message of exactly `total` bytes; `quantum` > 0
    /// yields after about that many work units per step.
    pub fn new(prog: &'p Program, rule: i32, total: i32, opts: &Options, quantum: i32) -> Session<'p> {
        let lim = opts.words();
        let cap = prog.p[16].max(1);
        let mut s = vec![0i32; vm_scratch_words(&prog.p, rule, cap) as usize];
        vm_scratch_init(&mut s, cap);
        let mut ss = vec![0i32; vms_words(&prog.p) as usize];
        let mut ka = vec![0u8; vms_arena(&prog.p, &lim, total).max(0) as usize];
        let c = vms_init(&prog.p, &prog.b, rule, &lim, &mut s, &mut ss, &mut ka, total, quantum);
        assert!(c >= 0, "snug: vms-init answered {} for a verified Program", c);
        Session { prog, s, ss, ka, out: vec![0i32; 8 + 2 * 257], done: None }
    }
    /// Run over `window`, the message's bytes from `base`.
    pub fn step(&mut self, window: &[u8], base: i32) -> Step {
        if let Some(d) = &self.done {
            return Step::Done(d.clone());
        }
        let r = vms_step(&self.prog.p, &self.prog.b, window, &mut self.s, &mut self.ss, &mut self.ka, &mut self.out, base);
        if r == VMS_NEED {
            return Step::Need { offset: vms_need_offset(&self.ss), len: vms_need_length(&self.ss), keep: vms_keep(&self.ss) };
        }
        if r == VMS_YIELD {
            return Step::Yield { position: vms_position(&self.ss), keep: vms_keep(&self.ss) };
        }
        assert!(r >= 0, "snug: vms-step answered {}", r);
        let d = result(self.prog, &self.out);
        self.done = Some(d.clone());
        Step::Done(d)
    }
}

/// A random-access source of a known size whose contents do not change while it
/// is read (an immutable snapshot: architecture §17.3, W12).
pub trait Blob {
    fn size(&self) -> usize;
    fn read(&self, offset: usize, len: usize) -> Result<Vec<u8>, SourceError>;
}

/// A source broke its contract: a transport outcome, never a CBOR verdict (W13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceError {
    ShortRead { offset: usize, wanted: usize, got: usize },
    Read,
    TooLarge,
}

/// An in-memory blob (a borrowed buffer), for tests and as the simplest source.
pub struct BytesBlob<'a>(pub &'a [u8]);

impl Blob for BytesBlob<'_> {
    fn size(&self) -> usize {
        self.0.len()
    }
    fn read(&self, offset: usize, len: usize) -> Result<Vec<u8>, SourceError> {
        self.0.get(offset..offset + len).map(|x| x.to_vec()).ok_or(SourceError::Read)
    }
}

/// Validate a blob against `rule` through a session, reading `chunk`-byte windows
/// only when the session asks for bytes it does not have.
pub fn validate_blob(prog: &Program, rule: i32, blob: &dyn Blob, opts: &Options, chunk: usize, quantum: i32)
                     -> Result<Result<(), Failure>, SourceError> {
    let size = blob.size();
    if size > 0x7fff_ffff {
        return Err(SourceError::TooLarge);
    }
    let mut session = Session::new(prog, rule, size as i32, opts, quantum);
    let (mut base, mut window): (usize, Vec<u8>) = (0, Vec::new());
    let (mut at, mut need) = (0usize, chunk.min(size));
    loop {
        let end = base + window.len();
        if !(at >= base && at + need.min(size - at) <= end && (at < end || at == size)) {
            let len = need.max(chunk).min(size - at);
            let got = blob.read(at, len)?;
            if got.len() != len {
                return Err(SourceError::ShortRead { offset: at, wanted: len, got: got.len() });
            }
            base = at;
            window = got;
        }
        match session.step(&window, base as i32) {
            Step::Done(d) => return Ok(d),
            Step::Need { offset, len, .. } => {
                at = offset as usize;
                need = len as usize;
            }
            Step::Yield { position, .. } => {
                at = position as usize;
                need = 1;
            }
        }
    }
}
