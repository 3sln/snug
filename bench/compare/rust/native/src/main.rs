//! P7.8 part 3: snug's generated Rust (scanner and VM, through the host crate) vs ciborium, minicbor, serde_cbor and
//! cbor4ii on the same bytes, and vs the `cddl` crate (native) for CDDL validation.
//!
//!     snug-compare <cases dir> [rounds] [target ms]
//!
//! The cases dir is written by `node bench/compare/cddl-cases.mjs <dir>` (run-rust.sh does both). Method: this
//! thread's CPU time (clock_gettime(CLOCK_THREAD_CPUTIME_ID)); 3 warm-up calls; each op calibrated to >= target ms;
//! `rounds` rounds over a row's ops in rotating order; medians per call; inputs and results through
//! std::hint::black_box. Answers are checked outside timing: every decoder must accept and yield the same number of
//! data items (tags not counted; serde-based Value types cannot carry them); every validator's verdict is compared
//! with the expected one.
use std::hint::black_box;
use std::time::Duration;

use cddl::ast::{Rule, CDDL};
use cddl::validator::cbor::{self as cddl_cbor, CBORValidator};
use cddl::validator::cbor_value::decode_cbor;
use cddl::validator::Validator;
use snug::compile::compile;
use snug::schema::{validate, Options, Program, Scratch};
use snug::snug::cbor::scan::{scan, scan_options};

#[repr(C)]
struct Timespec { sec: i64, nsec: i64 }
extern "C" { fn clock_gettime(clk: u32, tp: *mut Timespec) -> i32; }
#[cfg(target_os = "macos")]
const CLOCK_THREAD_CPUTIME_ID: u32 = 16;
#[cfg(not(target_os = "macos"))]
const CLOCK_THREAD_CPUTIME_ID: u32 = 3;
fn cpu() -> Duration {
    let mut t = Timespec { sec: 0, nsec: 0 };
    unsafe { clock_gettime(CLOCK_THREAD_CPUTIME_ID, &mut t) };
    Duration::new(t.sec as u64, t.nsec as u32)
}

struct Case { id: String, schema: String, rule: String, valid: bool, top_any: bool, cose: bool, max_bytes: i32, max_entries: i32, max_items: i32, items: Vec<Vec<u8>> }

fn load(dir: &str) -> Vec<Case> {
    let m = std::fs::read_to_string(format!("{dir}/manifest.txt")).expect("manifest");
    m.lines().filter(|l| !l.is_empty()).map(|l| {
        let f: Vec<&str> = l.split(' ').collect();
        let raw = std::fs::read(format!("{dir}/{}", f[9])).expect("case file");
        let mut items = Vec::new();
        let mut p = 0;
        while p < raw.len() { let n = u32::from_le_bytes([raw[p], raw[p + 1], raw[p + 2], raw[p + 3]]) as usize; items.push(raw[p + 4..p + 4 + n].to_vec()); p += 4 + n; }
        Case { id: f[0].into(), schema: f[1].into(), rule: f[2].into(), valid: f[3] == "1", top_any: f[4] == "1", cose: f[5] == "1",
               max_bytes: f[6].parse().unwrap(), max_entries: f[7].parse().unwrap(), max_items: f[8].parse().unwrap(), items }
    }).collect()
}

// ---------------------------------------------------------------- data-item counts (answers check)
fn n_ciborium(v: &ciborium::Value) -> usize {
    use ciborium::Value::*;
    match v { Array(a) => 1 + a.iter().map(n_ciborium).sum::<usize>(), Map(m) => 1 + m.iter().map(|(k, x)| n_ciborium(k) + n_ciborium(x)).sum::<usize>(), Tag(_, x) => n_ciborium(x), _ => 1 }
}
fn n_serde_cbor(v: &serde_cbor::Value) -> usize {
    use serde_cbor::Value::*;
    match v { Array(a) => 1 + a.iter().map(n_serde_cbor).sum::<usize>(), Map(m) => 1 + m.iter().map(|(k, x)| n_serde_cbor(k) + n_serde_cbor(x)).sum::<usize>(), Tag(_, x) => n_serde_cbor(x), _ => 1 }
}
fn n_cbor4ii(v: &cbor4ii::core::Value) -> usize {
    use cbor4ii::core::Value::*;
    match v { Array(a) => 1 + a.iter().map(n_cbor4ii).sum::<usize>(), Map(m) => 1 + m.iter().map(|(k, x)| n_cbor4ii(k) + n_cbor4ii(x)).sum::<usize>(), Tag(_, x) => n_cbor4ii(x), _ => 1 }
}
fn n_minicbor(b: &[u8]) -> Result<usize, String> {
    let mut d = minicbor::Decoder::new(b);
    let mut n = 0;
    for t in d.tokens() { match t.map_err(|e| e.to_string())? { minicbor::data::Token::Tag(_) => {}, _ => n += 1 } }
    Ok(n)
}

// ---------------------------------------------------------------- timing
type Op<'a> = (String, Box<dyn FnMut() -> usize + 'a>);
fn bench(ops: &mut [Op], rounds: usize, target: Duration) -> Vec<(f64, f64, u64)> {
    for (_, f) in ops.iter_mut() { for _ in 0..3 { black_box(f()); } }
    let iters: Vec<u64> = ops.iter_mut().map(|(_, f)| {
        let mut n = 1u64;
        loop {
            let t = cpu(); for _ in 0..n { black_box(f()); } let d = cpu() - t;
            if d >= target || n >= 1 << 26 { return n; }
            n = if d < Duration::from_micros(500) { n * 8 } else { (n + 1).max((n as f64 * target.as_secs_f64() * 1.1 / d.as_secs_f64()).ceil() as u64) };
        }
    }).collect();
    let mut samples = vec![Vec::new(); ops.len()];
    for r in 0..rounds { for o in 0..ops.len() {
        let k = (r + o) % ops.len(); let n = iters[k]; let f = &mut ops[k].1;
        let t = cpu(); for _ in 0..n { black_box(f()); } samples[k].push((cpu() - t).as_secs_f64() * 1e3 / n as f64);
    } }
    samples.iter_mut().zip(iters).map(|(s, n)| { s.sort_by(|a, b| a.partial_cmp(b).unwrap()); (s[s.len() / 2], s[0], n) }).collect()
}
fn fmt(ms: f64) -> String {
    if ms >= 100.0 { format!("{ms:.0} ms") } else if ms >= 1.0 { format!("{ms:.2} ms") } else if ms >= 0.01 { format!("{:.0} µs", ms * 1e3) } else if ms >= 0.001 { format!("{:.1} µs", ms * 1e3) } else { format!("{:.0} ns", ms * 1e6) }
}

fn opts(c: &Case) -> Options {
    let l = |v: i32| if v < 0 { None } else { Some(v) };
    Options { top_map: !c.top_any, cose: c.cose, max_bytes: l(c.max_bytes), max_entries: l(c.max_entries), max_items: l(c.max_items), ..Default::default() }
}
const BIG: [i32; 17] = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1 << 24, 1 << 24, -1, i32::MAX];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.get(1).expect("usage: snug-compare <cases dir> [rounds] [target ms]");
    let rounds: usize = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(9);
    let target = Duration::from_millis(args.get(3).map(|s| s.parse().unwrap()).unwrap_or(25));
    let cases = load(dir);
    println!("{{\"rounds\":{rounds},\"targetMs\":{},\"timing\":\"thread CPU\"}}", target.as_millis());

    // ------------------------------------------------ 1. decode / validate the codec workloads' bytes
    println!("\n# codec: per call (a sequence row is the whole batch of separate messages)\n");
    println!("| workload | bytes | snug scan (strict) | snug VM vs `any` | minicbor skip | minicbor tokens | ciborium Value | serde_cbor Value | cbor4ii Value | cddl crate decode_cbor |");
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    let any = compile("r = any", 0, &BIG).expect("compile any");
    let any = Program::new(&any.program, &any.pool).expect("verify");
    let mut scratch = Scratch::new();
    let mut notes = Vec::new();
    for c in cases.iter().filter(|c| c.id.starts_with("workload:")) {
        let o = opts(c);
        let mut so = [0i32; 16];
        let lim = |v: i32, d: i32| if v < 0 { d } else { v };
        scan_options(&mut so, c.top_any as i32, c.cose as i32, lim(c.max_bytes, 1_500_000), 32, lim(c.max_entries, 65_536), lim(c.max_items, 131_072));
        let items = &c.items;
        // answers, outside timing
        let counts: Vec<usize> = items.iter().map(|b| n_minicbor(b).expect("minicbor tokens")).collect();
        for b in items {
            let mut s = so;
            assert_eq!(scan(b, &mut s), 0, "{}: snug scan refused", c.id);
            assert!(validate(&any, 0, b, &o, &mut scratch).is_ok(), "{}: snug VM refused", c.id);
            let mut d = minicbor::Decoder::new(b); d.skip().expect("minicbor skip"); assert_eq!(d.position(), b.len(), "{}: minicbor trailing", c.id);
        }
        let check = |name: &str, got: Vec<usize>| { if got != counts { panic!("{}: {name} item counts differ", c.id) } };
        check("ciborium", items.iter().map(|b| n_ciborium(&ciborium::de::from_reader::<ciborium::Value, _>(&b[..]).expect("ciborium"))).collect());
        let sc: Vec<Result<usize, String>> = items.iter().map(|b| serde_cbor::from_slice::<serde_cbor::Value>(b).map(|v| n_serde_cbor(&v)).map_err(|e| e.to_string())).collect();
        let c4: Vec<Result<usize, String>> = items.iter().map(|b| cbor4ii::serde::from_slice::<cbor4ii::core::Value>(b).map(|v| n_cbor4ii(&v)).map_err(|e| e.to_string())).collect();
        let sc_ok = sc.iter().all(|r| r.is_ok()); let c4_ok = c4.iter().all(|r| r.is_ok());
        if sc_ok { check("serde_cbor", sc.into_iter().map(Result::unwrap).collect()); } else { notes.push(format!("{}: serde_cbor refused: {}", c.id, sc.iter().find_map(|r| r.clone().err()).unwrap())); }
        if c4_ok { check("cbor4ii", c4.into_iter().map(Result::unwrap).collect()); } else { notes.push(format!("{}: cbor4ii refused: {}", c.id, c4.iter().find_map(|r| r.clone().err()).unwrap())); }
        for b in items { decode_cbor(b).expect("cddl decode_cbor"); }

        let mut ops: Vec<Op> = Vec::new();
        ops.push(("snug scan".into(), Box::new(|| items.iter().map(|b| { let mut s = so; scan(black_box(b), &mut s) as usize }).sum())));
        let (anyr, or) = (&any, &o);
        let mut scr = Scratch::new();
        ops.push(("snug VM any".into(), Box::new(move || items.iter().map(|b| validate(anyr, 0, black_box(b), or, &mut scr).is_ok() as usize).sum())));
        ops.push(("minicbor skip".into(), Box::new(|| items.iter().map(|b| { let mut d = minicbor::Decoder::new(black_box(b)); d.skip().is_ok() as usize + d.position() }).sum())));
        ops.push(("minicbor tokens".into(), Box::new(|| items.iter().map(|b| { let mut d = minicbor::Decoder::new(black_box(b)); d.tokens().filter(|t| t.is_ok()).count() }).sum())));
        ops.push(("ciborium".into(), Box::new(|| items.iter().map(|b| { let v: ciborium::Value = ciborium::de::from_reader(&black_box(b)[..]).unwrap(); black_box(&v); 1 }).sum())));
        if sc_ok { ops.push(("serde_cbor".into(), Box::new(|| items.iter().map(|b| { let v: serde_cbor::Value = serde_cbor::from_slice(black_box(b)).unwrap(); black_box(&v); 1 }).sum()))); }
        if c4_ok { ops.push(("cbor4ii".into(), Box::new(|| items.iter().map(|b| { let v: cbor4ii::core::Value = cbor4ii::serde::from_slice(black_box(b)).unwrap(); black_box(&v); 1 }).sum()))); }
        ops.push(("cddl decode_cbor".into(), Box::new(|| items.iter().map(|b| { let v = decode_cbor(black_box(b)).unwrap(); black_box(&v); 1 }).sum())));
        let res = bench(&mut ops, rounds, target);
        let cell = |name: &str| ops.iter().position(|(n, _)| n == name).map(|i| fmt(res[i].0)).unwrap_or_else(|| "refused".into());
        let bytes: usize = items.iter().map(|b| b.len()).sum();
        println!("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |", &c.id[9..], bytes, cell("snug scan"), cell("snug VM any"), cell("minicbor skip"), cell("minicbor tokens"), cell("ciborium"), cell("serde_cbor"), cell("cbor4ii"), cell("cddl decode_cbor"));
    }
    for n in &notes { println!("\nnote: {n}"); }

    // ------------------------------------------------ 2. CDDL validation: snug (compile + VM) vs the cddl crate
    println!("\n# cddl: per call\n");
    println!("| case | rule | bytes | expected | snug | cddl crate (decode_cbor + CBORValidator) | snug result |");
    println!("| --- | --- | ---: | --- | ---: | ---: | --- |");
    let mut programs: std::collections::HashMap<String, (Program, Vec<String>)> = Default::default();
    let mut asts: std::collections::HashMap<(String, String), Option<&'static CDDL<'static>>> = Default::default();
    for c in &cases {
        let text = std::fs::read_to_string(format!("{dir}/{}.cddl", c.schema)).expect("schema");
        let big = c.id.starts_with("workload:");
        let (prog, rules) = programs.entry(c.schema.clone()).or_insert_with(|| {
            let k = compile(&text, 0, if big { &BIG } else { &[] }).unwrap_or_else(|e| panic!("{}: snug compile {:?}", c.schema, e));
            (Program::new(&k.program, &k.pool).expect("verify"), k.rules)
        });
        let rule = rules.iter().position(|r| *r == c.rule).expect("rule") as i32;
        let o = opts(c);
        // the crate: target rule first, as the study binding does; a schema it cannot parse is reported
        let ast = *asts.entry((c.schema.clone(), c.rule.clone())).or_insert_with(|| {
            let parse = |t: &str| { let s: &'static str = Box::leak(t.to_string().into_boxed_str()); cddl::pest_bridge::cddl_from_pest_str_checked(s).ok() };
            let mut a = parse(&text).or_else(|| parse(&text.replace("safe-uint = 0..9007199254740991", "safe-uint = uint")))?;
            let i = a.rules.iter().position(|r| matches!(r, Rule::Type { rule: tr, .. } if tr.name.ident == c.rule && tr.generic_params.is_none()))?;
            let r = a.rules.remove(i); a.rules.insert(0, r);
            Some(&*Box::leak(Box::new(a)))
        });
        let items = &c.items;
        let mut scr = Scratch::new();
        let results: Vec<_> = items.iter().map(|b| validate(prog, rule, b, &o, &mut scr)).collect();
        let snug_ok = results.iter().all(|r| r.is_ok());
        let detail = results.iter().find_map(|r| r.as_ref().err()).map(|f| format!("{} (units {})", f.reason, f.budget_used)).unwrap_or_else(|| "ok".into());
        let crate_ok = ast.map(|a| items.iter().all(|b| { let v = decode_cbor(b).unwrap(); let mut cv = CBORValidator::new(a, v, None); Validator::<cddl_cbor::Error<std::io::Error>>::validate(&mut cv).is_ok() }));
        let mut ops: Vec<Op> = Vec::new();
        let (pr, orf) = (&*prog, &o);
        let mut s2 = Scratch::new();
        ops.push(("snug".into(), Box::new(move || items.iter().map(|b| validate(pr, rule, black_box(b), orf, &mut s2).is_ok() as usize).sum())));
        if let Some(a) = ast { ops.push(("crate".into(), Box::new(move || items.iter().map(|b| { let v = decode_cbor(black_box(b)).unwrap(); let mut cv = CBORValidator::new(a, v, None); Validator::<cddl_cbor::Error<std::io::Error>>::validate(&mut cv).is_ok() as usize }).sum()))); }
        let res = bench(&mut ops, rounds, target);
        let mark = |ok: bool| if ok == c.valid { "" } else { " !" };
        let bytes: usize = items.iter().map(|b| b.len()).sum();
        println!("| {} | {} | {} | {} | {}{} | {} | {} |", c.id, c.rule, bytes, if c.valid { "valid" } else { "invalid" }, fmt(res[0].0), mark(snug_ok),
                 match crate_ok { Some(ok) => format!("{}{}", fmt(res[1].0), mark(ok)), None => "does not parse".into() }, detail);
    }
}
