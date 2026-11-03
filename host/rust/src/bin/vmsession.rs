// `bb vmsession-test`'s Rust arm (P6.2): the resumable session over windows
// chosen by the same deterministic policy as kin/scripts/vmsession-run.mjs.
// Reads lines on stdin:
//
//     prog <words, comma-separated decimal> <pool hex or ->
//     case <prog index> <rule> <l0> .. <l8> <kind> <w> <q> <seed> <k> <input hex or ->
//
// and prints, per case, `out[0..8+2*out[6]]` space-separated, `E <why>` for a
// broken session contract, or `PANIC` (caught per case; the crate is built in
// debug, overflow checks on). Every session owns fresh scratch, session array
// and key arena.
use snug::snug::vm::api::{vm_scratch_init, vm_scratch_words};
use snug::snug::vm::session::{vms_arena, vms_init, vms_need_length, vms_need_offset, vms_position, vms_step, vms_words};
use std::io::{BufRead, Write};

const VMS_NEED: i32 = -64;
const VMS_YIELD: i32 = -65;

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
    let mut out = vec![0i32; 8 + 2 * 257];
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
        let r = vms_step(p, pool, &win, &mut s, &mut ss, &mut ka, &mut out, off);
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
                let lim: Vec<i32> = (0..9).map(|i| n(3 + i)).collect();
                let pol = Policy { kind: n(12), w: n(13), q: n(14), seed: f[15].parse().expect("seed"), k: n(16) };
                let input = unhex(f[17]);
                let (p, pool) = &progs[pi];
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(p, pool, rule, &lim, &input, &pol)));
                match r {
                    Ok(t) => writeln!(out, "{}", t).unwrap(),
                    Err(_) => writeln!(out, "PANIC").unwrap(),
                }
            }
            _ => panic!("bad line"),
        }
    }
}
