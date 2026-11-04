// `bb compile-test`'s Rust arm. Reads cases on stdin, one per line:
//
//     <profile> <hex of the schema's UTF-8 text>
//
// and prints, per case, either
//
//     ok <verify result> <program words as 8-hex-digit groups> <pool hex>
//     err <code> <line> <column> <rule or ->
//
// Prefix `U ` loads the pinned Unicode module; `T <table words hex> ` passes explicit test data.
// A line `V <program words as 8-hex-digit groups> <pool hex> <mark cap>` runs
// only the verifier and prints `v <result> <detail word> <check id>`.
//
// A panic is caught per case and printed as `PANIC`: the compiler and the
// verifier must never panic on any input, and this binary is built in debug
// (overflow checks on).
use snug::compile::{compile_bytes_with_options, CompileOptions};
use snug::snug::program::verify::vm_verify;
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
                let m = cap.max(1) as usize;
                let mut s = vec![0i32; 48 + 2 * m + 16];
                s[17] = m as i32;
                let v = vm_verify(&words, &pool, &mut s);
                format!("v {} {} {}", v, s[35], s[36])
            });
            match r {
                Ok(s) => writeln!(out, "{}", s).unwrap(),
                Err(_) => writeln!(out, "PANIC").unwrap(),
            }
            continue;
        }
        let (line, regexp) = if let Some(rest) = line.strip_prefix("I ") {
            (rest, snug::compile::Regexp::IRegexp)
        } else { (line.as_str(), snug::compile::Regexp::Xsd) };
        let (line, tables) = if let Some(rest) = line.strip_prefix("T ") {
            let (words, rest) = rest.split_once(' ').unwrap_or(("", rest));
            let table = (0..words.len() / 8)
                .map(|i| u32::from_str_radix(&words[8 * i..8 * i + 8], 16).unwrap_or(0) as i32)
                .collect::<Vec<_>>();
            (rest, Some(table))
        } else if let Some(rest) = line.strip_prefix("U ") {
            (rest, Some(snug::unicode_tables::tables()))
        } else { (line, None) };
        let mut f = line.split(' ');
        let profile: i32 = f.next().unwrap_or("0").parse().unwrap_or(0);
        let text = unhex(f.next().unwrap_or(""));
        let limits: Vec<i32> = f.map(|x| x.parse().unwrap_or(-1)).collect();
        let r = std::panic::catch_unwind(|| match compile_bytes_with_options(&text, &CompileOptions { profile, limits: &limits, unicode: tables.as_deref(), controls: None, regexp }) {
            Ok(c) => {
                let m = (c.program.get(16).copied().unwrap_or(1)).max(1) as usize;
                let mut s = vec![0i32; 48 + 2 * m + 16];
                s[17] = m as i32;
                let v = vm_verify(&c.program, &c.pool, &mut s);
                let mut o = String::with_capacity(c.program.len() * 8 + c.pool.len() * 2 + 16);
                let _ = write!(o, "ok {} ", v);
                for w in &c.program {
                    let _ = write!(o, "{:08x}", *w as u32);
                }
                o.push(' ');
                for b in &c.pool {
                    let _ = write!(o, "{:02x}", b);
                }
                o
            }
            Err(e) => format!("err {} {} {} {}", e.code, e.line, e.column, e.rule.unwrap_or_else(|| "-".into())),
        });
        match r {
            Ok(s) => writeln!(out, "{}", s).unwrap(),
            Err(_) => writeln!(out, "PANIC").unwrap(),
        }
    }
}
