// `bb compile2-test`'s Rust arm (format 2.0, P8.5 phase 1). Reads cases on
// stdin, one per line:
//
//     C <profile> <cuts 0|1> <groupWords or -1> <hex of the schema's UTF-8 text>
//
// and prints, per case, either
//
//     ok <verify result> <program words as 8-hex-digit groups> <pool hex> <warnings>
//     err <code> <line> <column> <rule or ->
//
// where <warnings> is `-` or `;`-joined `code,line,column,rule-hex`. A line
// `V <program words> <pool hex> <mark cap>` runs only the verifier (scratch
// sized by vm-verify-words) and prints `v <result> <detail word> <check id>`.
//
// A panic is caught per case and printed as `PANIC`: the compiler and the
// verifier must never panic on any input; the binary is built in debug
// (overflow checks on).
use snug::compile::{compile_bytes_with_options, CompileOptions, Cuts};
use snug::snug::program::verify::{vm_verify, vm_verify_words};
use std::fmt::Write as _;
use std::io::{BufRead, Write};

fn unhex(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let v = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => 0,
        }
    };
    (0..b.len() / 2).map(|i| (v(b[2 * i]) << 4) | v(b[2 * i + 1])).collect()
}

fn verify(words: &[i32], pool: &[u8], cap: i32) -> (i32, i32, i32) {
    // M = max(cap, N_LEAVES clamped to 2^20, 1); S sized by vm-verify-words (the JS arm does the same).
    let nl = if words.len() > 16 { words[16].clamp(0, 1 << 20) } else { 0 };
    let m = cap.max(nl).max(1);
    let mut s = vec![0i32; vm_verify_words(words, m).max(48) as usize + 16];
    s[16] = 1;
    s[17] = m;
    let v = vm_verify(words, pool, &mut s);
    (v, s[35], s[36])
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    if std::env::var_os("SNUG_LOUD").is_none() {
        std::panic::set_hook(Box::new(|_| {}));
    }
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        if let Some(rest) = line.strip_prefix("V ") {
            let mut g = rest.split(' ');
            let wh = g.next().unwrap_or("");
            let words: Vec<i32> = (0..wh.len() / 8)
                .map(|i| u32::from_str_radix(&wh[8 * i..8 * i + 8], 16).unwrap_or(0) as i32)
                .collect();
            let pool = unhex(g.next().unwrap_or(""));
            let cap: i32 = g.next().unwrap_or("1").parse().unwrap_or(1);
            let r = std::panic::catch_unwind(|| {
                let (v, d, c) = verify(&words, &pool, cap);
                format!("v {} {} {}", v, d, c)
            });
            match r {
                Ok(s) => writeln!(out, "{}", s).unwrap(),
                Err(_) => writeln!(out, "PANIC").unwrap(),
            }
            continue;
        }
        let rest = line.strip_prefix("C ").unwrap_or(&line);
        let mut f = rest.split(' ');
        let profile: i32 = f.next().unwrap_or("0").parse().unwrap_or(0);
        let cuts: i32 = f.next().unwrap_or("0").parse().unwrap_or(0);
        let gw: i32 = f.next().unwrap_or("-1").parse().unwrap_or(-1);
        let text = unhex(f.next().unwrap_or(""));
        let r = std::panic::catch_unwind(|| {
            let options = CompileOptions {
                profile,
                cuts: if cuts == 1 { Cuts::Rfc } else { Cuts::Reference },
                group_words: if gw >= 0 { Some(gw) } else { None },
                ..Default::default()
            };
            match compile_bytes_with_options(&text, &options) {
                Ok(c) => {
                    let (v, _, _) = verify(&c.program, &c.pool, c.program.get(16).copied().unwrap_or(1));
                    let mut o = String::with_capacity(c.program.len() * 8 + c.pool.len() * 2 + 32);
                    let _ = write!(o, "ok {} ", v);
                    for w in &c.program {
                        let _ = write!(o, "{:08x}", *w as u32);
                    }
                    o.push(' ');
                    for b in &c.pool {
                        let _ = write!(o, "{:02x}", b);
                    }
                    o.push(' ');
                    if c.warnings.is_empty() {
                        o.push('-');
                    }
                    for (i, w) in c.warnings.iter().enumerate() {
                        if i > 0 {
                            o.push(';');
                        }
                        let _ = write!(o, "{},{},{},", w.code, w.line, w.column);
                        match &w.rule {
                            Some(r) => {
                                for b in r.as_bytes() {
                                    let _ = write!(o, "{:02x}", b);
                                }
                            }
                            None => o.push('-'),
                        }
                    }
                    o
                }
                Err(e) => format!("err {} {} {} {}", e.code, e.line, e.column, e.rule.unwrap_or_else(|| "-".into())),
            }
        });
        match r {
            Ok(s) => writeln!(out, "{}", s).unwrap(),
            Err(_) => writeln!(out, "PANIC").unwrap(),
        }
    }
}
