// `bb write-test`'s Rust arm. Reads lines on stdin and prints one line each:
//
//     H at cap major hi lo        put-head into a zeroed buffer of cap bytes
//                                 -> `h <answer> <hex of the buffer>`
//     F at cap hi lo              float-width and put-float -> `f <width> <answer> <hex>`
//     I at cap neg <hexmag>       int-len and put-int -> `i <len> <answer> <hex>`
//     K <hex> ps pe ks ke         key-after -> `k <answer>`
//     M <hex> mend tmpcap xcap budget <ks ke>...   close-map over the pair table
//                                 -> `m <answer> <compares> <hex of the buffer>`
//     S <hex> xb xcap budget <ks ke>...   sort-keys over key spans in the bytes
//                                 -> `s <answer> <compares> <x[xb..xb+n)>`
//     W <op>...                   a Rust Writer driven by ops -> `w <hex>` or `w fail <code>`
//
// Writer ops: aN beginArray, mN beginMap, e end, k<hex utf8> key, t<hex utf8> text,
// b<hex> bytes, p<hexmag> / q<hexmag> integer (argument magnitude; q negative),
// f<hi>,<lo> float bits, T true, F false, N null, S (keysSorted, first op only).
// A panic prints PANIC.
use snug::snug::write::float::{float_width, float_width_rfc, put_float, put_float_rfc};
use snug::snug::write::int::{int_len, put_int};
use snug::snug::write::map::{close_map, sort_keys, S_BUDGET, S_COMPARES};
use snug::snug::write::out::{key_after, put_head};
use snug::writer::{Fault, Writer};
use std::io::{BufRead, Write};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or(0)).collect()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
fn num(s: Option<&str>) -> i32 {
    s.and_then(|x| x.parse::<i64>().ok()).map_or(0, |v| v as i32)
}

fn writer(ops: &[&str]) -> Result<Vec<u8>, Fault> {
    let sorted = ops.first() == Some(&"S");
    let mut w = Writer::new(sorted);
    for op in ops.iter().skip(if sorted { 1 } else { 0 }) {
        let (c, rest) = op.split_at(1);
        match c {
            "a" => w.begin_array(rest.parse().unwrap_or(0))?,
            "m" => w.begin_map(rest.parse().unwrap_or(0))?,
            "e" => w.end()?,
            "k" => w.key(&String::from_utf8(unhex(rest)).unwrap_or_default())?,
            "t" => w.text(&String::from_utf8(unhex(rest)).unwrap_or_default())?,
            "b" => w.bytes(&unhex(rest))?,
            "p" => w.int(false, &unhex(rest))?,
            "q" => w.int(true, &unhex(rest))?,
            "f" => {
                let mut it = rest.split(',');
                let hi = num(it.next());
                let lo = num(it.next());
                w.float_bits(hi, lo)?
            }
            "T" => w.bool(true)?,
            "F" => w.bool(false)?,
            "N" => w.null()?,
            _ => return Err(Fault("bad-op")),
        }
    }
    w.finish()
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout());
    std::panic::set_hook(Box::new(|_| {}));
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let parts: Vec<&str> = line.split(' ').collect();
        let r = std::panic::catch_unwind(|| match parts[0] {
            "H" => {
                let mut b = vec![0u8; num(parts.get(2).copied()).max(0) as usize];
                let a = put_head(&mut b, num(parts.get(1).copied()), num(parts.get(3).copied()), num(parts.get(4).copied()), num(parts.get(5).copied()));
                format!("h {} {}", a, hex(&b))
            }
            "F" => {
                let mut b = vec![0u8; num(parts.get(2).copied()).max(0) as usize];
                let (hi, lo) = (num(parts.get(3).copied()), num(parts.get(4).copied()));
                let w = float_width(hi, lo);
                let a = put_float(&mut b, num(parts.get(1).copied()), hi, lo);
                format!("f {} {} {}", w, a, hex(&b))
            }
            "R" => {
                let mut b = vec![0u8; num(parts.get(2).copied()).max(0) as usize];
                let (hi, lo) = (num(parts.get(3).copied()), num(parts.get(4).copied()));
                let w = float_width_rfc(hi, lo);
                let a = put_float_rfc(&mut b, num(parts.get(1).copied()), hi, lo);
                format!("r {} {} {}", w, a, hex(&b))
            }
            "I" => {
                let mut b = vec![0u8; num(parts.get(2).copied()).max(0) as usize];
                let neg = num(parts.get(3).copied());
                let m = unhex(parts.get(4).copied().unwrap_or(""));
                let l = int_len(&m, 0, m.len() as i32);
                let a = put_int(&mut b, num(parts.get(1).copied()), neg, &m, 0, m.len() as i32);
                format!("i {} {} {}", l, a, hex(&b))
            }
            "K" => {
                let b = unhex(parts.get(1).copied().unwrap_or(""));
                let a = key_after(&b, num(parts.get(2).copied()), num(parts.get(3).copied()), num(parts.get(4).copied()), num(parts.get(5).copied()));
                format!("k {}", a)
            }
            "M" => {
                let mut b = unhex(parts.get(1).copied().unwrap_or(""));
                let mend = num(parts.get(2).copied());
                let mut tmp = vec![0u8; num(parts.get(3).copied()).max(0) as usize];
                let mut x = vec![0i32; num(parts.get(4).copied()).max(0) as usize];
                let mut s = [0i32; 4];
                s[S_BUDGET as usize] = num(parts.get(5).copied());
                let t: Vec<i32> = parts[6..].iter().map(|p| num(Some(p))).collect();
                let n = (t.len() / 2) as i32;
                let a = close_map(&mut b, &t, 0, n, mend, &mut tmp, &mut x, &mut s);
                format!("m {} {} {}", a, s[S_COMPARES as usize], hex(&b))
            }
            "S" => {
                let b = unhex(parts.get(1).copied().unwrap_or(""));
                let xb = num(parts.get(2).copied());
                let mut x = vec![0i32; num(parts.get(3).copied()).max(0) as usize];
                let mut s = [0i32; 4];
                s[S_BUDGET as usize] = num(parts.get(4).copied());
                let t: Vec<i32> = parts[5..].iter().map(|p| num(Some(p))).collect();
                let n = (t.len() / 2) as i32;
                let a = sort_keys(&b, &t, 0, n, &mut x, xb, &mut s);
                let mut out = format!("s {} {}", a, s[S_COMPARES as usize]);
                if a == 0 {
                    for k in 0..n {
                        out.push_str(&format!(" {}", x[(xb + k) as usize]));
                    }
                }
                out
            }
            "W" => match writer(&parts[1..]) {
                Ok(b) => format!("w {}", hex(&b)),
                Err(Fault(code)) => format!("w fail {}", code),
            },
            _ => "?".to_string(),
        });
        let s = r.unwrap_or_else(|_| "PANIC".to_string());
        writeln!(out, "{}", s).unwrap();
    }
}
