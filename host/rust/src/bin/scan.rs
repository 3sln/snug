// `bb scan-test`'s Rust arm. Reads cases on stdin, one per line:
//
//     <top_any> <cose> <max_bytes> <max_depth> <max_entries> <max_items> <hex> [<profile flags>]
//
// (the flags are snug.cbor.codes PF_*, D120; absent, 0: the Bindle profile).
// and prints `<code> <error offset>` per case. A panic is caught per case and
// printed as `PANIC` -- the scanner must never panic on any input, and this
// binary is built in debug (overflow checks on) so a broken arithmetic
// guarantee is a panic here rather than a silent wrap.
use snug::snug::cbor::scan::{error_offset, scan_cb, scan_options, scan_profile};
use std::io::{BufRead, Write};

fn unhex(s: &str) -> Vec<u8> {
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

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    std::panic::set_hook(Box::new(|_| {}));
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        let f: Vec<&str> = line.split(' ').collect();
        let n = |i: usize| -> i32 { f[i].parse().expect("number") };
        let (top, cose, mb, md, me, mi) = (n(0), n(1), n(2), n(3), n(4), n(5));
        let bytes = unhex(if f.len() > 6 { f[6] } else { "" });
        let flags = if f.len() > 7 { n(7) } else { 0 };
        let r = std::panic::catch_unwind(|| {
            // The walk's scratch past the 16 frozen words and a canonical buffer (P8.4, D264),
            // grown on CODE_SCRATCH (22) as the hosts grow them.
            let (mut w, mut nb) = (16 + 64usize, 64usize);
            loop {
                let mut o = vec![0i32; w];
                let mut cb = vec![0u8; nb];
                scan_options(&mut o, top, cose, mb, md, me, mi);
                scan_profile(&mut o, flags);
                let c = scan_cb(&bytes, &mut o, &mut cb);
                if c != 22 {
                    return (c, error_offset(&mut o));
                }
                w = (o[13] as usize).max(2 * w);
                nb = (o[14] as usize).max(2 * nb);
            }
        });
        match r {
            Ok((c, off)) => writeln!(out, "{} {}", c, off).unwrap(),
            Err(_) => writeln!(out, "PANIC").unwrap(),
        }
    }
}
