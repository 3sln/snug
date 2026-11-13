// `bb nav-test`'s Rust arm. Reads lines on stdin:
//
//     T <hex>      the kin navigation trace (snug.nav.trace) of the bytes
//     V <hex> <key> ...   open a View (top any), then get each text key in
//                  turn (a path) and print the raw span's hex, or `none`
//
// and prints `t <n> <words...>` / `v <hex|none|refused code>`. Any bytes are
// allowed on T lines (the fuzz arm passes unchecked bytes): the primitives must
// never panic; a panic prints PANIC.
use snug::generated::nav::trace::nav_trace;
use snug::view::View;
use std::io::{BufRead, Write};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or(0)).collect()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout());
    std::panic::set_hook(Box::new(|_| {}));
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let mut parts = line.split(' ');
        let cmd = parts.next().unwrap_or("");
        let b = unhex(parts.next().unwrap_or(""));
        let rest: Vec<String> = parts.map(|s| s.to_string()).collect();
        let r = std::panic::catch_unwind(|| match cmd {
            "T" => {
                let mut o = [0i32; 8];
                let mut d = vec![0i32; b.len() + 1];
                let mut w = vec![0i32; 64 + 16 * b.len()];
                let n = nav_trace(&b, &mut o, &mut d, &mut w);
                let mut s = format!("t {}", n);
                for x in &w[..n.max(0) as usize] {
                    s.push(' ');
                    s.push_str(&x.to_string());
                }
                s
            }
            "V" => match View::open(&b, true) {
                Err(e) => format!("v refused {}", e.0),
                Ok(mut v) => {
                    for k in &rest {
                        match v.get(k) {
                            Some(x) => v = x,
                            None => return "v none".to_string(),
                        }
                    }
                    format!("v {}", hex(v.raw()))
                }
            },
            _ => "?".to_string(),
        });
        let s = r.unwrap_or_else(|_| "PANIC".to_string());
        writeln!(out, "{}", s).unwrap();
    }
}
