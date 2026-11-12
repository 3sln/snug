// P9.14 (D334): the ABNF engine (`snug::snug::abnf`, generated from kin/abnf.kin) on
// a debug Rust build, for `bb abnf-test`: the gate compares every answer with the
// generated JS. A test host, not documented as a crate (P9.16: plain comments, as the
// other test-host binaries, so `cargo doc` stays quiet). Lines on stdin:
//
//   P <parse mode> <controller hex>    prepare (the CBOR encoding of a text/byte string;
//                                      parse mode 0 strict, 1 lenient, D340)
//                                      -> "P <status> <line> <column> <table words>"
//   R <mode> <item hex> <room> <first> <cap>
//                                      run the last prepared table over the item, with a
//                                      first scratch of <first> words (0: the default) and
//                                      scratch cap <cap> (-1: the default), grown to
//                                      `abnf_more` -> "R <verdict word> <reruns>"
use snug::snug::abnf::{abnf_error_column, abnf_error_line, abnf_more, abnf_prep, abnf_run, abnf_scratch_words,
                       abnf_table_words, abnf_words, ABNF_MAX_WORDS};
use std::io::{BufRead, Write};

fn unhex(s: &str) -> Vec<u8> {
    if s == "-" {
        return Vec::new();
    }
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout());
    let mut t: Vec<i32> = Vec::new();
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let f: Vec<&str> = line.split(' ').collect();
        match f[0] {
            "P" => {
                let pmode: i32 = f[1].parse().unwrap();
                let a = unhex(f[2]);
                let mut tt = vec![0; abnf_words(a.len() as i32) as usize];
                let st = abnf_prep(&a, 0, a.len() as i32, &mut tt, pmode);
                let used = abnf_table_words(&tt);
                writeln!(out, "P {} {} {} {}", st, abnf_error_line(&tt), abnf_error_column(&tt), if st == 0 { used } else { 0 }).unwrap();
                tt.truncate(used as usize);
                t = if st == 0 { tt } else { Vec::new() };
            }
            "R" => {
                let mode: i32 = f[1].parse().unwrap();
                let b = unhex(f[2]);
                let room: i32 = f[3].parse().unwrap();
                let first: usize = f[4].parse().unwrap();
                let cap: i32 = f[5].parse().unwrap();
                let mut reruns = 0;
                let mut r = -2;
                if !t.is_empty() {
                    let mut m = vec![0; if first > 0 { first } else { abnf_scratch_words(&t, b.len() as i32, cap) as usize }];
                    loop {
                        r = abnf_run(&t, mode, &b, 0, b.len() as i32, &mut m, room, cap);
                        let more = abnf_more(&m) as usize;
                        if r == -1 && more > m.len() {
                            assert!(more <= ABNF_MAX_WORDS as usize && more >= 2 * m.len());
                            m.resize(more, 0);
                            reruns += 1;
                            continue;
                        }
                        break;
                    }
                }
                writeln!(out, "R {} {}", r, reruns).unwrap();
            }
            _ => panic!("abnf: bad line {}", line),
        }
    }
}
