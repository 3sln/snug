//! Validation against a compiled schema: the Rust host of the generated VM
//! (`snug::vm`). Every accept/refuse decision is the core's; this module owns the
//! Program (copied on load and verified by `vm-verify`), a caller-owned
//! scratch (`&mut Scratch`: the JS single-isolate argument is not assumed
//! here), the limit words and the shape of the result. Paths are
//! rendered from the Program's key table only.
use crate::snug::cbor::scan::code_name;
use crate::snug::program::verify::{vm_verify, vm_verify_words};
use crate::snug::vm::api::{vm_rule_index, vm_scratch_init, vm_scratch_words, vm_validate_span_v, vm_validate_v};
use crate::snug::cbor::codes::{O_S_CBASE, VC_NONDET, VC_UNSORTED};
use crate::controls::{port, prepare_all, program_controls, Control, Controls};
use std::collections::BTreeMap;
use std::sync::Arc;

/// A verified Program (format 2.0) from a store the host trusts.
#[derive(Debug, Clone)]
pub struct Program {
    p: Vec<i32>,
    b: Vec<u8>,
    ext: Option<Bound>,
    /// The largest VM scratch a session on this Program grew to (its room past
    /// the arena holds a canonical item's events): later sessions start that large.
    session_words: Arc<std::sync::atomic::AtomicUsize>,
    /// Idle session arrays, shared by the Program's clones.
    pool: Arc<crate::sessions::Pool>,
}

/// A Program's extension controls bound to predicates, in id order, and
/// the metered ones' prepared arguments per (id, argument offset).
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
    /// Verify and keep a private copy (P and B must not change
    /// between verification and validation).
    pub fn new(p: &[i32], b: &[u8]) -> Result<Program, Refused> {
        let nl = if p.len() > 16 { p[16].clamp(0, 1 << 20) } else { 0 };
        // format 2.0: marks plus the PEG working area (vm-verify-words, clamped by the hard maxima)
        let mut s = vec![0i32; (48 + 2 * nl as usize + 64).max(vm_verify_words(p, nl).max(0) as usize + 16)];
        s[16] = 1;
        s[17] = nl;
        if vm_verify(p, b, &mut s) != 0 {
            return Err(Refused { at: s[35], check: s[36] });
        }
        Ok(Program { p: p.to_vec(), b: b.to_vec(), ext: None, session_words: Arc::default(), pool: crate::sessions::Pool::new() })
    }
    /// The extension controls this Program uses, by name.
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
    /// The Program's words and pool (the sequence reader drives sessions itself).
    pub fn words(&self) -> &[i32] {
        &self.p
    }
    pub fn pool(&self) -> &[u8] {
        &self.b
    }
    /// One `vms-step` of a session on this Program, through its bound extension controls.
    /// With the valid machinery's buffers, which are the thread's (step-local, so one pair
    /// serves every session; grown here on VMS_GROW and kept), `s` and `ka` grown keeping their contents.
    pub fn session_step(&self, w: &[u8], s: &mut Vec<i32>, ss: &mut [i32], ka: &mut Vec<u8>, out: &mut [i32], base: i32) -> i32 {
        let (mut vs, mut cb) = valid_take();
        let r = self.session_step_v(w, s, ss, ka, out, base, &mut vs, &mut cb);
        valid_put(vs, cb);
        r
    }
    #[allow(clippy::too_many_arguments)]
    fn session_step_v(&self, w: &[u8], s: &mut Vec<i32>, ss: &mut [i32], ka: &mut Vec<u8>, out: &mut [i32], base: i32,
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
            if gs as usize > s.len() {
                s.resize(gs as usize, 0);
                // at most 2^18 words remembered: one huge item does not pre-grow every later session
                if s.len() <= 1 << 18 {
                    self.session_words.fetch_max(s.len(), std::sync::atomic::Ordering::Relaxed);
                }
            }
            if ga as usize > ka.len() { ka.resize(ga as usize, 0); }
        }
    }
    /// A new session's arrays from the pool, zeroed, under the live bound: S
    /// at least `rule`'s scratch words and as large as earlier sessions needed
    /// (a session's arena starts at the lease), the key arena `kab` bytes.
    pub(crate) fn session_arrays(&self, rule: i32, kab: i32) -> Result<crate::sessions::Arrays, crate::sessions::SessionError> {
        let cap = self.p[16].max(1);
        let sw = (vm_scratch_words(&self.p, rule, cap).max(0) as usize)
            .max(self.session_words.load(std::sync::atomic::Ordering::Relaxed));
        let mut a = crate::sessions::acquire(&self.pool, sw, vms_words(&self.p).max(0) as usize, kab.max(0) as usize)?;
        vm_scratch_init(&mut a.s, cap);
        Ok(a)
    }
    /// A session's arrays back to the pool, its live slot freed.
    pub(crate) fn session_release(&self, a: crate::sessions::Arrays) {
        crate::sessions::release(&self.pool, a);
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

// D286: the session's valid-machinery buffers (the scanner's options and scratch, the canonical buffer) are
// step-local -- nothing in them outlives one vms-step-v call -- so one pair per thread serves every session and
// sequence step, grown on VMS_GROW and kept: a fresh session no longer regrows them from 512 words / 1 KiB,
// rerunning a whole item's scanner pass and copy on every growth. A re-entered step (an extension predicate
// stepping another session) finds the slot empty and takes fresh buffers.
thread_local! {
    static VALID_BUFS: std::cell::RefCell<(Vec<i32>, Vec<u8>)> = const { std::cell::RefCell::new((Vec::new(), Vec::new())) };
}
fn valid_take() -> (Vec<i32>, Vec<u8>) {
    let (mut vs, mut cb) = VALID_BUFS.with(|c| std::mem::take(&mut *c.borrow_mut()));
    if vs.len() < 512 { vs = vec![0; 512]; }
    if cb.len() < 1024 { cb = vec![0; 1024]; }
    (vs, cb)
}
fn valid_put(vs: Vec<i32>, cb: Vec<u8>) {
    VALID_BUFS.with(|c| {
        let mut g = c.borrow_mut();
        if vs.len() > g.0.len() { g.0 = vs; }
        if cb.len() > g.1.len() { g.1 = cb; }
    });
}

/// The VM's scratch: one per validating thread or context, reused across
/// calls and Programs, grown on demand. Not shared: each concurrent
/// validation brings its own (`&mut`).
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
/// `profile` is the core's profile flags (snug.cbor.codes PF_*): the
/// valid preset by default, 0 the Bindle profile.
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
    /// limits words 0..7, word 8 (generic/schedule bits, 0), word 9 the profile flags.
    fn words(&self) -> [i32; 10] {
        let l = |v: Option<i32>| v.map(|x| x.max(0)).unwrap_or(-1);
        [if self.top_map { 0 } else { 1 }, self.cose as i32, l(self.max_bytes), l(self.max_depth),
         l(self.max_entries), l(self.max_items), l(self.max_bignum_bytes), l(self.budget), 0, self.profile]
    }
}

/// One path segment. Not exhaustive: a later release
/// may add a segment kind, so a `match` needs a fallback arm.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Segment {
    Index(i32),
    Key(String),
    AnyKey,
    Tag,
    Embedded,
    EmbeddedItem(i32),
}

/// A refusal: reason code and name, subcode, byte offset, path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// The numeric reason: 1–21 a CBOR refusal (`reason` is `cbor/<code>`),
    /// 32 and up a schema refusal, −1 an unknown rule (an API failure, not a
    /// verdict). `reason` is the stable form; prefer it.
    pub code: i32,
    /// The stable reason name: `cbor/truncated`, `type`, `value`, …
    /// [`Error::code`](crate::Error::code) maps it to the JS code family
    /// (`truncated`, `schema/type`, …).
    pub reason: &'static str,
    /// For `embedded`, the embedded item's own reason; for `value`, `cut`
    /// when a cut decided it: a key matched a cut member (`name:` or `^=>`)
    /// whose value failed, and the cut stopped the alternatives after it.
    pub subcode: Option<&'static str>,
    /// The byte offset the refusal was decided at.
    pub offset: i32,
    /// Schema-named path segments, never data keys the schema does not name.
    pub path: Vec<Segment>,
    /// Work units used.
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
        44 => "group_limit", 46 => "cut", 48 => "budget",
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
        // an embedded failure's own reason; `cut` on a value a cut decided (D342)
        subcode: if out[0] == 41 || out[1] == 46 { Some(reason_name(out[1])) } else { None },
        offset: out[2],
        path,
        budget_used: out[3],
    })
}

/// What a successful validation found: the canonical copy the VM validated
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

/// `validateAt`: the item spanning `bytes[start..end]` as its
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
    /// An unknown-length session: this verdict waits for the end
    /// ([`Session::end`]); an `Err` is certainly a refusal (the final code may be
    /// `cbor/truncated` or `cbor/too_large` instead), an `Ok` may still become one.
    Held(Result<(), Failure>),
}

/// A resumable validation of one message of a declared
/// length over windows of it. It owns its scratch, session array and key arena
/// (never shared between sessions; taken from the Program's pool, zeroed, and
/// given back when it finishes or is dropped); the Program is borrowed.
pub struct Session<'p> {
    prog: &'p Program,
    s: Vec<i32>,
    ss: Vec<i32>,
    ka: Vec<u8>,
    out: Vec<i32>,
    done: Option<Result<(), Failure>>,
    limit: usize,
    live: bool,
}

impl<'p> Session<'p> {
    /// A session on `rule` over a message of exactly `total` bytes; `quantum` > 0
    /// yields after about that many work units per step. Fails with
    /// `SessionError::Limit` (`sessions/limit`) while the process has its maximum of
    /// live sessions (`crate::sessions`).
    pub fn new(prog: &'p Program, rule: i32, total: i32, opts: &Options, quantum: i32) -> Result<Session<'p>, crate::sessions::SessionError> {
        let lim = opts.words();
        let a = prog.session_arrays(rule, vms_arena(&prog.p, &lim, total))?;
        let mut session = Session { prog, s: a.s, ss: a.ss, ka: a.ka, out: vec![0i32; 8 + 2 * 257], done: None, limit: 0, live: true };
        let c = vms_init(&prog.p, &prog.b, rule, &lim, &mut session.s, &mut session.ss, &mut session.ka, total, quantum);
        assert!(c >= 0, "snug: vms-init answered {} for a verified Program", c);
        session.limit = session.ss[1].max(0) as usize;
        Ok(session)
    }
    /// A session over a message of UNKNOWN length (drain mode). Step it as a
    /// known-length one; [`Step::Held`] is a verdict waiting for the end; call
    /// [`Session::end`] with the byte count once the source is exhausted (or as soon
    /// as it passes the input limit). Verdicts equal a buffer's of the same bytes.
    pub fn new_unknown(prog: &'p Program, rule: i32, opts: &Options, quantum: i32) -> Result<Session<'p>, crate::sessions::SessionError> {
        let lim = opts.words();
        let total = vms_unknown_total(&prog.p, &lim);
        let a = prog.session_arrays(rule, vms_arena(&prog.p, &lim, total))?;
        let mut session = Session { prog, s: a.s, ss: a.ss, ka: a.ka, out: vec![0i32; 8 + 2 * 257], done: None, limit: 0, live: true };
        let c = vms_init_unknown(&prog.p, &prog.b, rule, &lim, &mut session.s, &mut session.ss, &mut session.ka, quantum);
        assert!(c >= 0, "snug: vms-init-unknown answered {} for a verified Program", c);
        session.limit = session.ss[1].max(0) as usize;
        Ok(session)
    }
    /// The input limit of an unknown-length session: more bytes than this is `too_large`.
    pub fn limit(&self) -> usize {
        self.limit
    }
    /// The arrays back to the Program's pool (once): at the verdict, or on drop.
    fn release(&mut self) {
        if self.live {
            self.live = false;
            let a = crate::sessions::Arrays { s: std::mem::take(&mut self.s), ss: std::mem::take(&mut self.ss), ka: std::mem::take(&mut self.ka) };
            self.prog.session_release(a);
        }
    }
    /// The message ended after `n` bytes (any `n` above [`Session::limit`]
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
        self.release();
        Step::Done(d)
    }
    /// Run over `window`, the message's bytes from `base`.
    pub fn step(&mut self, window: &[u8], base: i32) -> Step {
        if let Some(d) = &self.done {
            return Step::Done(d.clone());
        }
        let r = self.prog.session_step(window, &mut self.s, &mut self.ss, &mut self.ka, &mut self.out, base);
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
        self.release();
        Step::Done(d)
    }
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

/// A random-access source of a known size whose contents do not change while it
/// is read (an immutable snapshot: pin the object's version).
pub trait Blob {
    /// The size in bytes.
    fn size(&self) -> usize;
    /// Exactly the `len` bytes at `offset` (fewer is `short_read`). A backend
    /// failure is best returned as [`SourceError::Io`], which the drivers keep.
    fn read(&self, offset: usize, len: usize) -> Result<Vec<u8>, SourceError>;
}

/// A source broke its contract: a transport outcome, never a CBOR verdict.
/// Not exhaustive: a later release may add a variant.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SourceError {
    /// A blob read answered fewer bytes than asked for (`short_read`).
    ShortRead {
        /// Where the read started.
        offset: usize,
        /// The bytes asked for.
        wanted: usize,
        /// The bytes answered.
        got: usize,
    },
    /// The source failed with no error to keep (`read`); prefer
    /// [`SourceError::Io`] when there is one.
    Read,
    /// The blob is larger than the session can address (`too_large`).
    TooLarge,
    /// The process has its maximum of live sessions ([`crate::sessions`]).
    SessionLimit,
    /// The transport's own error, kept whole for
    /// [`std::error::Error::source`] (`read`). A blob backend returns it with
    /// `SourceError::Io(err.into())`.
    Io(IoError),
}

/// A transport's own error, kept whole: what an `AsyncSource`, a [`std::io::Read`]
/// or a blob's backend failed with. It is reachable through `Error::Io` and
/// [`std::error::Error::source`], so a server can tell a reset from a timeout;
/// snug's own Display never prints it (transport messages are the transport's to
/// sanitise). Cheap to clone (shared); two compare equal when their
/// [`std::io::ErrorKind`]s do.
#[derive(Debug, Clone)]
pub struct IoError(Arc<std::io::Error>);
impl IoError {
    /// The error's kind.
    pub fn kind(&self) -> std::io::ErrorKind {
        self.0.kind()
    }
    /// The original error.
    pub fn get_ref(&self) -> &std::io::Error {
        &self.0
    }
}
impl From<std::io::Error> for IoError {
    fn from(e: std::io::Error) -> Self {
        Self(Arc::new(e))
    }
}
impl PartialEq for IoError {
    fn eq(&self, other: &Self) -> bool {
        self.kind() == other.kind()
    }
}
impl Eq for IoError {}
impl std::fmt::Display for IoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "snug: source read failed ({:?})", self.kind())
    }
}
impl std::error::Error for IoError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.0)
    }
}
impl From<std::io::Error> for SourceError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.into())
    }
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

// ---------------------------------------------------------------- the drivers' sans-IO cores (P9.6b, D335)
//
// One step machine per source kind; the sync drivers below and the async ones
// (`crate::async_source`) are thin I/O loops over them: ask `next()` what to do, do
// that one read (or yield), hand the bytes back, repeat. The cores decide every
// window, keep, drop, end and verdict, so the two drivers cannot diverge.

/// What a driver core asks of its I/O loop.
#[derive(Debug)]
pub(crate) enum Io {
    /// Blob: read exactly `len` bytes at `offset` and give them to `BlobCore::fill`.
    /// Stream: read up to `StreamCore::buf().len()` bytes into it and call `filled`.
    Read { offset: usize, len: usize },
    /// The quantum is spent (only with a positive quantum): an async loop yields to
    /// its executor, a sync one goes on.
    Yield,
    /// The verdict.
    Done(Result<(), Failure>),
}

/// A known-length blob's core: reads `max(need, chunk)` bytes at the asked offset,
/// only when the window lacks what the session asks for.
pub(crate) struct BlobCore<'p> {
    session: Session<'p>,
    size: usize,
    chunk: usize,
    quantum: i32,
    base: usize,
    window: Vec<u8>,
    at: usize,
    need: usize,
    reading: Option<(usize, usize)>,
}

impl<'p> BlobCore<'p> {
    pub(crate) fn new(prog: &'p Program, rule: i32, size: usize, opts: &Options, chunk: usize, quantum: i32)
                      -> Result<BlobCore<'p>, SourceError> {
        if size > 0x7fff_ffff {
            return Err(SourceError::TooLarge);
        }
        let session = Session::new(prog, rule, size as i32, opts, quantum).map_err(|_| SourceError::SessionLimit)?;
        Ok(BlobCore { session, size, chunk, quantum, base: 0, window: Vec::new(), at: 0, need: chunk.min(size), reading: None })
    }
    pub(crate) fn next(&mut self) -> Io {
        loop {
            if let Some((offset, len)) = self.reading {
                return Io::Read { offset, len };
            }
            let (size, at, end) = (self.size, self.at, self.base + self.window.len());
            if !(at >= self.base && at + self.need.min(size - at) <= end && (at < end || at == size)) {
                let len = self.need.max(self.chunk).min(size - at);
                self.reading = Some((at, len));
                continue;
            }
            match self.session.step(&self.window, self.base as i32) {
                Step::Done(d) | Step::Held(d) => return Io::Done(d),
                Step::Need { offset, len, .. } => {
                    self.at = offset as usize;
                    self.need = len as usize;
                }
                Step::Yield { position, .. } => {
                    self.at = position as usize;
                    self.need = 1;
                    if self.quantum > 0 {
                        return Io::Yield;
                    }
                }
            }
        }
    }
    /// The bytes of the read `next` asked for (exactly its length, else `ShortRead`).
    pub(crate) fn fill(&mut self, got: Vec<u8>) -> Result<(), SourceError> {
        let (offset, len) = self.reading.take().expect("snug: BlobCore::fill without a read");
        if got.len() != len {
            return Err(SourceError::ShortRead { offset, wanted: len, got: got.len() });
        }
        self.base = offset;
        self.window = got;
        Ok(())
    }
}

/// An unknown-length stream's core (drain mode, or fail-fast): holds the
/// bytes from the session's `keep` on plus one read buffer of `chunk` bytes.
pub(crate) struct StreamCore<'p> {
    session: Session<'p>,
    quantum: i32,
    fail_fast: bool,
    limit: usize,
    tmp: Vec<u8>,
    buf: Vec<u8>,
    base: usize,
    delivered: usize,
    eof: bool,
    step: Option<Step>,
    // what the session wants: [at, at + len), awaiting bytes
    want: Option<(usize, usize)>,
    draining: bool,
    // the session was given the end and resumed: it goes on over what is held, never
    // asking past the end (a yield at the end needs no byte); vms-eof is called once
    ended: bool,
}

impl<'p> StreamCore<'p> {
    pub(crate) fn new(prog: &'p Program, rule: i32, opts: &Options, chunk: usize, quantum: i32, fail_fast: bool)
                      -> Result<StreamCore<'p>, SourceError> {
        let mut session = Session::new_unknown(prog, rule, opts, quantum).map_err(|_| SourceError::SessionLimit)?;
        let limit = session.limit();
        let step = session.step(&[], 0);
        Ok(StreamCore { session, quantum, fail_fast, limit, tmp: vec![0u8; chunk.max(1)], buf: Vec::new(), base: 0,
                        delivered: 0, eof: false, step: Some(step), want: None, draining: false, ended: false })
    }
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
    fn step_held(&mut self) -> Step {
        self.session.step(&self.buf, self.base as i32)
    }
    pub(crate) fn next(&mut self) -> Io {
        loop {
            let read = Io::Read { offset: self.delivered, len: self.tmp.len() };
            if self.draining {
                // drain: the verdict waits for the end (or the input limit)
                if !self.eof && self.delivered <= self.limit {
                    let d = self.delivered;
                    self.drop_to(d);
                    return read;
                }
                self.draining = false;
                self.step = Some(self.session.end(self.delivered));
                self.ended = true;
                continue;
            }
            if let Some((at, len)) = self.want {
                let have = self.base + self.buf.len();
                if !self.eof && self.delivered <= self.limit && have < at + len {
                    return read;
                }
                self.want = None;
                let step = if self.ended {
                    assert!(have >= at + len, "snug: the session asked past the end");
                    self.step_held()
                } else if self.delivered > self.limit || have < at + len {
                    // past the input limit (too_large), or the message ended before what is asked
                    self.ended = true;
                    match self.session.end(self.delivered) {
                        Step::Yield { .. } => self.step_held(),
                        s => s,
                    }
                } else {
                    self.step_held()
                };
                self.step = Some(step);
                continue;
            }
            match self.step.take().expect("snug: StreamCore has no step") {
                Step::Done(d) => {
                    self.step = Some(Step::Done(d.clone()));
                    return Io::Done(d);
                }
                Step::Held(d) => {
                    if self.fail_fast && d.is_err() {
                        self.step = Some(Step::Done(d.clone()));
                        return Io::Done(d);
                    }
                    self.draining = true;
                }
                Step::Need { offset, len, keep } => {
                    self.drop_to(keep as usize);
                    self.want = Some((offset as usize, len as usize));
                }
                Step::Yield { position, keep } => {
                    self.drop_to(keep as usize);
                    self.want = Some((position as usize, if self.ended { 0 } else { 1 }));
                    if self.quantum > 0 {
                        return Io::Yield;
                    }
                }
            }
        }
    }
    /// The read buffer an `Io::Read` fills (`chunk` bytes).
    pub(crate) fn buf(&mut self) -> &mut [u8] {
        &mut self.tmp
    }
    /// `got` bytes of `buf()` arrived; 0 is the end of the source.
    pub(crate) fn filled(&mut self, got: usize) {
        if got == 0 {
            self.eof = true;
            return;
        }
        let start = self.delivered;
        self.delivered += got;
        if self.delivered > self.base {
            let from = self.base.saturating_sub(start);
            self.buf.extend_from_slice(&self.tmp[from..got]);
        }
    }
}

/// Validate a blob against `rule` through a session, reading `chunk`-byte windows
/// only when the session asks for bytes it does not have (an I/O loop over `BlobCore`).
pub fn validate_blob(prog: &Program, rule: i32, blob: &dyn Blob, opts: &Options, chunk: usize, quantum: i32)
                     -> Result<Result<(), Failure>, SourceError> {
    let mut core = BlobCore::new(prog, rule, blob.size(), opts, chunk, quantum)?;
    loop {
        match core.next() {
            Io::Read { offset, len } => core.fill(blob.read(offset, len)?)?,
            Io::Yield => {}
            Io::Done(d) => return Ok(d),
        }
    }
}

/// Validate a message of unknown length read from `reader` until EOF,
/// holding at most what the session asks for (plus `chunk`). Drain mode: the
/// verdict equals the buffer's of the same bytes; with `fail_fast` a certain
/// refusal is answered at once (its code may then differ: the buffer might say
/// `cbor/truncated` or `cbor/too_large`). Transport errors are `SourceError::Io`
/// (the reader's own error). An I/O loop over `StreamCore`.
pub fn validate_reader(prog: &Program, rule: i32, reader: &mut dyn std::io::Read, opts: &Options, chunk: usize,
                       quantum: i32, fail_fast: bool) -> Result<Result<(), Failure>, SourceError> {
    let mut core = StreamCore::new(prog, rule, opts, chunk, quantum, fail_fast)?;
    loop {
        match core.next() {
            Io::Read { .. } => {
                let got = loop {
                    match reader.read(core.buf()) {
                        Ok(n) => break n,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => return Err(e.into()),
                    }
                };
                core.filled(got);
            }
            Io::Yield => {}
            Io::Done(d) => return Ok(d),
        }
    }
}
