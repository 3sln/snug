//! P7.9 (D005 re-take): the runtime exports a JS SDK needs to put the whole
//! public API over wasm (host/wasm-sdk). Still a plain integer ABI: no
//! wasm-bindgen, no imports. Unlike the P1.4/P3.4 exports in lib.rs (static
//! buffers sized for the default bounds), memory here is std's allocator, so
//! the module starts small and grows on demand (linear memory never shrinks;
//! the SDK measures that and can drop the instance).
//!
//! Conventions: pointers and lengths are i32 offsets into linear memory. A
//! second or third answer goes into the INFO words (`sdk_info()`); VM out
//! words (program.md §13.2) into `sdk_out()`; nav head words (snug.nav.walk
//! o[8]) into `sdk_nav_words()`. Nothing here decides accept or refuse: every
//! verdict, head, order and float width is a generated kin function (D003).
use crate::snug::cbor::rscan::{rscan_init, rscan_need_length, rscan_need_offset, rscan_position, rscan_scratch_len, rscan_step};
use crate::snug::cbor::scan::{code_name, error_offset, scan, scan_options};
use crate::snug::nav::walk::{nav_child, nav_dir, nav_dir_find, nav_find, nav_head, nav_init, nav_skip, N_LO, N_MAJOR, N_STEPS};
use crate::snug::program::verify::vm_verify;
use crate::snug::vm::api::{vm_rule_index, vm_scratch_init, vm_scratch_words, vm_validate, vm_validate_span};
use crate::snug::vm::session::{vms_arena, vms_init, vms_keep, vms_need_length, vms_need_offset, vms_position, vms_step, vms_words};
use crate::snug::write::float::put_float;
use crate::snug::write::int::put_int;
use crate::snug::write::map::{sort_keys, S_BUDGET};
use crate::snug::write::out::{put_head, WR_NEED};
use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::cell::UnsafeCell;

const OUTW: usize = 8 + 2 * 257;

struct Prog {
    p: Vec<i32>,
    b: Vec<u8>,
}

enum Sess {
    Scan { o: [i32; 16], s: Vec<i32>, w: Vec<u8> },
    Vm { prog: usize, s: Vec<i32>, ss: Vec<i32>, ka: Vec<u8>, out: Vec<i32>, w: Vec<u8> },
}

struct State {
    input: Vec<u8>,
    kbuf: Vec<u8>,
    steps: Vec<i32>,
    out: [i32; OUTW],
    info: [i32; 8],
    nav: [i32; 8],
    scratch: Vec<i32>,
    mark_cap: i32,
    progs: Vec<Option<Prog>>,
    sessions: Vec<Option<Sess>>,
    // encode: the tape, its byte area, the output and the key scratch
    tape: Vec<i32>,
    bytes: Vec<u8>,
    eout: Vec<u8>,
    epos: usize,
    keys: Vec<u8>,
    pairs: Vec<i32>,
    x: Vec<i32>,
    ws: [i32; 4],
}

struct Cell(UnsafeCell<Option<State>>);
// wasm32-unknown-unknown is single-threaded and the host never re-enters.
unsafe impl Sync for Cell {}
static STATE: Cell = Cell(UnsafeCell::new(None));

fn st() -> &'static mut State {
    // SAFETY: single-threaded; every export takes this once and holds it only for its own duration.
    let s = unsafe { &mut *STATE.0.get() };
    s.get_or_insert_with(|| State {
        input: Vec::new(),
        kbuf: Vec::new(),
        steps: Vec::new(),
        out: [0; OUTW],
        info: [0; 8],
        nav: [0; 8],
        scratch: Vec::new(),
        mark_cap: 0,
        progs: Vec::new(),
        sessions: Vec::new(),
        tape: Vec::new(),
        bytes: Vec::new(),
        eout: Vec::new(),
        epos: 0,
        keys: Vec::new(),
        pairs: Vec::new(),
        x: Vec::new(),
        ws: [0; 4],
    })
}

fn grow<T: Copy + Default>(v: &mut Vec<T>, n: usize) -> *mut T {
    if v.len() < n {
        let want = n.max(v.len() * 2);
        v.resize(want, T::default());
    }
    v.as_mut_ptr()
}

/// A region the host fills (its own pointer and length must come back to `sdk_free`).
#[no_mangle]
pub extern "C" fn sdk_alloc(n: usize) -> *mut u8 {
    // SAFETY: a nonzero size, align 8; failure aborts (a trap the SDK recovers from).
    unsafe { alloc_zeroed(Layout::from_size_align_unchecked(n.max(1), 8)) }
}
#[no_mangle]
pub extern "C" fn sdk_free(p: *mut u8, n: usize) {
    // SAFETY: p came from sdk_alloc(n).
    unsafe { dealloc(p, Layout::from_size_align_unchecked(n.max(1), 8)) }
}
/// The reusable input buffer, at least n bytes (grown, never shrunk here).
#[no_mangle]
pub extern "C" fn sdk_input(n: usize) -> *mut u8 {
    grow(&mut st().input, n)
}
/// A reusable byte scratch (rule names, lookup keys), at least n bytes.
#[no_mangle]
pub extern "C" fn sdk_kbuf(n: usize) -> *mut u8 {
    grow(&mut st().kbuf, n)
}
/// A reusable word scratch (batched navigation steps), at least n words.
#[no_mangle]
pub extern "C" fn sdk_steps(n: usize) -> *mut i32 {
    grow(&mut st().steps, n)
}
#[no_mangle]
pub extern "C" fn sdk_info() -> *mut i32 {
    st().info.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sdk_out() -> *mut i32 {
    st().out.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn sdk_nav_words() -> *mut i32 {
    st().nav.as_mut_ptr()
}
/// Drop every reusable buffer (programs and sessions are kept). The allocator
/// reuses the space; linear memory itself never shrinks.
#[no_mangle]
pub extern "C" fn sdk_trim() {
    let s = st();
    s.input = Vec::new();
    s.kbuf = Vec::new();
    s.steps = Vec::new();
    s.scratch = Vec::new();
    s.mark_cap = 0;
    s.tape = Vec::new();
    s.bytes = Vec::new();
    s.eout = Vec::new();
    s.keys = Vec::new();
    s.pairs = Vec::new();
    s.x = Vec::new();
}
/// The scanner's name of a profile code (cbor.mjs's): a pointer, its length in INFO[0].
#[no_mangle]
pub extern "C" fn sdk_code_name(code: i32) -> *const u8 {
    let n = code_name(code);
    st().info[0] = n.len() as i32;
    n.as_ptr()
}

unsafe fn bytes<'a>(p: *const u8, n: usize) -> &'a [u8] {
    if n == 0 { &[] } else { std::slice::from_raw_parts(p, n) }
}

// ---------------------------------------------------------------- profile scan

/// Scan [p, p+n): 0 or a profile code; the error offset in INFO[0].
#[no_mangle]
pub extern "C" fn sdk_scan(p: *const u8, n: usize, top_any: i32, cose: i32, max_bytes: i32, max_depth: i32,
                           max_entries: i32, max_items: i32) -> i32 {
    let b = unsafe { bytes(p, n) };
    let mut o = [0i32; 16];
    scan_options(&mut o, top_any, cose, max_bytes, max_depth, max_entries, max_items);
    let c = scan(b, &mut o);
    st().info[0] = error_offset(&mut o);
    c
}

// ---------------------------------------------------------------- Programs and the VM

/// Copy and verify a Program (words at pp, pool at bp): a handle >= 0, or -1
/// when vm-verify refuses it (INFO[0..2]: the word and check), -2 when too small.
#[no_mangle]
pub extern "C" fn sdk_prog_load(pp: *const i32, words: usize, bp: *const u8, nb: usize) -> i32 {
    if words < 64 {
        return -2;
    }
    let p: Vec<i32> = unsafe { std::slice::from_raw_parts(pp, words) }.to_vec();
    let b: Vec<u8> = unsafe { bytes(bp, nb) }.to_vec();
    let m = p[16].clamp(0, 1 << 20) as usize;
    let mut s = vec![0i32; 64 + 2 * m];
    s[16] = 1;
    s[17] = m as i32;
    let st = st();
    if vm_verify(&p, &b, &mut s) != 0 {
        st.info[0] = s[35];
        st.info[1] = s[36];
        return -1;
    }
    let slot = st.progs.iter().position(|x| x.is_none()).unwrap_or_else(|| { st.progs.push(None); st.progs.len() - 1 });
    st.progs[slot] = Some(Prog { p, b });
    slot as i32
}
#[no_mangle]
pub extern "C" fn sdk_prog_free(h: usize) {
    if let Some(x) = st().progs.get_mut(h) { *x = None; }
}
/// The rule index of the name in kbuf[0..n) (vm-rule-index), or -1.
#[no_mangle]
pub extern "C" fn sdk_rule_index(h: usize, n: usize) -> i32 {
    let s = st();
    match s.progs.get(h) {
        Some(Some(pr)) => vm_rule_index(&pr.p, &pr.b, &s.kbuf[..n]),
        _ => -1,
    }
}

fn lease(s: &mut State, h: usize, rule: i32) -> bool {
    let pr = match s.progs.get(h) { Some(Some(pr)) => pr, _ => return false };
    let cap = s.mark_cap.max(pr.p[16]);
    let need = vm_scratch_words(&pr.p, rule, cap) as usize;
    if cap > s.mark_cap || need > s.scratch.len() {
        s.scratch = vec![0; need.max(s.scratch.len())];
        s.mark_cap = cap;
        vm_scratch_init(&mut s.scratch, cap);
    }
    true
}

/// vm-validate over [p, p+n) against `rule` of Program h; the out words in OUT.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sdk_validate(h: usize, rule: i32, p: *const u8, n: usize, l0: i32, l1: i32, l2: i32, l3: i32,
                               l4: i32, l5: i32, l6: i32, l7: i32) -> i32 {
    let s = st();
    if !lease(s, h, rule) { return -100; }
    let pr = s.progs[h].as_ref().unwrap();
    let lim = [l0, l1, l2, l3, l4, l5, l6, l7];
    vm_validate(&pr.p, &pr.b, rule, unsafe { bytes(p, n) }, &lim, &mut s.scratch, &mut s.out)
}
/// vm-validate-span: the span [start, end) of [p, p+n) as its own document.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sdk_validate_span(h: usize, rule: i32, p: *const u8, n: usize, start: i32, end: i32, depth: i32,
                                    items: i32, l0: i32, l1: i32, l2: i32, l3: i32, l4: i32, l5: i32, l6: i32,
                                    l7: i32) -> i32 {
    let s = st();
    if !lease(s, h, rule) { return -100; }
    let pr = s.progs[h].as_ref().unwrap();
    let lim = [l0, l1, l2, l3, l4, l5, l6, l7];
    vm_validate_span(&pr.p, &pr.b, rule, unsafe { bytes(p, n) }, start, end, depth, items, &lim, &mut s.scratch, &mut s.out)
}

// ---------------------------------------------------------------- navigation over checked bytes at [m, m+n)

fn nav<'a>(m: *const u8, n: usize) -> (&'a [u8], &'static mut [i32; 8]) {
    let o = &mut st().nav;
    o[N_STEPS as usize] = 0;
    (unsafe { bytes(m, n) }, o)
}
#[no_mangle]
pub extern "C" fn sdk_nav_init() {
    nav_init(&mut st().nav, 0x7fffffff);
}
/// nav-head: content start; major, ai, hi, lo in the nav words.
#[no_mangle]
pub extern "C" fn sdk_nav_head(m: *const u8, n: usize, p: i32) -> i32 {
    let (b, o) = nav(m, n);
    nav_head(b, o, p, n as i32)
}
#[no_mangle]
pub extern "C" fn sdk_nav_skip(m: *const u8, n: usize, p: i32) -> i32 {
    let (b, o) = nav(m, n);
    nav_skip(b, o, p, n as i32)
}
#[no_mangle]
pub extern "C" fn sdk_nav_child(m: *const u8, n: usize, p: i32, i: i32) -> i32 {
    let (b, o) = nav(m, n);
    nav_child(b, o, p, i, n as i32)
}
/// nav-find with the encoded key in kbuf[ks..ke).
#[no_mangle]
pub extern "C" fn sdk_nav_find(m: *const u8, n: usize, p: i32, ks: i32, ke: i32) -> i32 {
    let (b, o) = nav(m, n);
    nav_find(b, o, p, &st().kbuf, ks, ke, n as i32)
}
/// nav-dir into the words at d (capacity cap).
#[no_mangle]
pub extern "C" fn sdk_nav_dir(m: *const u8, n: usize, p: i32, d: *mut i32, cap: usize) -> i32 {
    let (b, o) = nav(m, n);
    let d = unsafe { std::slice::from_raw_parts_mut(d, cap) };
    nav_dir(b, o, p, d, n as i32)
}
#[no_mangle]
pub extern "C" fn sdk_nav_dir_find(m: *const u8, n: usize, d: *const i32, cnt: i32, ks: i32, ke: i32) -> i32 {
    let (b, o) = nav(m, n);
    let d = unsafe { std::slice::from_raw_parts(d, cnt.max(0) as usize) };
    nav_dir_find(b, o, d, cnt, &st().kbuf, ks, ke, n as i32)
}
/// Batched navigation: from p, follow `count` steps in the step words (each
/// [0, index, 0] into an array or [1, ks, ke] by the encoded key kbuf[ks..ke)
/// in a map). Answers the final position, -3 (NAV_NOT_FOUND) when a step
/// misses or meets the wrong kind (INFO[0]: steps completed), or another
/// negative nav answer.
#[no_mangle]
pub extern "C" fn sdk_nav_path(m: *const u8, n: usize, p: i32, count: usize) -> i32 {
    let s = st();
    let b = unsafe { bytes(m, n) };
    let end = n as i32;
    let mut q = p;
    for k in 0..count {
        s.info[0] = k as i32;
        s.nav[N_STEPS as usize] = 0;
        let (kind, a, c) = (s.steps[3 * k], s.steps[3 * k + 1], s.steps[3 * k + 2]);
        let h = nav_head(b, &mut s.nav, q, end);
        if h < 0 { return h; }
        let major = s.nav[N_MAJOR as usize];
        q = if kind == 0 {
            if major != 4 { return -3; }
            nav_child(b, &mut s.nav, q, a, end)
        } else {
            if major != 5 { return -3; }
            nav_find(b, &mut s.nav, q, &s.kbuf, a, c, end)
        };
        if q < 0 { return q; }
    }
    s.info[0] = count as i32;
    q
}
/// Batched iteration: for the array or map at p, write [key position or -1,
/// value position] per child into the words at d (capacity cap pairs). Answers
/// the count, or a negative nav answer.
#[no_mangle]
pub extern "C" fn sdk_nav_entries(m: *const u8, n: usize, p: i32, d: *mut i32, cap: usize) -> i32 {
    let (b, o) = nav(m, n);
    let end = n as i32;
    let c = nav_head(b, o, p, end);
    if c < 0 { return c; }
    let major = o[N_MAJOR as usize];
    let cnt = o[N_LO as usize];
    if major != 4 && major != 5 { return -3; }
    if cnt as usize > cap { return -4; }
    let d = unsafe { std::slice::from_raw_parts_mut(d, 2 * cap) };
    let mut q = c;
    for i in 0..cnt as usize {
        o[N_STEPS as usize] = 0;
        if major == 5 {
            let v = nav_skip(b, o, q, end);
            if v < 0 { return v; }
            d[2 * i] = q;
            d[2 * i + 1] = v;
            q = nav_skip(b, o, v, end);
        } else {
            d[2 * i] = -1;
            d[2 * i + 1] = q;
            q = nav_skip(b, o, q, end);
        }
        if q < 0 { return q; }
    }
    cnt
}

/// Paged batched iteration: from child position q of a map (is_map 1) or an
/// array, write up to `count` pairs [key position or -1, value position] into
/// the words at d. Answers the position after the last child written, or a
/// negative nav answer. The host asks page by page, so an iteration that stops
/// early does not pay for the whole container.
#[no_mangle]
pub extern "C" fn sdk_nav_page(m: *const u8, n: usize, q: i32, count: usize, is_map: i32, d: *mut i32) -> i32 {
    let (b, o) = nav(m, n);
    let end = n as i32;
    let d = unsafe { std::slice::from_raw_parts_mut(d, 2 * count) };
    let mut q = q;
    for i in 0..count {
        o[N_STEPS as usize] = 0;
        if is_map == 1 {
            let v = nav_skip(b, o, q, end);
            if v < 0 { return v; }
            d[2 * i] = q;
            d[2 * i + 1] = v;
            q = nav_skip(b, o, v, end);
        } else {
            d[2 * i] = -1;
            d[2 * i + 1] = q;
            q = nav_skip(b, o, q, end);
        }
        if q < 0 { return q; }
    }
    q
}

// ---------------------------------------------------------------- sessions (handles and streams)

fn put_session(s: &mut State, x: Sess) -> i32 {
    let slot = s.sessions.iter().position(|x| x.is_none()).unwrap_or_else(|| { s.sessions.push(None); s.sessions.len() - 1 });
    s.sessions[slot] = Some(x);
    slot as i32
}
/// A resumable profile scan of a `total`-byte message (rscan).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sdk_rs_new(total: i32, quantum: i32, top_any: i32, cose: i32, max_bytes: i32, max_depth: i32,
                             max_entries: i32, max_items: i32) -> i32 {
    let mut o = [0i32; 16];
    scan_options(&mut o, top_any, cose, max_bytes, max_depth, max_entries, max_items);
    let mut s = vec![0i32; rscan_scratch_len(max_depth, total.min(max_bytes)) as usize];
    rscan_init(&mut o, &mut s, total, quantum);
    put_session(st(), Sess::Scan { o, s, w: Vec::new() })
}
/// A resumable VM validation (vms) of `total` bytes against `rule` of Program h; -1 on a bad handle.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn sdk_vs_new(h: usize, rule: i32, total: i32, quantum: i32, l0: i32, l1: i32, l2: i32, l3: i32,
                             l4: i32, l5: i32, l6: i32, l7: i32) -> i32 {
    let st = st();
    let pr = match st.progs.get(h) { Some(Some(pr)) => pr, _ => return -1 };
    let lim = [l0, l1, l2, l3, l4, l5, l6, l7];
    let cap = pr.p[16].max(1);
    let mut s = vec![0i32; vm_scratch_words(&pr.p, rule, cap) as usize];
    vm_scratch_init(&mut s, cap);
    let mut ss = vec![0i32; vms_words(&pr.p) as usize];
    let mut ka = vec![0u8; vms_arena(&pr.p, &lim, total) as usize];
    let c = vms_init(&pr.p, &pr.b, rule, &lim, &mut s, &mut ss, &mut ka, total, quantum);
    if c < 0 { return -2; }
    put_session(st, Sess::Vm { prog: h, s, ss, ka, out: vec![0; OUTW], w: Vec::new() })
}
/// The session's window buffer, at least n bytes (the host copies the window in).
#[no_mangle]
pub extern "C" fn sdk_ses_window(h: usize, n: usize) -> *mut u8 {
    match st().sessions.get_mut(h) {
        Some(Some(Sess::Scan { w, .. })) | Some(Some(Sess::Vm { w, .. })) => grow(w, n),
        _ => std::ptr::null_mut(),
    }
}
/// One step over window[0..n) holding message bytes from `base`. Answers the
/// session's code (rscan: 0, a profile code, -1 need, -2 yield; vms: >= 0 done
/// with out words copied to OUT, -64 need, -65 yield). INFO: need offset, need
/// length, position, keep.
#[no_mangle]
pub extern "C" fn sdk_ses_step(h: usize, n: usize, base: i32) -> i32 {
    let st = st();
    let progs = &st.progs;
    match st.sessions.get_mut(h) {
        Some(Some(Sess::Scan { o, s, w })) => {
            let r = rscan_step(&w[..n], o, s, 0, base);
            st.info[0] = rscan_need_offset(s);
            st.info[1] = rscan_need_length(s);
            st.info[2] = rscan_position(s);
            st.info[3] = error_offset(o);
            r
        }
        Some(Some(Sess::Vm { prog, s, ss, ka, out, w })) => {
            let pr = match progs.get(*prog) { Some(Some(pr)) => pr, _ => return -100 };
            let r = vms_step(&pr.p, &pr.b, &w[..n], s, ss, ka, out, base);
            st.info[0] = vms_need_offset(ss);
            st.info[1] = vms_need_length(ss);
            st.info[2] = vms_position(ss);
            st.info[3] = vms_keep(ss);
            if r >= 0 { st.out.copy_from_slice(&out[..OUTW]); }
            r
        }
        _ => -100,
    }
}
#[no_mangle]
pub extern "C" fn sdk_ses_free(h: usize) {
    if let Some(x) = st().sessions.get_mut(h) { *x = None; }
}

// ---------------------------------------------------------------- encode: a tape the JS walk wrote
//
// The JS walk (host-value admission, items/depth/entries bounds) writes ops;
// this turns them into deterministic CBOR with kin's writer primitives.
//   [1, major, hi, lo]   a head; major 4 is followed by lo items, major 6 by one
//   [2, hi, lo]          a float from binary64 bits (kin picks the width or refuses)
//   [3, off, len]        text, UTF-8 in the byte area
//   [4, off, len]        a byte string from the byte area
//   [5, neg, off, len]   an integer from big-endian magnitude bytes (bignums)
//   [6, n, key ops (n of [3,..] or [1,..]), n value-start indices, values]
//                         a map: kin orders the keys before any value is written

/// The tape, at least n words (contents kept).
#[no_mangle]
pub extern "C" fn sdk_enc_tape(n: usize) -> *mut i32 {
    grow(&mut st().tape, n)
}
/// The byte area, at least n bytes (contents kept).
#[no_mangle]
pub extern "C" fn sdk_enc_bytes(n: usize) -> *mut u8 {
    grow(&mut st().bytes, n)
}
#[no_mangle]
pub extern "C" fn sdk_enc_out() -> *const u8 {
    st().eout.as_ptr()
}

const ENC_DEPTH: i32 = 4096;

fn ensure(v: &mut Vec<u8>, at: usize, need: usize) {
    if at + need > v.len() {
        let mut size = v.len().max(256) * 2;
        while size < at + need { size *= 2; }
        v.resize(size, 0);
    }
}
/// A kin write's answer r at `at` in v: grow and retry on a short answer.
fn kin_put(v: &mut Vec<u8>, at: usize, mut f: impl FnMut(&mut [u8]) -> i32) -> Result<usize, i32> {
    loop {
        let r = f(v);
        if r >= 0 { return Ok(r as usize); }
        let need = -(r as i64) - WR_NEED as i64;
        if need <= 0 { return Err(r); }
        ensure(v, at, need as usize);
    }
}

struct Enc<'a> {
    tape: &'a [i32],
    bytes: &'a [u8],
    out: &'a mut Vec<u8>,
    pos: usize,
    keys: &'a mut Vec<u8>,
    kpos: usize,
    pairs: &'a mut Vec<i32>,
    x: &'a mut Vec<i32>,
    ws: &'a mut [i32; 4],
}

impl Enc<'_> {
    fn head(&mut self, major: i32, hi: i32, lo: i32) -> Result<(), i32> {
        let at = self.pos;
        self.pos = kin_put(self.out, at, |o| put_head(o, at as i32, major, hi, lo))?;
        Ok(())
    }
    fn raw(&mut self, off: usize, len: usize) {
        ensure(self.out, self.pos, len);
        self.out[self.pos..self.pos + len].copy_from_slice(&self.bytes[off..off + len]);
        self.pos += len;
    }
    /// One key op at i into the key scratch: its span there, and the next op.
    fn key(&mut self, i: usize) -> Result<(usize, usize, usize), i32> {
        let t = self.tape;
        let ks = self.kpos;
        if t[i] == 3 {
            let (off, len) = (t[i + 1] as usize, t[i + 2] as usize);
            self.kpos = kin_put(self.keys, ks, |o| put_head(o, ks as i32, 3, 0, len as i32))?;
            ensure(self.keys, self.kpos, len);
            self.keys[self.kpos..self.kpos + len].copy_from_slice(&self.bytes[off..off + len]);
            self.kpos += len;
            Ok((ks, self.kpos, i + 3))
        } else {
            self.kpos = kin_put(self.keys, ks, |o| put_head(o, ks as i32, t[i + 1], t[i + 2], t[i + 3]))?;
            Ok((ks, self.kpos, i + 4))
        }
    }
    /// The item at tape index i; answers the index after it.
    fn item(&mut self, i: usize, depth: i32) -> Result<usize, i32> {
        if depth > ENC_DEPTH { return Err(-1000); }
        let t = self.tape;
        match t[i] {
            1 => {
                let (major, hi, lo) = (t[i + 1], t[i + 2], t[i + 3]);
                self.head(major, hi, lo)?;
                let mut j = i + 4;
                if major == 4 {
                    for _ in 0..lo { j = self.item(j, depth + 1)?; }
                } else if major == 6 {
                    j = self.item(j, depth + 1)?;
                }
                Ok(j)
            }
            2 => {
                let at = self.pos;
                let (hi, lo) = (t[i + 1], t[i + 2]);
                self.pos = kin_put(self.out, at, |o| put_float(o, at as i32, hi, lo))?;
                Ok(i + 3)
            }
            3 | 4 => {
                let (off, len) = (t[i + 1] as usize, t[i + 2] as usize);
                self.head(if t[i] == 3 { 3 } else { 2 }, 0, len as i32)?;
                self.raw(off, len);
                Ok(i + 3)
            }
            5 => {
                let at = self.pos;
                let (neg, off, len) = (t[i + 1], t[i + 2], t[i + 3]);
                let bytes = self.bytes;
                self.pos = kin_put(self.out, at, |o| put_int(o, at as i32, neg, bytes, off, off + len))?;
                Ok(i + 4)
            }
            6 => {
                let n = t[i + 1] as usize;
                self.head(5, 0, n as i32)?;
                let mut j = i + 2;
                if n == 0 { return Ok(j); }
                // the keys, encoded into the key scratch; kin orders them
                let (kb0, base) = (self.kpos, self.pairs.len());
                for _ in 0..n {
                    let (ks, ke, next) = self.key(j)?;
                    self.pairs.push(ks as i32);
                    self.pairs.push(ke as i32);
                    j = next;
                }
                let slots = j;
                let xb = self.x.len();
                self.x.resize(xb + 2 * n, 0);
                self.ws[0] = 0;
                self.ws[S_BUDGET as usize] = i32::MAX;
                let r = sort_keys(self.keys, self.pairs, base as i32, n as i32, self.x, xb as i32, self.ws);
                if r != 0 { return Err(r); }
                let mut end = slots + n;
                for k in 0..n {
                    let p = self.x[xb + k] as usize;
                    let (ks, ke) = (self.pairs[base + 2 * p] as usize, self.pairs[base + 2 * p + 1] as usize);
                    let len = ke - ks;
                    ensure(self.out, self.pos, len);
                    self.out[self.pos..self.pos + len].copy_from_slice(&self.keys[ks..ke]);
                    self.pos += len;
                    let e = self.item(t[slots + p] as usize, depth + 1)?;
                    if p == n - 1 { end = e; }
                }
                self.x.truncate(xb);
                self.pairs.truncate(base);
                self.kpos = kb0;
                Ok(end)
            }
            _ => Err(-4),
        }
    }
}

/// Encode the tape's first item: the output length (bytes at `sdk_enc_out()`),
/// or a negative kin code (-7 duplicate_key, -9 float, -12 bignum, ...).
#[no_mangle]
pub extern "C" fn sdk_enc_run() -> i32 {
    let s = st();
    s.pairs.clear();
    s.x.clear();
    let mut e = Enc {
        tape: &s.tape, bytes: &s.bytes, out: &mut s.eout, pos: 0, keys: &mut s.keys, kpos: 0,
        pairs: &mut s.pairs, x: &mut s.x, ws: &mut s.ws,
    };
    match e.item(0, 0) {
        Ok(_) => { s.epos = e.pos; e.pos as i32 }
        Err(r) => r,
    }
}

// ---------------------------------------------------------------- boundary probe

/// One kin head into a scratch: the per-call boundary cost probe (P7.9's
/// "fine-grained" encode alternative, timed per call by the bench).
#[no_mangle]
pub extern "C" fn sdk_probe_head(major: i32, hi: i32, lo: i32) -> i32 {
    let s = st();
    let at = s.epos;
    ensure(&mut s.eout, at, 9);
    let r = put_head(&mut s.eout, at as i32, major, hi, lo);
    s.epos = if r > 1 << 20 { 0 } else { r as usize };
    r
}
#[no_mangle]
pub extern "C" fn sdk_probe_reset() {
    st().epos = 0;
}
