// Measurement-only companion to calibrate.mjs. Compiled in scratch against
// clean generated sources; no host/gen edits. Native thread CPU, no IPC/setup
// in timed regions. macOS and Linux clock IDs come from their system headers.
mod controls;
mod snug;
use controls::{port, prepare_all, program_controls, Control, Controls};
use std::{collections::BTreeMap, sync::Arc};
struct Pass;
impl Control for Pass {
    fn check(&self, _: &[u8], _: &[u8]) -> bool {
        true
    }
    fn cost(&self, _: u32) -> u64 {
        0
    }
}
struct Declared;
impl Control for Declared {
    fn check(&self, _: &[u8], b: &[u8]) -> bool {
        let mut h = 0i32;
        for x in b {
            h = h.wrapping_mul(33) ^ (*x as i32);
        }
        black_box(h) != 123456789
    }
}
struct Costly;
impl Control for Costly {
    fn check(&self, _: &[u8], b: &[u8]) -> bool {
        b.len() % 3 != 0
    }
    fn max_bytes(&self) -> u32 {
        1000
    }
    fn cost(&self, n: u32) -> u64 {
        3 * u64::from(n) + 5
    }
}
struct Huge;
impl Control for Huge {
    fn check(&self, _: &[u8], _: &[u8]) -> bool {
        panic!("must not run")
    }
    fn cost(&self, _: u32) -> u64 {
        1_000_000_000
    }
}
use snug::vm::{api::*, controls as k};
use std::{
    hint::black_box,
    io::{BufRead, Write},
};
#[repr(C)]
struct Timespec {
    sec: i64,
    ns: i64,
}
unsafe extern "C" {
    fn clock_gettime(id: i32, t: *mut Timespec) -> i32;
}
fn cpu() -> u64 {
    let mut t = Timespec { sec: 0, ns: 0 };
    let id = if cfg!(target_os = "macos") { 16 } else { 3 };
    assert_eq!(unsafe { clock_gettime(id, &mut t) }, 0);
    t.sec as u64 * 1_000_000_000 + t.ns as u64
}
fn bytes(s: &str) -> Vec<u8> {
    if s == "-" {
        return vec![];
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn words(s: &str) -> Vec<i32> {
    if s == "-" {
        vec![]
    } else {
        s.split(',').map(|x| x.parse().unwrap()).collect()
    }
}
struct Row {
    mode: String,
    budget: i32,
    rule: i32,
    flags: i32,
    p: Vec<i32>,
    a: Vec<u8>,
    b: Vec<u8>,
    seed: Vec<i32>,
    s: Vec<i32>,
    t: Vec<i32>,
    o: Vec<i32>,
    ext: Vec<Arc<dyn Control>>,
    preps: BTreeMap<(i32, i32), Vec<i32>>,
}
impl Row {
    fn new(f: &[&str]) -> Self {
        let mut r = Self {
            mode: f[1].into(),
            budget: f[2].parse().unwrap(),
            rule: f[3].parse().unwrap(),
            flags: f[4].parse().unwrap(),
            p: words(f[5]),
            a: bytes(f[6]),
            b: bytes(f[7]),
            seed: words(f[8]),
            s: vec![],
            t: vec![],
            o: vec![0; 600],
            ext: vec![],
            preps: BTreeMap::new(),
        };
        if r.mode == "vm" {
            r.s = vec![0; vm_scratch_words(&r.p, r.rule, r.p[16]) as usize];
            vm_scratch_init(&mut r.s, r.p[16]);
            let reg = Controls::generic()
                .with("pass", Pass)
                .with("declared", Declared)
                .with("costly", Costly)
                .with("huge", Huge);
            r.ext = program_controls(&r.p, &r.a)
                .iter()
                .map(|n| reg.get(n).unwrap().clone())
                .collect();
            r.preps = prepare_all(&r.p, &r.a, &r.ext);
        } else {
            r.s = vec![
                0;
                (k::unique_words(&r.b, 0, r.b.len() as i32) as usize).max(r.seed.len() + 2)
            ];
            r.t = vec![
                0;
                if r.mode == "chars" {
                    2
                } else {
                    k::samelen_words(&r.a, 0, r.a.len() as i32) as usize
                }
            ];
            if r.mode == "chars" {
                assert_eq!(k::chars_prep(&r.a, 0, r.a.len() as i32, &mut r.t), 0);
            }
            if r.mode == "samelen" || r.mode == "named" {
                assert_eq!(k::samelen_prep(&r.a, 0, r.a.len() as i32, &mut r.t), 0);
            }
        }
        r
    }
    fn run(&mut self) -> [i32; 2] {
        let b = black_box(&self.b);
        let e = b.len() as i32;
        if self.mode == "vm" {
            let lim = [1, 0, -1, -1, -1, -1, -1, self.budget, self.flags, 122];
            let ext = |id: i32,
                       pool: &[u8],
                       ao: i32,
                       al: i32,
                       b: &[u8],
                       s: i32,
                       e: i32,
                       room: i32|
             -> i32 {
                port(
                    &*self.ext[id as usize],
                    self.preps.get(&(id, ao)).map(Vec::as_slice),
                    pool,
                    ao,
                    al,
                    b,
                    s,
                    e,
                    room,
                )
            };
            // program-2 §9.4 (D313): an A2/T row grows its group arena on -5, as the hosts do
            loop {
                let r = vm_validate_x(
                    black_box(&self.p),
                    black_box(&self.a),
                    self.rule,
                    b,
                    &lim,
                    &mut self.s,
                    &mut self.o,
                    &ext,
                );
                if r != -5 {
                    break;
                }
                self.s = vec![0; self.o[7] as usize];
                vm_scratch_init(&mut self.s, self.p[16]);
            }
            return [self.o[0], self.o[3]];
        }
        k::meter_init(&mut self.s, self.budget);
        self.s[2..2 + self.seed.len()].copy_from_slice(&self.seed);
        let mut result = 0;
        let mode = match self.mode.as_str() {
            "chars" => 0,
            "unique" => 1,
            "samelen" => 2,
            "heads" => 3,
            "compare" => 4,
            "bytes" => 5,
            "named" => 6,
            _ => panic!("mode"),
        };
        for calls in 0..10_000_000 {
            result = match mode {
                0 => k::chars_run(&self.t, b, 0, e, &mut self.s),
                1 => k::unique_run(b, 0, e, &mut self.s),
                2 => k::samelen_run(&self.a, 0, &self.t, b, 0, e, &mut self.s),
                3 => k::mskip(b, 0, e, &mut self.s),
                4 => k::rec_cmp(b, &mut self.s, 0, 1),
                5 => k::mcmp(
                    b,
                    0,
                    e,
                    black_box(&self.a),
                    0,
                    self.a.len() as i32,
                    &mut self.s,
                ),
                6 => k::named(&self.a, 0, &self.t, b, 0, e, &mut self.s),
                _ => panic!("mode"),
            };
            if (mode == 3 && result == -2)
                || ((mode == 4 || mode == 5) && result == i32::MAX)
                || (!matches!(mode, 3 | 4 | 5) && result == -1)
            {
                break;
            }
            assert!(calls < 9_999_999);
        }
        [result, (self.s[0] + 7) / 8]
    }
    fn batch(&mut self, n: usize) -> f64 {
        let t = cpu();
        for _ in 0..n {
            black_box(self.run());
        }
        (cpu() - t) as f64 / n as f64
    }
}
fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout());
    let mut rows: Vec<Row> = vec![];
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let f: Vec<&str> = line.split(' ').collect();
        match f[0] {
            "add" => {
                let mut r = Row::new(&f);
                let a = r.run();
                rows.push(r);
                writeln!(out, "[{},{}]", a[0], a[1]).unwrap();
            }
            "warm" => {
                let r = &mut rows[f[1].parse::<usize>().unwrap()];
                let mut n = 1;
                let mut sum = 0f64;
                while sum < 60_000_000. {
                    let ns = r.batch(n);
                    sum += ns * n as f64;
                    n = (22_000_000. / ns.max(1.)).ceil().clamp(1., 100000.) as usize;
                }
                writeln!(out, "{n}").unwrap();
            }
            "time" => {
                let ns = rows[f[1].parse::<usize>().unwrap()].batch(f[2].parse().unwrap());
                writeln!(out, "{ns}").unwrap();
            }
            _ => panic!("command"),
        }
        out.flush().unwrap();
    }
}
