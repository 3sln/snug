// Native compile timings (bench/compile-bench.mjs prints the JS ones):
//
//     compile-bench <samples> <file.cddl>...
//
// Per file: 300 warm-up compiles, then `samples` timed loops of a calibrated
// count (~20 ms each); prints `<file> <median µs per compile> <min µs>`.
use snug::compile::compile;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let samples: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(15);
    for path in &args[2..] {
        let text = std::fs::read_to_string(path).expect("read");
        for _ in 0..300 {
            compile(&text, 0, &[]).expect("compiles");
        }
        let mut n = 1usize;
        loop {
            let t0 = Instant::now();
            for _ in 0..n {
                compile(&text, 0, &[]).expect("compiles");
            }
            if t0.elapsed().as_secs_f64() > 0.02 || n > 1 << 16 {
                break;
            }
            n *= 2;
        }
        let mut per: Vec<f64> = (0..samples)
            .map(|_| {
                let t0 = Instant::now();
                for _ in 0..n {
                    compile(&text, 0, &[]).expect("compiles");
                }
                t0.elapsed().as_secs_f64() * 1e6 / n as f64
            })
            .collect();
        per.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("{} {:.1} {:.1}", path, per[per.len() / 2], per[0]);
    }
}
