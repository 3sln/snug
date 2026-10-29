// `bb vm-test`'s Rust arm. Reads lines on stdin:
//
//     prog <words, comma-separated decimal> <pool hex or ->
//     case <prog index> <rule> <l0> .. <l7> <input hex or ->
//     span <prog index> <rule> <start> <end> <depth0> <items0> <l0> .. <l7> <input hex or ->
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
use snug::snug::vm::api::{vm_scratch_init, vm_scratch_words, vm_validate, vm_validate_span};
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
                let host = Program::new(&p, &b).ok();
                progs.push(Prog { p, b, s: Vec::new(), cap: 0, host });
            }
            "case" | "span" => {
                let n = |i: usize| -> i32 { f[i].parse().expect("number") };
                let pi = n(1) as usize;
                let rule = n(2);
                let (start, end, d0, i0, lb) = if f[0] == "span" { (n(3), n(4), n(5), n(6), 7) } else { (0, 0, 0, 0, 3) };
                let lim: Vec<i32> = (0..8).map(|i| n(lb + i)).collect();
                let input = unhex(f[lb + 8]);
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
                    let c = if f[0] == "span" {
                        vm_validate_span(&pr.p, &pr.b, rule, &input, start, end, d0, i0, &lim, &mut pr.s, &mut o)
                    } else {
                        vm_validate(&pr.p, &pr.b, rule, &input, &lim, &mut pr.s, &mut o)
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
