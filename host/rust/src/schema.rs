//! Validation against a compiled schema (P3.4): the Rust host of the kin VM
//! (`snug::vm`). Every accept/refuse decision is kin's; this module owns the
//! Program (copied on load and verified by `vm-verify`), a caller-owned
//! scratch (`&mut Scratch`: the JS single-isolate argument is not assumed here,
//! architecture §8), the limit words and the shape of the result. Paths are
//! rendered from the Program's key table only (program.md §9.3).
use crate::snug::cbor::scan::code_name;
use crate::snug::program::verify::vm_verify;
use crate::snug::vm::api::{vm_rule_index, vm_scratch_init, vm_scratch_words, vm_validate_span_v, vm_validate_v};
use crate::snug::cbor::codes::{O_S_CBASE, VC_NONDET, VC_UNSORTED};
use crate::controls::{port, prepare_all, program_controls, Control, Controls};
use std::collections::BTreeMap;
use std::sync::Arc;

/// A verified Program (docs/program.md format 1) from a store the host trusts.
#[derive(Debug, Clone)]
pub struct Program {
    p: Vec<i32>,
    b: Vec<u8>,
    ext: Option<Bound>,
}

/// A Program's extension controls bound to predicates, in id order (D141), and
/// the metered ones' prepared arguments per (id, argument offset) (D192).
#[derive(Clone)]
struct Bound(Vec<Arc<dyn Control>>, Arc<BTreeMap<(i32, i32), Vec<i32>>>);
impl std::fmt::Debug for Bound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Bound({})", self.0.len())
    }
}
impl Bound {
    fn call(&self, id: i32, pool: &[u8], ao: i32, al: i32, b: &[u8], s: i32, e: i32, room: i32) -> i32 {
        port(&*self.0[id as usize], self.1.get(&(id, ao)).map(Vec::as_slice), pool, ao, al, b, s, e, room)
    }
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
        Ok(Program { p: p.to_vec(), b: b.to_vec(), ext: None })
    }
    /// The extension controls this Program uses (format 1.1, D141), by name.
    pub fn controls(&self) -> Vec<String> {
        program_controls(&self.p, &self.b)
    }
    /// Bind the Program's extension controls to `controls`; the names it lacks
    /// on failure. Until bound, an extension control never matches.
    pub fn bind(&mut self, controls: &Controls) -> Result<(), Vec<String>> {
        let names = self.controls();
        if names.is_empty() {
            return Ok(());
        }
        let missing: Vec<String> = names.iter().filter(|n| controls.get(n).is_none()).cloned().collect();
        if !missing.is_empty() {
            return Err(missing);
        }
        let bound: Vec<Arc<dyn Control>> = names.iter().filter_map(|n| controls.get(n).cloned()).collect();
        let preps = prepare_all(&self.p, &self.b, &bound);
        self.ext = Some(Bound(bound, Arc::new(preps)));
        Ok(())
    }
    /// The Program's words and pool (the sequence reader drives sessions itself, D212).
    pub fn words(&self) -> &[i32] {
        &self.p
    }
    pub fn pool(&self) -> &[u8] {
        &self.b
    }
    /// One `vms-step` of a session on this Program, through its bound extension controls.
    #[allow(clippy::too_many_arguments)]
    /// P8.4 (D266): with the valid machinery's buffers `vs` and `cb`, grown here on VMS_GROW (as `s` and `ka`,
    /// keeping their contents).
    pub fn session_step(&self, w: &[u8], s: &mut Vec<i32>, ss: &mut [i32], ka: &mut Vec<u8>, out: &mut [i32], base: i32,
                        vs: &mut Vec<i32>, cb: &mut Vec<u8>) -> i32 {
        let none = |_: i32, _: &[u8], _: i32, _: i32, _: &[u8], _: i32, _: i32, _: i32| -> i32 { -2 };
        loop {
            let r = match &self.ext {
                Some(x) => {
                    let f = |id: i32, pool: &[u8], ao: i32, al: i32, b: &[u8], st: i32, e: i32, room: i32| x.call(id, pool, ao, al, b, st, e, room);
                    vms_step_v(&self.p, &self.b, w, s, ss, ka, out, base, &f, vs, cb)
                }
                None => vms_step_v(&self.p, &self.b, w, s, ss, ka, out, base, &none, vs, cb),
            };
            if r != VMS_GROW {
                return r;
            }
            let (gw, gb, gs, ga) = (vms_grow_words(ss), vms_grow_bytes(ss), vms_grow_scratch(ss), vms_grow_arena(ss));
            if gw as usize > vs.len() { *vs = vec![0; (gw as usize).max(2 * vs.len())]; }
            if gb as usize > cb.len() { *cb = vec![0; (gb as usize).max(2 * cb.len())]; }
            if gs as usize > s.len() { s.resize(gs as usize, 0); }
            if ga as usize > ka.len() { ka.resize(ga as usize, 0); }
        }
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
    // P8.4 (D264): the canonical path's buffers (the scanner's options, scratch and
    // embedded table; the canonical copy), grown when the VM answers -5.
    vs: Vec<i32>,
    cb: Vec<u8>,
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
/// `profile` is the kin profile flags (snug.cbor.codes PF_*, D120): the
/// valid preset by default (D267), 0 the Bindle profile.
#[derive(Debug, Clone)]
pub struct Options {
    pub top_map: bool,
    pub cose: bool,
    pub profile: i32,
    pub max_bytes: Option<i32>,
    pub max_depth: Option<i32>,
    pub max_entries: Option<i32>,
    pub max_items: Option<i32>,
    pub max_bignum_bytes: Option<i32>,
    pub budget: Option<i32>,
}

impl Default for Options {
    fn default() -> Self {
        Options { top_map: false, cose: false, profile: crate::snug::cbor::codes::PF_VALID_PRESET, max_bytes: None,
                  max_depth: None, max_entries: None, max_items: None, max_bignum_bytes: None, budget: None }
    }
}

impl Options {
    /// limits words 0..7 (program.md §12.3), word 8 (generic/schedule bits, 0), word 9 the profile flags.
    fn words(&self) -> [i32; 10] {
        let l = |v: Option<i32>| v.map(|x| x.max(0)).unwrap_or(-1);
        [if self.top_map { 0 } else { 1 }, self.cose as i32, l(self.max_bytes), l(self.max_depth),
         l(self.max_entries), l(self.max_items), l(self.max_bignum_bytes), l(self.budget), 0, self.profile]
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
        38 => "pattern", 39 => "tag", 40 => "bits", 41 => "embedded", 42 => "control", 43 => "control_size",
        48 => "budget",
        _ => if code > 0 && code < 32 { code_name(code) } else { "unknown" },
    }
}

pub(crate) fn result(prog: &Program, out: &[i32]) -> Result<(), Failure> {
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

/// What a successful validation found (P8.4): the canonical copy the VM validated
/// when valid input is not its own deterministic form, and whether some map's keys
/// may be out of canonical order.
#[derive(Debug, Default)]
pub struct Checked {
    pub copy: Option<Vec<u8>>,
    pub unsorted: bool,
}

fn run(prog: &Program, rule: i32, bytes: &[u8], span: Option<(i32, i32, i32, i32)>, lim: &[i32; 10],
       scratch: &mut Scratch) -> Result<Checked, Failure> {
    let mut out = [0i32; 8 + 2 * 257];
    scratch.lease(prog, rule);
    if scratch.vs.len() < 512 { scratch.vs = vec![0; 512]; }
    if scratch.cb.len() < 1024 { scratch.cb = vec![0; 1024]; }
    let none = |_: i32, _: &[u8], _: i32, _: i32, _: &[u8], _: i32, _: i32, _: i32| -> i32 { -2 };
    let c = loop {
        let Scratch { s, vs, cb, .. } = &mut *scratch;
        let c = match &prog.ext {
            Some(x) => {
                let f = |id: i32, pool: &[u8], ao: i32, al: i32, b: &[u8], st: i32, e: i32, room: i32| x.call(id, pool, ao, al, b, st, e, room);
                match span {
                    Some((a, z, d, i)) => vm_validate_span_v(&prog.p, &prog.b, rule, bytes, a, z, d, i, lim, s, &mut out, &f, vs, cb),
                    None => vm_validate_v(&prog.p, &prog.b, rule, bytes, lim, s, &mut out, &f, vs, cb),
                }
            }
            None => match span {
                Some((a, z, d, i)) => vm_validate_span_v(&prog.p, &prog.b, rule, bytes, a, z, d, i, lim, s, &mut out, &none, vs, cb),
                None => vm_validate_v(&prog.p, &prog.b, rule, bytes, lim, s, &mut out, &none, vs, cb),
            },
        };
        if c != -5 { break c; }
        if out[5] as usize > vs.len() { *vs = vec![0; (out[5] as usize).max(2 * vs.len())]; }
        if out[6] as usize > cb.len() { *cb = vec![0; (out[6] as usize).max(2 * cb.len())]; }
        if out[7] as usize > s.len() { s.resize(out[7] as usize, 0); }
    };
    assert!(c >= 0, "snug: vm-validate answered {} for a verified Program", c);
    result(prog, &out)?;
    let (vs, cb) = (&scratch.vs, &scratch.cb);
    if vs[15] < 0 {
        return Ok(Checked::default());
    }
    Ok(Checked {
        copy: if vs[12] & VC_NONDET != 0 { Some(cb[vs[O_S_CBASE as usize] as usize..vs[15] as usize].to_vec()) } else { None },
        unsorted: vs[12] & VC_UNSORTED != 0,
    })
}

/// Validate `bytes` against `rule` (an index from `Program::rule`).
pub fn validate(prog: &Program, rule: i32, bytes: &[u8], opts: &Options, scratch: &mut Scratch) -> Result<(), Failure> {
    run(prog, rule, bytes, None, &opts.words(), scratch).map(|_| ())
}

/// validate, answering the canonical copy and key-order outcome (decode and views).
pub fn validate_checked(prog: &Program, rule: i32, bytes: &[u8], opts: &Options, scratch: &mut Scratch)
                        -> Result<Checked, Failure> {
    run(prog, rule, bytes, None, &opts.words(), scratch)
}

/// `validateAt` (architecture §16.3): the item spanning `bytes[start..end]` as its
/// own document, depth and item accounting continuing from `depth`, `items`.
pub fn validate_at(prog: &Program, rule: i32, bytes: &[u8], start: i32, end: i32, depth: i32, items: i32,
                   opts: &Options, scratch: &mut Scratch) -> Result<(), Failure> {
    let mut lim = opts.words();
    lim[0] = if opts.top_map { 0 } else { 1 };
    run(prog, rule, bytes, Some((start, end, depth, items)), &lim, scratch).map(|_| ())
}

// ---------------------------------------------------------------- sessions (P6.2)

use crate::snug::vm::session::{vms_arena, vms_eof, vms_grow_arena, vms_grow_bytes, vms_grow_scratch, vms_grow_words,
                               vms_init, vms_init_unknown, vms_keep, vms_need_length, vms_need_offset, vms_position,
                               vms_step_v, vms_unknown_total, vms_words};

const VMS_NEED: i32 = -64;
const VMS_YIELD: i32 = -65;
const VMS_HELD: i32 = -67;
const VMS_RESUME: i32 = -68;
const VMS_GROW: i32 = -69;

/// What one [`Session::step`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Give a window holding `[offset, offset + len)`; no byte before `keep` is asked for again.
    Need { offset: i32, len: i32, keep: i32 },
    /// The work quantum is spent: give a window holding `position`.
    Yield { position: i32, keep: i32 },
    /// The verdict, as [`validate`]'s.
    Done(Result<(), Failure>),
    /// D085, an unknown-length session: this verdict waits for the end
    /// ([`Session::end`]); an `Err` is certainly a refusal (the final code may be
    /// `cbor/truncated` or `cbor/too_large` instead), an `Ok` may still become one.
    Held(Result<(), Failure>),
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
    vs: Vec<i32>,
    cb: Vec<u8>,
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
        Session { prog, s, ss, ka, out: vec![0i32; 8 + 2 * 257], vs: vec![0i32; 512], cb: vec![0u8; 1024], done: None }
    }
    /// D085: a session over a message of UNKNOWN length (drain mode). Step it as a
    /// known-length one; [`Step::Held`] is a verdict waiting for the end; call
    /// [`Session::end`] with the byte count once the source is exhausted (or as soon
    /// as it passes the input limit). Verdicts equal a buffer's of the same bytes.
    pub fn new_unknown(prog: &'p Program, rule: i32, opts: &Options, quantum: i32) -> Session<'p> {
        let lim = opts.words();
        let cap = prog.p[16].max(1);
        let mut s = vec![0i32; vm_scratch_words(&prog.p, rule, cap) as usize];
        vm_scratch_init(&mut s, cap);
        let mut ss = vec![0i32; vms_words(&prog.p) as usize];
        let total = vms_unknown_total(&prog.p, &lim);
        let mut ka = vec![0u8; vms_arena(&prog.p, &lim, total).max(0) as usize];
        let c = vms_init_unknown(&prog.p, &prog.b, rule, &lim, &mut s, &mut ss, &mut ka, quantum);
        assert!(c >= 0, "snug: vms-init-unknown answered {} for a verified Program", c);
        Session { prog, s, ss, ka, out: vec![0i32; 8 + 2 * 257], vs: vec![0i32; 512], cb: vec![0u8; 1024], done: None }
    }
    /// The input limit of an unknown-length session: more bytes than this is `too_large`.
    pub fn limit(&self) -> usize {
        self.ss[1].max(0) as usize
    }
    /// D085: the message ended after `n` bytes (any `n` above [`Session::limit`]
    /// once it passed it). Answers the verdict, or a [`Step::Yield`] when the walk
    /// must go on over the bytes from `position` to `n` (step again).
    pub fn end(&mut self, n: usize) -> Step {
        if let Some(d) = &self.done {
            return Step::Done(d.clone());
        }
        let r = vms_eof(&mut self.ss, &mut self.out, n.min(i32::MAX as usize) as i32);
        if r == VMS_RESUME {
            return Step::Yield { position: vms_position(&self.ss), keep: vms_keep(&self.ss) };
        }
        assert!(r >= 0, "snug: vms-eof answered {}", r);
        let d = result(self.prog, &self.out);
        self.done = Some(d.clone());
        Step::Done(d)
    }
    /// Run over `window`, the message's bytes from `base`.
    pub fn step(&mut self, window: &[u8], base: i32) -> Step {
        if let Some(d) = &self.done {
            return Step::Done(d.clone());
        }
        let none = |_: i32, _: &[u8], _: i32, _: i32, _: &[u8], _: i32, _: i32, _: i32| -> i32 { -2 };
        let r = loop {
            let r = match &self.prog.ext {
                Some(x) => {
                    let f = |id: i32, pool: &[u8], ao: i32, al: i32, b: &[u8], st: i32, e: i32, room: i32| x.call(id, pool, ao, al, b, st, e, room);
                    vms_step_v(&self.prog.p, &self.prog.b, window, &mut self.s, &mut self.ss, &mut self.ka, &mut self.out, base, &f,
                               &mut self.vs, &mut self.cb)
                }
                None => vms_step_v(&self.prog.p, &self.prog.b, window, &mut self.s, &mut self.ss, &mut self.ka, &mut self.out, base,
                                   &none, &mut self.vs, &mut self.cb),
            };
            if r != VMS_GROW {
                break r;
            }
            // P8.4 (D266): a whole item's canonical path or a map's kept keys need more room
            let (w, nb, sw, aw) = (vms_grow_words(&self.ss), vms_grow_bytes(&self.ss), vms_grow_scratch(&self.ss), vms_grow_arena(&self.ss));
            if w as usize > self.vs.len() { self.vs = vec![0; (w as usize).max(2 * self.vs.len())]; }
            if nb as usize > self.cb.len() { self.cb = vec![0; (nb as usize).max(2 * self.cb.len())]; }
            if sw as usize > self.s.len() { self.s.resize(sw as usize, 0); }
            if aw as usize > self.ka.len() { self.ka.resize(aw as usize, 0); }
        };
        if r == VMS_NEED {
            return Step::Need { offset: vms_need_offset(&self.ss), len: vms_need_length(&self.ss), keep: vms_keep(&self.ss) };
        }
        if r == VMS_YIELD {
            return Step::Yield { position: vms_position(&self.ss), keep: vms_keep(&self.ss) };
        }
        if r == VMS_HELD {
            return Step::Held(result(self.prog, &self.out));
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
            Step::Held(d) => return Ok(d),
        }
    }
}

/// D085: validate a message of unknown length read from `reader` until EOF,
/// holding at most what the session asks for (plus `chunk`). Drain mode: the
/// verdict equals the buffer's of the same bytes; with `fail_fast` a certain
/// refusal is answered at once (its code may then differ: the buffer might say
/// `cbor/truncated` or `cbor/too_large`). Transport errors are `SourceError::Read`.
pub fn validate_reader(prog: &Program, rule: i32, reader: &mut dyn std::io::Read, opts: &Options, chunk: usize,
                       quantum: i32, fail_fast: bool) -> Result<Result<(), Failure>, SourceError> {
    let mut session = Session::new_unknown(prog, rule, opts, quantum);
    let limit = session.limit();
    let mut src = Stream { reader, tmp: vec![0u8; chunk.max(1)], buf: Vec::new(), base: 0, delivered: 0, eof: false };
    let mut step = session.step(&src.buf, 0);
    loop {
        // what the session wants: [at, at + len)
        let (at, len) = match step {
            Step::Done(d) => return Ok(d),
            Step::Held(d) => {
                if fail_fast && d.is_err() {
                    return Ok(d);
                }
                // drain: the verdict waits for the end (or the input limit)
                while !src.eof && src.delivered <= limit {
                    let d = src.delivered;
                    src.drop_to(d);
                    src.read()?;
                }
                step = session.end(src.delivered);
                continue;
            }
            Step::Need { offset, len, keep } => {
                src.drop_to(keep as usize);
                (offset as usize, len as usize)
            }
            Step::Yield { position, keep } => {
                src.drop_to(keep as usize);
                (position as usize, 1)
            }
        };
        while !src.eof && src.delivered <= limit && src.base + src.buf.len() < at + len {
            src.read()?;
        }
        if src.delivered > limit || src.base + src.buf.len() < at + len {
            // past the input limit (too_large), or the message ended before what is asked
            step = session.end(src.delivered);
            if let Step::Yield { .. } = step {
                step = session.step(&src.buf, src.base as i32);
            }
        } else {
            step = session.step(&src.buf, src.base as i32);
        }
    }
}

/// A forward-only byte source for [`validate_reader`]: the bytes from `base` on.
struct Stream<'r> {
    reader: &'r mut dyn std::io::Read,
    tmp: Vec<u8>,
    buf: Vec<u8>,
    base: usize,
    delivered: usize,
    eof: bool,
}
impl Stream<'_> {
    /// Drop what precedes `keep` (it may lie ahead of what arrived: a skipped byte string).
    fn drop_to(&mut self, keep: usize) {
        let keep = keep.max(self.base);
        let k = (keep - self.base).min(self.buf.len());
        self.buf.drain(..k);
        self.base += k;
        if keep > self.base {
            self.base = keep;
        }
    }
    fn read(&mut self) -> Result<(), SourceError> {
        let got = loop {
            match self.reader.read(&mut self.tmp) {
                Ok(n) => break n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(SourceError::Read),
            }
        };
        if got == 0 {
            self.eof = true;
            return Ok(());
        }
        let start = self.delivered;
        self.delivered += got;
        if self.delivered > self.base {
            let from = self.base.saturating_sub(start);
            self.buf.extend_from_slice(&self.tmp[from..got]);
        }
        Ok(())
    }
}
