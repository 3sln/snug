// `bb vm-test`'s Rust arm. Reads lines on stdin:
//
//     prog <words, comma-separated decimal> <pool hex or ->
//     case <prog index> <rule> <l0> .. <l8> <input hex or ->
//     span <prog index> <rule> <start> <end> <depth0> <items0> <l0> .. <l8> <input hex or ->
//
// (l8: bit 0 forces the generic path, bit 1 selects schedule 2, D044/D045)
//     host <prog index> <rule> <top_map> <cose> <input hex or ->
//
// `host` goes through the Rust host API (`snug::schema`) and prints `ok` or
// `<reason>|<subcode>|<offset>|<path segments joined by />` for comparison
// with the JS host's rendering.
//
// and prints, per case, `out[0..8+2*out[6]]` space-separated, or `PANIC`, or
// `ERR <code>` for a negative vm-validate answer. A panic is caught per case:
// the VM must never panic on any input, and this binary is built in debug
// (overflow checks on). One scratch per program, grown by the host protocol of
// program.md §13.1 (`&mut` scratch, D040).
use snug::schema::{validate, Options, Program, Segment};
use snug::snug::vm::api::{vm_scratch_init, vm_scratch_words, vm_validate_span_v, vm_validate_v};
use snug::controls::{port, prepare_all, program_controls, Control, Controls};
use std::sync::Arc;

/// P7.2: kin/scripts/ext-cases.mjs's test registry -- the generic controls, `.even`
/// (an even number of item bytes, maxBytes 300) and `.tiny` (`.chars`, maxBytes 8).
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
/// The predicates of a Program's controls, in id order (empty: it uses none).
fn bound(p: &[i32], b: &[u8], reg: &Controls) -> Vec<Arc<dyn Control>> {
    program_controls(p, b).iter().filter_map(|n| reg.get(n).cloned()).collect()
}
use std::io::{BufRead, Write};

fn unhex(s: &str) -> Vec<u8> {
    if s == "-" {
        return Vec::new();
    }
    let b = s.as_bytes();
    let v = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => panic!("bad hex"),
        }
    };
    (0..b.len() / 2).map(|i| (v(b[2 * i]) << 4) | v(b[2 * i + 1])).collect()
}

struct Prog {
    p: Vec<i32>,
    b: Vec<u8>,
    s: Vec<i32>,
    cap: i32,
    host: Option<Program>,
    ext: Vec<Arc<dyn Control>>,
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    std::panic::set_hook(Box::new(|_| {}));
    let mut progs: Vec<Prog> = Vec::new();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        let f: Vec<&str> = line.split(' ').collect();
        match f[0] {
            "prog" => {
                let p: Vec<i32> = if f[1].is_empty() { Vec::new() } else { f[1].split(',').map(|x| x.parse().expect("word")).collect() };
                let b = unhex(f[2]);
                let reg = test_controls();
                let host = Program::new(&p, &b).ok().map(|mut h| { let _ = h.bind(&reg); h });
                let ext = if host.is_some() { bound(&p, &b, &reg) } else { Vec::new() };
                progs.push(Prog { p, b, s: Vec::new(), cap: 0, host, ext });
            }
            "case" | "span" => {
                let n = |i: usize| -> i32 { f[i].parse().expect("number") };
                let pi = n(1) as usize;
                let rule = n(2);
                let (start, end, d0, i0, lb) = if f[0] == "span" { (n(3), n(4), n(5), n(6), 7) } else { (0, 0, 0, 0, 3) };
                // limits words 0..9 (word 8 the generic/schedule bits, word 9 the profile flags, D120)
                let lim: Vec<i32> = (0..10).map(|i| n(lb + i)).collect();
                let input = unhex(f[lb + 10]);
                let pr = &mut progs[pi];
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // the host protocol: cap' = max(cap, N_LEAVES); grow when short
                    let nl = if pr.p.len() > 16 { pr.p[16] } else { 0 };
                    let cap = pr.cap.max(nl);
                    let need = vm_scratch_words(&pr.p, rule, cap);
                    if cap > pr.cap || need as usize > pr.s.len() {
                        pr.s = vec![0; (need as usize).max(pr.s.len())];
                        pr.cap = cap;
                        vm_scratch_init(&mut pr.s, cap);
                    }
                    let mut o = vec![0i32; 8 + 2 * 257];
                    let ext = pr.ext.clone();
                    let preps = prepare_all(&pr.p, &pr.b, &ext);
                    let x = |id: i32, pool: &[u8], ao: i32, al: i32, b: &[u8], s: i32, e: i32, room: i32| -> i32 {
                        port(&*ext[id as usize], preps.get(&(id, ao)).map(Vec::as_slice), pool, ao, al, b, s, e, room)
                    };
                    let none = |_: i32, _: &[u8], _: i32, _: i32, _: &[u8], _: i32, _: i32, _: i32| -> i32 { -2 };
                    let xr: &dyn Fn(i32, &[u8], i32, i32, &[u8], i32, i32, i32) -> i32 =
                        if !pr.ext.is_empty() { &x } else { &none };
                    // P8.4 (D264): the canonical path's buffers, grown on -5 as the hosts grow them
                    let (mut vs, mut cb) = (vec![0i32; 64], vec![0u8; 64]);
                    let c = loop {
                        let c = if f[0] == "span" {
                            vm_validate_span_v(&pr.p, &pr.b, rule, &input, start, end, d0, i0, &lim, &mut pr.s, &mut o, xr, &mut vs, &mut cb)
                        } else {
                            vm_validate_v(&pr.p, &pr.b, rule, &input, &lim, &mut pr.s, &mut o, xr, &mut vs, &mut cb)
                        };
                        if c != -5 { break c; }
                        if o[5] as usize > vs.len() { vs = vec![0; o[5] as usize]; }
                        if o[6] as usize > cb.len() { cb = vec![0; o[6] as usize]; }
                        if o[7] as usize > pr.s.len() { pr.s.resize(o[7] as usize, 0); }
                    };
                    (c, o)
                }));
                match r {
                    Ok((c, o)) if c >= 0 => {
                        let m = 8 + 2 * o[6] as usize;
                        let words: Vec<String> = o[..m].iter().map(|x| x.to_string()).collect();
                        writeln!(out, "{}", words.join(" ")).unwrap();
                    }
                    Ok((c, _)) => writeln!(out, "ERR {}", c).unwrap(),
                    Err(_) => {
                        // a panic may leave the scratch mid-call: start the next case fresh
                        pr.s = Vec::new();
                        pr.cap = 0;
                        writeln!(out, "PANIC").unwrap()
                    }
                }
            }
            "host" => {
                let n = |i: usize| -> i32 { f[i].parse().expect("number") };
                let pr = &progs[n(1) as usize];
                let input = unhex(f[5]);
                let opts = Options { top_map: n(3) == 1, cose: n(4) == 1, ..Options::default() };
                let mut scratch = snug::schema::Scratch::new();
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &pr.host {
                    None => "UNVERIFIED".to_string(),
                    Some(h) => match validate(h, n(2), &input, &opts, &mut scratch) {
                        Ok(()) => "ok".to_string(),
                        Err(e) => {
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
