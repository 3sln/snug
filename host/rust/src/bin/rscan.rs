// `bb rscan-test`'s Rust arm. One case per stdin line:
//
//     <top_any> <cose> <max_bytes> <max_depth> <max_entries> <max_items> <max_chunk> <quantum> <seed> <hex> [<flags>]
//
// (flags: the profile flags of snug.cbor.codes, D120; absent, 0: the Bindle profile)
// Runs the RESUMABLE scanner over windows chosen exactly as the JS driver in
// kin/scripts/rscan-test.mjs chooses them (max_chunk 0 = the whole message as
// one window; otherwise each window starts at the requested offset and is
// max(need, 1 + xorshift32 % max_chunk) bytes), and prints
// `<code> <error offset> <items> <steps>`, or `PANIC`.
use snug::generated::cbor::rscan::{rscan_init, rscan_need_length, rscan_need_offset, rscan_position,
                              rscan_scratch_len, rscan_step, RS_NEED, RS_YIELD};
use snug::generated::cbor::scan::{error_offset, items_scanned, scan_options, scan_profile};
use std::io::{BufRead, Write};

fn unhex(s: &str) -> Vec<u8> {
    let v = |c: u8| -> u8 { (c as char).to_digit(16).expect("hex") as u8 };
    let b = s.as_bytes();
    (0..b.len() / 2).map(|i| (v(b[2 * i]) << 4) | v(b[2 * i + 1])).collect()
}

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
}

fn run(bytes: &[u8], opt: [i32; 6], flags: i32, max_chunk: u32, quantum: i32, seed: u32) -> (i32, i32, i32, i32) {
    let mut o = [0i32; 16];
    scan_options(&mut o, opt[0], opt[1], opt[2], opt[3], opt[4], opt[5]);
    scan_profile(&mut o, flags);
    let total = bytes.len();
    let arena = std::cmp::min(total as i64, opt[2] as i64) as i32;
    let mut s = vec![0i32; rscan_scratch_len(opt[3], arena) as usize];
    rscan_init(&mut o, &mut s, total as i32, quantum);
    let mut rng = Rng(if seed == 0 { 1 } else { seed });
    let pick = |rng: &mut Rng, base: usize, need: usize| -> usize {
        if max_chunk == 0 { return total - base; }
        let want = std::cmp::max(need, 1 + (rng.next() % max_chunk) as usize);
        std::cmp::min(want, total - base)
    };
    let mut base = 0usize;
    let mut len = pick(&mut rng, 0, 1);
    let mut steps = 0;
    loop {
        steps += 1;
        if steps > 10 * total as i32 + 1000 { return (-99, -1, -1, steps); }
        let r = rscan_step(&bytes[base..base + len], &mut o, &mut s, 0, base as i32);
        if r == RS_NEED {
            base = rscan_need_offset(&s) as usize;
            let need = rscan_need_length(&s) as usize;
            len = pick(&mut rng, base, need);
        } else if r == RS_YIELD {
            base = rscan_position(&s) as usize;
            len = pick(&mut rng, base, 1);
        } else {
            return (r, error_offset(&mut o), items_scanned(&mut o), steps);
        }
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    std::panic::set_hook(Box::new(|_| {}));
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        let f: Vec<&str> = line.split(' ').collect();
        let n = |i: usize| -> i64 { f[i].parse().expect("number") };
        let opt = [n(0) as i32, n(1) as i32, n(2) as i32, n(3) as i32, n(4) as i32, n(5) as i32];
        let (mc, q, seed) = (n(6) as u32, n(7) as i32, n(8) as u32);
        let bytes = unhex(if f.len() > 9 { f[9] } else { "" });
        let flags = if f.len() > 10 { n(10) as i32 } else { 0 };
        match std::panic::catch_unwind(|| run(&bytes, opt, flags, mc, q, seed)) {
            Ok((c, off, items, steps)) => writeln!(out, "{} {} {} {}", c, off, items, steps).unwrap(),
            Err(_) => writeln!(out, "PANIC").unwrap(),
        }
    }
}
