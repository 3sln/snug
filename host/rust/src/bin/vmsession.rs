// `bb vmsession-test`'s Rust arm (P6.2): the resumable session over windows
// chosen by the same deterministic policy as kin/scripts/vmsession-run.mjs.
// Reads lines on stdin:
//
//     prog <words, comma-separated decimal> <pool hex or ->
//     case <prog index> <rule> <l0> .. <l10> <kind> <w> <q> <seed> <k> <input hex or ->
//     host <prog index> <rule> <top_map> <cose> <chunk> <quantum> <input hex or ->
//
// `host` goes through the Rust host's session API (`snug::schema::validate_blob`)
// and prints `ok` or `<reason>|<subcode>|<offset>|<path segments joined by />`,
// as vm.rs does for `validate`.
//
// and prints, per case, `out[0..8+2*out[6]]` space-separated, `E <why>` for a
// broken session contract, or `PANIC` (caught per case; the crate is built in
// debug, overflow checks on). Every session owns fresh scratch, session array
// and key arena.
use snug::schema::{validate_blob, BytesBlob, Options, Program, Segment};
use snug::snug::vm::api::{vm_scratch_init, vm_scratch_words};
use snug::snug::vm::session::{vms_arena, vms_eof, vms_held_code, vms_init, vms_init_unknown, vms_keep, vms_need_length,
                               vms_need_offset, vms_position, vms_step_v, vms_unknown_total, vms_words,
                               vms_grow_arena, vms_grow_bytes, vms_grow_scratch, vms_grow_words};
use snug::controls::{port, prepare_all, program_controls, Control, Controls};
use std::io::{BufRead, Write};
use std::sync::Arc;

/// P7.2: kin/scripts/ext-cases.mjs's test registry (as in bin/vm.rs).
pub struct Even;
impl Control for Even {
    fn check(&self, _a: &[u8], item: &[u8]) -> bool { item.len() % 2 == 0 }
    fn max_bytes(&self) -> u32 { 300 }
}
pub struct Tiny;
impl Control for Tiny {
    fn check(&self, a: &[u8], item: &[u8]) -> bool { snug::controls::Chars.check(a, item) }
    fn max_bytes(&self) -> u32 { 8 }
    fn prepare(&self, pool: &[u8], ao: i32, al: i32) -> Option<Vec<i32>> { snug::controls::Chars.prepare(pool, ao, al) }
    fn run(&self, pool: &[u8], ao: i32, t: &[i32], b: &[u8], s: i32, e: i32, room: i32) -> i32 {
        snug::controls::Chars.run(pool, ao, t, b, s, e, room)
    }
}
/// `.costly`: the item's length is not a multiple of 3, declared cost 3n + 5 (D193), maxBytes 1000.
pub struct Costly;
impl Control for Costly {
    fn check(&self, _a: &[u8], item: &[u8]) -> bool { item.len() % 3 != 0 }
    fn max_bytes(&self) -> u32 { 1000 }
    fn cost(&self, n: u32) -> u64 { 3 * u64::from(n) + 5 }
}
/// `.huge`: always true, declared cost 1,000,000,000 (the budget refuses unasked).
pub struct Huge;
impl Control for Huge {
    fn check(&self, _a: &[u8], _item: &[u8]) -> bool { true }
    fn cost(&self, _n: u32) -> u64 { 1_000_000_000 }
}
fn test_controls() -> Controls {
    Controls::generic().with("even", Even).with("tiny", Tiny).with("costly", Costly).with("huge", Huge)
}

const VMS_NEED: i32 = -64;
const VMS_YIELD: i32 = -65;
const VMS_HELD: i32 = -67;
const VMS_RESUME: i32 = -68;

fn unhex(s: &str) -> Vec<u8> {
    if s == "-" {
        return Vec::new();
    }
    let b = s.as_bytes();
    let v = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => panic!("bad hex"),
        }
    };
    (0..b.len() / 2).map(|i| (v(b[2 * i]) << 4) | v(b[2 * i + 1])).collect()
}

struct Policy {
    kind: i32,
    w: i32,
    q: i32,
    seed: u32,
    k: i32,
}

fn run(p: &[i32], pool: &[u8], rule: i32, lim: &[i32], input: &[u8], pol: &Policy) -> String {
    let n = input.len() as i32;
    let cap = p[16].max(1);
    let mut s = vec![0i32; vm_scratch_words(p, rule, cap) as usize];
    vm_scratch_init(&mut s, cap);
    let mut ss = vec![0i32; vms_words(p) as usize];
    let mut ka = vec![0u8; vms_arena(p, lim, n).max(0) as usize];
    let (mut vs, mut cb) = (vec![0i32; 512], vec![0u8; 1024]);
    let mut out = vec![0i32; 8 + 2 * 257];
    let reg = test_controls();
    let ext: Vec<Arc<dyn Control>> = program_controls(p, pool).iter().filter_map(|n| reg.get(n).cloned()).collect();
    let preps = prepare_all(p, pool, &ext);
    let xf = |id: i32, pl: &[u8], ao: i32, al: i32, b: &[u8], st: i32, e: i32, room: i32| -> i32 {
        port(&*ext[id as usize], preps.get(&(id, ao)).map(Vec::as_slice), pl, ao, al, b, st, e, room)
    };
    let ci = vms_init(p, pool, rule, lim, &mut s, &mut ss, &mut ka, n, pol.q);
    if ci < 0 {
        return format!("E vms-init {}", ci);
    }
    let mut x: u32 = if pol.seed == 0 { 0x9e3779b9 } else { pol.seed };
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x
    };
    let limit = 200000 + 64 * n as i64;
    let (mut off, mut len, mut steps, mut first) = (0i32, 1i32, 0i64, true);
    loop {
        let l = if first && pol.kind == 3 {
            pol.k.min(n)
        } else if pol.kind == 0 || pol.kind == 3 {
            n - off
        } else if pol.kind == 1 {
            len.max(pol.w)
        } else {
            len.max(1 + (rnd() % pol.w as u32) as i32)
        };
        first = false;
        let e = n.min(off + l);
        let win: Vec<u8> = input[off as usize..e as usize].to_vec();
        let r = loop {
            let none = |_: i32, _: &[u8], _: i32, _: i32, _: &[u8], _: i32, _: i32, _: i32| -> i32 { -2 };
            let r = if ext.is_empty() {
                vms_step_v(p, pool, &win, &mut s, &mut ss, &mut ka, &mut out, off, &none, &mut vs, &mut cb)
            } else {
                vms_step_v(p, pool, &win, &mut s, &mut ss, &mut ka, &mut out, off, &xf, &mut vs, &mut cb)
            };
            if r != -69 {
                break r;
            }
            let (w, nb, sw, aw) = (vms_grow_words(&ss), vms_grow_bytes(&ss), vms_grow_scratch(&ss), vms_grow_arena(&ss));
            if w as usize > vs.len() { vs = vec![0; (w as usize).max(2 * vs.len())]; }
            if nb as usize > cb.len() { cb = vec![0; (nb as usize).max(2 * cb.len())]; }
            if sw as usize > s.len() { s.resize(sw as usize, 0); }
            if aw as usize > ka.len() { ka.resize(aw as usize, 0); }
        };
        steps += 1;
        if r >= 0 {
            let m = 8 + 2 * out[6] as usize;
            return out[..m].iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" ");
        }
        if r == VMS_NEED {
            let (no, nl) = (vms_need_offset(&ss), vms_need_length(&ss));
            if no < 0 || nl < 1 || no + nl > n {
                return format!("E bad NEED({}, {}) of {}", no, nl, n);
            }
            off = no;
            len = nl;
        } else if r == VMS_YIELD {
            off = vms_position(&ss);
            len = 1;
            if off < 0 || off > n {
                return format!("E bad YIELD position {}", off);
            }
        } else {
            return format!("E vms-step {}", r);
        }
        if steps > limit {
            return format!("E no verdict after {} steps", steps);
        }
    }
}

/// D085: kin/scripts/vmsession-run.mjs `runUnknown`, the same loop: an unknown-length
/// session never told the message's length; a need past it, a yield past it or a held
/// verdict ends the stream (vms-eof). `ff`: a held refusal is answered at once.
fn run_unknown(p: &[i32], pool: &[u8], rule: i32, lim: &[i32], input: &[u8], pol: &Policy, ff: bool) -> String {
    let n = input.len() as i32;
    let cap = p[16].max(1);
    let total = vms_unknown_total(p, lim);
    let mut s = vec![0i32; vm_scratch_words(p, rule, cap) as usize];
    vm_scratch_init(&mut s, cap);
    let mut ss = vec![0i32; vms_words(p) as usize];
    let mut ka = vec![0u8; vms_arena(p, lim, total).max(0) as usize];
    let (mut vs, mut cb) = (vec![0i32; 512], vec![0u8; 1024]);
    let mut out = vec![0i32; 8 + 2 * 257];
    let reg = test_controls();
    let ext: Vec<Arc<dyn Control>> = program_controls(p, pool).iter().filter_map(|n| reg.get(n).cloned()).collect();
    let preps = prepare_all(p, pool, &ext);
    let xf = |id: i32, pl: &[u8], ao: i32, al: i32, b: &[u8], st: i32, e: i32, room: i32| -> i32 {
        port(&*ext[id as usize], preps.get(&(id, ao)).map(Vec::as_slice), pl, ao, al, b, st, e, room)
    };
    let ci = vms_init_unknown(p, pool, rule, lim, &mut s, &mut ss, &mut ka, pol.q);
    if ci < 0 {
        return format!("E vms-init-unknown {}", ci);
    }
    let mut x: u32 = if pol.seed == 0 { 0x9e3779b9 } else { pol.seed };
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x
    };
    let words = |out: &[i32]| out[..8 + 2 * out[6] as usize].iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" ");
    let limit = 200000 + 64 * n as i64;
    let (mut off, mut len, mut steps, mut first, mut eofed, mut last_keep) = (0i32, 1i32, 0i64, true, false, 0i32);
    loop {
        let l = if first && pol.kind == 3 {
            pol.k.min(n)
        } else if pol.kind == 0 || pol.kind == 3 {
            n - off
        } else if pol.kind == 1 {
            len.max(pol.w)
        } else {
            len.max(1 + (rnd() % pol.w as u32) as i32)
        };
        first = false;
        let e = n.min(total).min(off.saturating_add(l)).max(off);
        let win: Vec<u8> = input[off as usize..e as usize].to_vec();
        let mut r = loop {
            let none = |_: i32, _: &[u8], _: i32, _: i32, _: &[u8], _: i32, _: i32, _: i32| -> i32 { -2 };
            let r = if ext.is_empty() {
                vms_step_v(p, pool, &win, &mut s, &mut ss, &mut ka, &mut out, off, &none, &mut vs, &mut cb)
            } else {
                vms_step_v(p, pool, &win, &mut s, &mut ss, &mut ka, &mut out, off, &xf, &mut vs, &mut cb)
            };
            if r != -69 {
                break r;
            }
            let (w, nb, sw, aw) = (vms_grow_words(&ss), vms_grow_bytes(&ss), vms_grow_scratch(&ss), vms_grow_arena(&ss));
            if w as usize > vs.len() { vs = vec![0; (w as usize).max(2 * vs.len())]; }
            if nb as usize > cb.len() { cb = vec![0; (nb as usize).max(2 * cb.len())]; }
            if sw as usize > s.len() { s.resize(sw as usize, 0); }
            if aw as usize > ka.len() { ka.resize(aw as usize, 0); }
        };
        steps += 1;
        if r == VMS_HELD {
            if ff && vms_held_code(&ss) != 0 {
                return words(&out);
            }
            if eofed {
                return "E held after vms-eof".to_string();
            }
            eofed = true;
            r = vms_eof(&mut ss, &mut out, n);
            if r < 0 {
                return format!("E vms-eof {} after held", r);
            }
        }
        if r >= 0 {
            return words(&out);
        }
        if r == VMS_NEED {
            let (no, nl) = (vms_need_offset(&ss), vms_need_length(&ss));
            if vms_keep(&ss) > no {
                return format!("E keep past the need offset {}", no);
            }
            if no < last_keep || vms_keep(&ss) < last_keep {
                return format!("E NEED({}) before a keep already given ({})", no, last_keep);
            }
            last_keep = vms_keep(&ss);
            if no + nl > n.min(total) || (n > total && no + nl >= total) {
                if eofed {
                    return format!("E NEED({}, {}) past the end {} after vms-eof", no, nl, n);
                }
                eofed = true;
                let r2 = vms_eof(&mut ss, &mut out, n);
                if r2 >= 0 {
                    return words(&out);
                }
                if r2 != VMS_RESUME {
                    return format!("E vms-eof {}", r2);
                }
            }
            off = no;
            len = nl;
        } else if r == VMS_YIELD {
            off = vms_position(&ss);
            len = 1;
            if off < last_keep || vms_keep(&ss) < last_keep {
                return format!("E YIELD at {} before a keep already given ({})", off, last_keep);
            }
            last_keep = vms_keep(&ss);
            if off > n {
                if eofed {
                    return format!("E YIELD at {} past the end {} after vms-eof", off, n);
                }
                eofed = true;
                let r3 = vms_eof(&mut ss, &mut out, n);
                if r3 >= 0 {
                    return words(&out);
                }
                if r3 != VMS_RESUME {
                    return format!("E vms-eof {}", r3);
                }
                off = vms_position(&ss);
            }
            if off >= n {
                len = 0;
            }
        } else {
            return format!("E vms-step {}", r);
        }
        if steps > limit {
            return format!("E no verdict after {} steps", steps);
        }
    }
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    std::panic::set_hook(Box::new(|_| {}));
    let mut progs: Vec<(Vec<i32>, Vec<u8>)> = Vec::new();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        let f: Vec<&str> = line.split(' ').collect();
        match f[0] {
            "prog" => {
                let p: Vec<i32> = if f[1].is_empty() { Vec::new() } else { f[1].split(',').map(|x| x.parse().expect("word")).collect() };
                progs.push((p, unhex(f[2])));
            }
            "case" => {
                let n = |i: usize| -> i32 { f[i].parse().expect("number") };
                let (pi, rule) = (n(1) as usize, n(2));
                // limits words 0..10 (word 8 the generic/schedule/tier bits, word 9 the profile flags, D120,
                // word 10 the group arena's limit, program-2 §9.3)
                let lim: Vec<i32> = (0..11).map(|i| n(3 + i)).collect();
                let pol = Policy { kind: n(14), w: n(15), q: n(16), seed: f[17].parse().expect("seed"), k: n(18) };
                let input = unhex(f[19]);
                let (p, pool) = &progs[pi];
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(p, pool, rule, &lim, &input, &pol)));
                match r {
                    Ok(t) => writeln!(out, "{}", t).unwrap(),
                    Err(_) => writeln!(out, "PANIC").unwrap(),
                }
            }
            "ucase" => {
                let n = |i: usize| -> i32 { f[i].parse().expect("number") };
                let (pi, rule) = (n(1) as usize, n(2));
                let lim: Vec<i32> = (0..11).map(|i| n(3 + i)).collect();
                let pol = Policy { kind: n(14), w: n(15), q: n(16), seed: f[17].parse().expect("seed"), k: n(18) };
                let ff = n(19) == 1;
                let input = unhex(f[20]);
                let (p, pool) = &progs[pi];
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_unknown(p, pool, rule, &lim, &input, &pol, ff)));
                match r {
                    Ok(t) => writeln!(out, "{}", t).unwrap(),
                    Err(_) => writeln!(out, "PANIC").unwrap(),
                }
            }
            "host" => {
                let n = |i: usize| -> i32 { f[i].parse().expect("number") };
                let (p, pool) = &progs[n(1) as usize];
                let input = unhex(f[7]);
                let opts = Options { top_map: n(3) == 1, cose: n(4) == 1, ..Options::default() };
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match Program::new(p, pool).map(|mut h| { let _ = h.bind(&test_controls()); h }) {
                    Err(_) => "UNVERIFIED".to_string(),
                    Ok(h) => match validate_blob(&h, n(2), &BytesBlob(&input), &opts, n(5) as usize, n(6)) {
                        Err(e) => format!("SOURCE {:?}", e),
                        Ok(Ok(())) => "ok".to_string(),
                        Ok(Err(e)) => {
                            let path: Vec<String> = e.path.iter().map(|s| match s {
                                Segment::Index(i) => i.to_string(),
                                Segment::Key(k) => format!("{:?}", k),
                                Segment::AnyKey => "*".to_string(),
                                Segment::Tag => "#tag".to_string(),
                                Segment::Embedded => "cbor".to_string(),
                                Segment::EmbeddedItem(i) => format!("cbor/{}", i),
                            }).collect();
                            format!("{}|{}|{}|{}", e.reason, e.subcode.unwrap_or(""), e.offset, path.join("/"))
                        }
                    },
                }));
                match r {
                    Ok(t) => writeln!(out, "{}", t).unwrap(),
                    Err(_) => writeln!(out, "PANIC").unwrap(),
                }
            }
            _ => panic!("bad line"),
        }
    }
}
