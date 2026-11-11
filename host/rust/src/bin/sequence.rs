// `bb sequence-test`'s Rust arm (P7.13, D218): the session VM's sequence mode
// driven exactly as kin/scripts/sequence-run.mjs `runSequence` drives it, and the
// public host API (`snug::Sequence`). Reads lines on stdin:
//
//     prog <words, comma-separated decimal> <pool hex or ->
//     case <prog> <rule> <l0> .. <l9> <kind> <w> <q> <seed> <k> <skip> <ff> <input hex or ->
//     host <prog or -1 (profile only)> <rule name hex or -> <top_map> <cose> <limits words 2..7, -1 none>
//          <profile flags> <kind> <w> <seed> <k> <skip> <ff> <input hex or ->
//
// `case` prints runSequence's lines joined by " | " (or `E <why>`); `host` prints
// the host rendering (kin/scripts/sequence-test.mjs `renderHost`). A panic prints
// `PANIC` (caught per line; the crate is built in debug, overflow checks on).
use snug::controls::{port, prepare_all, program_controls, Control, Controls};
use snug::schema::Segment;
use snug::snug::vm::api::{vm_scratch_init, vm_scratch_words};
use snug::snug::vm::session::{vms_arena, vms_eof, vms_held_code, vms_init_seq, vms_keep, vms_message_length,
                               vms_need_length, vms_need_offset, vms_position, vms_step_v, vms_unknown_total,
                               vms_grow_arena, vms_grow_bytes, vms_grow_scratch, vms_grow_words,
                               vms_words};
use snug::{Error, OnInvalid, Profile, Schema, Sequence, SequenceOptions, Top};
use std::io::{BufRead, Write};
use std::sync::Arc;

// kin/scripts/ext-cases.mjs's test registry (as in bin/vmsession.rs).
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
pub struct Costly;
impl Control for Costly {
    fn check(&self, _a: &[u8], item: &[u8]) -> bool { item.len() % 3 != 0 }
    fn max_bytes(&self) -> u32 { 1000 }
    fn cost(&self, n: u32) -> u64 { 3 * u64::from(n) + 5 }
}
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

/// kin/scripts/sequence-run.mjs `chunkEnds`.
fn chunk_ends(n: usize, kind: i32, w: i32, seed: u32, k: i32) -> Vec<usize> {
    let mut ends = Vec::new();
    if n == 0 {
        return ends;
    }
    if kind == 0 {
        return vec![n];
    }
    if kind == 3 {
        let k = (k.max(1) as usize).min(n);
        return if k < n { vec![k, n] } else { vec![n] };
    }
    let mut x: u32 = if seed == 0 { 0x9e3779b9 } else { seed };
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x
    };
    let mut at = 0usize;
    while at < n {
        let step = if kind == 1 { w.max(1) as usize } else { 1 + (rnd() % w as u32) as usize };
        at = n.min(at + step);
        ends.push(at);
    }
    ends
}

/// The Profile whose flags these are (D120).
fn profile_of(f: i32) -> Profile {
    use snug::{Floats, Keys, Tags};
    Profile {
        keys: match f & 3 { 0 => Keys::Text, 1 => Keys::Integer, _ => Keys::Any },
        tags: match f & 12 { 0 => Tags::Bindle, 4 => Tags::Standard, _ => Tags::Any },
        floats: if f & 16 != 0 { Floats::Deterministic } else { Floats::Bindle },
        undefined_value: f & 32 != 0,
        noncharacters: f & 64 != 0,
        valid: f & 256 != 0,
    }
}

fn skippable(code: i32) -> bool {
    (32..=43).contains(&code)
}

fn words(out: &[i32], o: usize) -> String {
    let m = 8 + 2 * out[6] as usize;
    let mut w: Vec<i64> = out[..m].iter().map(|&v| i64::from(v)).collect();
    if w[0] != 0 {
        w[2] += o as i64;
    }
    w.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" ")
}

/// kin/scripts/sequence-run.mjs `runSequence`, line for line.
#[allow(clippy::too_many_arguments)]
fn run_sequence(p: &[i32], pool: &[u8], rule: i32, lim: &[i32], input: &[u8], kind: i32, w: i32, q: i32, seed: u32,
                k: i32, skip: bool, ff: bool) -> String {
    let n = input.len();
    let reg = test_controls();
    let ext: Vec<Arc<dyn Control>> = program_controls(p, pool).iter().filter_map(|n| reg.get(n).cloned()).collect();
    let preps = prepare_all(p, pool, &ext);
    let xf = |id: i32, pl: &[u8], ao: i32, al: i32, b: &[u8], st: i32, e: i32, room: i32| -> i32 {
        port(&*ext[id as usize], preps.get(&(id, ao)).map(Vec::as_slice), pl, ao, al, b, st, e, room)
    };
    let cap = p[16].max(1);
    let total = vms_unknown_total(p, lim) as usize;
    let mut s = vec![0i32; vm_scratch_words(p, rule, cap) as usize];
    vm_scratch_init(&mut s, cap);
    let mut ss = vec![0i32; vms_words(p) as usize];
    let mut ka = vec![0u8; vms_arena(p, lim, total as i32).max(0) as usize];
    let (mut vs, mut cb) = (vec![0i32; 512], vec![0u8; 1024]);
    let mut out = vec![0i32; 8 + 2 * 257];
    let ends = chunk_ends(n, kind, w, seed, k);
    let (mut ci, mut delivered) = (0usize, 0usize);
    let mut lines: Vec<String> = Vec::new();
    let (mut o, mut index, mut steps) = (0usize, 0usize, 0i64);
    let limit = 400000 + 64 * n as i64;
    macro_rules! more {
        () => {
            if ci >= ends.len() {
                false
            } else {
                delivered = ends[ci];
                ci += 1;
                true
            }
        };
    }
    loop {
        while delivered <= o {
            if !more!() {
                lines.push(format!("end {}", o));
                return lines.join(" | ");
            }
        }
        let c0 = vms_init_seq(p, pool, rule, lim, &mut s, &mut ss, &mut ka, q);
        if c0 < 0 {
            return format!("E vms-init-seq {}", c0);
        }
        let (mut at, mut eofed, mut last_keep, mut end, mut held, mut want) = (0usize, false, 0i32, total, false, 1usize);
        let mut asserted: usize;   // the end the last step's window asserted (every step sets it)
        macro_rules! step {
            () => {{
                let e = (delivered - o).min(end);
                if held {
                    at = e;
                }
                let w = e.min(at + want.max(65536));
                let win: Vec<u8> = input[o + at..o + at.max(w)].to_vec();
                asserted = at + win.len();
                steps += 1;
                loop {
                    let none = |_: i32, _: &[u8], _: i32, _: i32, _: &[u8], _: i32, _: i32, _: i32| -> i32 { -2 };
                    let r = if ext.is_empty() {
                        vms_step_v(p, pool, &win, &mut s, &mut ss, &mut ka, &mut out, at as i32, &none, &mut vs, &mut cb)
                    } else {
                        vms_step_v(p, pool, &win, &mut s, &mut ss, &mut ka, &mut out, at as i32, &xf, &mut vs, &mut cb)
                    };
                    if r != -69 {
                        break r;
                    }
                    let (gw, gb, gs, ga) = (vms_grow_words(&ss), vms_grow_bytes(&ss), vms_grow_scratch(&ss), vms_grow_arena(&ss));
                    if gw as usize > vs.len() { vs = vec![0; (gw as usize).max(2 * vs.len())]; }
                    if gb as usize > cb.len() { cb = vec![0; (gb as usize).max(2 * cb.len())]; }
                    if gs as usize > s.len() { s.resize(gs as usize, 0); }
                    if ga as usize > ka.len() { ka.resize(ga as usize, 0); }
                }
            }};
        }
        macro_rules! eof {
            () => {{
                if !(delivered - o > total || ci >= ends.len()) {
                    return "E vms-eof before the end".to_string();
                }
                eofed = true;
                let nn = delivered - o;
                if nn <= total {
                    end = nn;
                }
                vms_eof(&mut ss, &mut out, nn.min(i32::MAX as usize) as i32)
            }};
        }
        let mut r = step!();
        loop {
            if steps > limit {
                return format!("E no verdict after {} steps", steps);
            }
            if r == VMS_HELD {
                let (hc, ml) = (vms_held_code(&ss), vms_message_length(&ss));
                if ff && hc != 0 && !(skip && ml >= 0 && skippable(hc)) {
                    lines.push(format!("x {} {} {} early", index, o, words(&out, o)));
                    return lines.join(" | ");
                }
                if eofed {
                    return "E held after vms-eof".to_string();
                }
                held = true;
                // bytes delivered past the last window first release the claims they cover
                if asserted < (delivered - o).min(end) {
                    r = step!();
                    continue;
                }
                if delivered - o > total || !more!() {
                    r = eof!();
                    if r == VMS_RESUME {
                        return "E held then resume".to_string();
                    }
                    continue;
                }
                r = step!();
                continue;
            }
            if r >= 0 {
                break;
            }
            if r == VMS_NEED || r == VMS_YIELD {
                let is_need = r == VMS_NEED;
                let no = if is_need { vms_need_offset(&ss) } else { vms_position(&ss) };
                let nl = if is_need { vms_need_length(&ss) } else { 1 };
                let keep = vms_keep(&ss);
                if is_need && keep > no {
                    return format!("E keep {} past the need offset {}", keep, no);
                }
                if no < last_keep || keep < last_keep {
                    return format!("E {}({}) or keep {} before a keep already given ({})", if is_need { "NEED" } else { "YIELD" }, no, keep, last_keep);
                }
                last_keep = keep;
                if no < 0 || nl < 0 {
                    return format!("E bad request ({}, {})", no, nl);
                }
                let (nou, nlu) = (no as usize, nl as usize);
                if is_need && nou >= at && nou + nlu <= (delivered - o).min(end).min(at + want.max(65536)) {
                    return format!("E NEED({}, {}) inside the window [{}, {})", no, nl, at, delivered - o);
                }
                at = nou;
                want = if is_need { nlu } else { 1 };
                let upto = o + nou + if is_need { nlu } else { 0 };
                while delivered < upto && delivered - o <= total && more!() {}
                if delivered >= upto && nou + if is_need { nlu } else { 0 } <= end {
                    r = step!();
                    continue;
                }
                if eofed {
                    return format!("E {}({}, {}) past the end after vms-eof", if is_need { "NEED" } else { "YIELD" }, no, nl);
                }
                r = eof!();
                if r == VMS_RESUME {
                    at = vms_position(&ss) as usize;
                    if o + at > delivered {
                        return "E resume past the end".to_string();
                    }
                    r = step!();
                }
                continue;
            }
            return format!("E vms-step {}", r);
        }
        let ml = vms_message_length(&ss);
        if out[0] == 0 {
            if ml < 1 {
                return format!("E accepted with message length {}", ml);
            }
            if o + ml as usize > delivered {
                return format!("E accepted before its bytes arrived ({} > {})", o + ml as usize, delivered);
            }
            lines.push(format!("m {} {} {} {}", index, o, ml, words(&out, o)));
            o += ml as usize;
            index += 1;
            continue;
        }
        if skip && ml >= 0 && skippable(out[0]) {
            if o + ml as usize > delivered {
                return format!("E skipped before its bytes arrived ({} > {})", o + ml as usize, delivered);
            }
            lines.push(format!("s {} {} {} {}", index, o, ml, words(&out, o)));
            o += ml as usize;
            index += 1;
            continue;
        }
        lines.push(format!("x {} {} {}", index, o, words(&out, o)));
        return lines.join(" | ");
    }
}

fn path(segs: &[Segment]) -> String {
    segs.iter().map(|s| match s {
        Segment::Index(i) => i.to_string(),
        Segment::Key(k) => format!("{:?}", k),
        Segment::AnyKey => "*".to_string(),
        Segment::Tag => "#tag".to_string(),
        Segment::Embedded => "cbor".to_string(),
        Segment::EmbeddedItem(i) => format!("cbor/{}", i),
    }).collect::<Vec<_>>().join("/")
}

fn render_failure(tag: &str, e: &Error) -> String {
    match e {
        Error::Sequence(f) => format!("{} {} {} {} {} {} {} {}", tag, f.index, f.message_offset, f.offset, f.failure.reason,
                                      f.failure.subcode.unwrap_or("-"), path(&f.failure.path), f.skippable as i32),
        other => format!("{} OTHER {}", tag, other.code()),
    }
}

/// The host API over a chunk policy: feed each chunk (a fresh copy), then finish.
#[allow(clippy::too_many_arguments)]
fn run_host(prog: Option<&(Vec<i32>, Vec<u8>)>, rule: &str, opts: &SequenceOptions, input: &[u8], kind: i32, w: i32,
            seed: u32, k: i32) -> String {
    let schema;
    let mut seq = match prog {
        Some((p, pool)) => {
            let program = match snug::Program::from_parts_with(p, pool, &test_controls()) {
                Ok(x) => x,
                Err(_) => return "UNVERIFIED".to_string(),
            };
            schema = Schema::from_program(program);
            match schema.sequence(rule, opts) {
                Ok(s) => s,
                Err(e) => return format!("E {}", e.code()),
            }
        }
        None => Sequence::new(opts).expect("profile-only sequence"),
    };
    let mut lines: Vec<String> = Vec::new();
    let mut from = 0usize;
    let mut stopped = false;
    let ends = chunk_ends(input.len(), kind, w, seed, k);
    // D215 with D212 liveness: borrowed iff the message lies inside one chunk (it is then
    // released by the feed of that chunk)
    let one_chunk = |o: usize, len: usize| -> bool {
        let first = ends.iter().position(|&e| o < e);
        let last = ends.iter().position(|&e| o + len - 1 < e);
        first.is_some() && first == last
    };
    let take = |items: Vec<Result<snug::Message<'_>, Error>>, chunk_from: usize, chunk_to: usize, lines: &mut Vec<String>| -> bool {
        for it in items {
            match it {
                Ok(m) => {
                    let (o, len) = (m.offset as usize, m.len());
                    let good = o + len <= input.len() && m.bytes() == &input[o..o + len];
                    let inside = o >= chunk_from && o + len <= chunk_to;
                    let borrowed = m.is_borrowed();
                    // the view walks the same bytes as a View opened on them
                    let vw = m.view().raw().len() == len;
                    // D215: borrowed iff inside the chunk this feed was given (a message completed in a
                    // later feed owns its assembly)
                    lines.push(format!("m {} {} {}{}{}", m.index, o, len, if good && vw { "" } else { " BAD" },
                                       if borrowed != inside || borrowed != one_chunk(o, len) { " BADBORROW" } else { "" }));
                }
                Err(e) => {
                    let stop = !matches!(&e, Error::Sequence(f) if f.skippable && opts.on_invalid == OnInvalid::Skip);
                    lines.push(render_failure(if stop { "x" } else { "s" }, &e));
                    if stop {
                        return true;
                    }
                }
            }
        }
        false
    };
    for &end in &ends {
        let chunk = input[from..end].to_vec();
        let items = seq.feed(&chunk);
        if take(items, from, end, &mut lines) {
            stopped = true;
            break;
        }
        from = end;
    }
    if !stopped {
        let items = seq.finish();
        if !take(items, usize::MAX, 0, &mut lines) {
            lines.push("end".to_string());
        }
    }
    lines.join(" | ")
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
        let n = |i: usize| -> i32 { f[i].parse().expect("number") };
        let r = match f[0] {
            "prog" => {
                let p: Vec<i32> = if f[1].is_empty() { Vec::new() } else { f[1].split(',').map(|x| x.parse().expect("word")).collect() };
                progs.push((p, unhex(f[2])));
                continue;
            }
            "case" => {
                let (pi, rule) = (n(1) as usize, n(2));
                let lim: Vec<i32> = (0..10).map(|i| n(3 + i)).collect();
                let (kind, w, q, seed, k, skip, ff) = (n(13), n(14), n(15), f[16].parse::<u32>().expect("seed"), n(17), n(18) == 1, n(19) == 1);
                let input = unhex(f[20]);
                let (p, pool) = &progs[pi];
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_sequence(p, pool, rule, &lim, &input, kind, w, q, seed, k, skip, ff)))
            }
            "host" => {
                let pi = n(1);
                let rule = String::from_utf8(unhex(f[2])).expect("rule");
                let o = |i: usize| -> Option<u32> { let v = n(i); if v < 0 { None } else { Some(v as u32) } };
                let opts = SequenceOptions {
                    top: if n(3) == 1 { Top::Map } else { Top::Any },
                    cose: n(4) == 1,
                    max_message_bytes: o(5),
                    max_depth: o(6),
                    max_entries: o(7),
                    max_items: o(8),
                    max_bignum_bytes: o(9),
                    budget: o(10),
                    profile: profile_of(n(11)),
                    on_invalid: if n(16) == 1 { OnInvalid::Skip } else { OnInvalid::Stop },
                    fail_fast: n(17) == 1,
                    ..SequenceOptions::default()
                };
                let (kind, w, seed, k) = (n(12), n(13), f[14].parse::<u32>().expect("seed"), n(15));
                let input = unhex(f[18]);
                let prog = if pi < 0 { None } else { Some(&progs[pi as usize]) };
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_host(prog, &rule, &opts, &input, kind, w, seed, k)))
            }
            _ => panic!("bad line"),
        };
        match r {
            Ok(t) => writeln!(out, "{}", t).unwrap(),
            Err(_) => writeln!(out, "PANIC").unwrap(),
        }
    }
}
