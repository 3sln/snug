//! P9.6: the async source drivers (`snug::async_source`) against the sync Rust drivers
//! and the buffer, on a seeded slice of `bb vmsession-test`'s case set
//! (`tests/async-cases.mjs`), under many chunkings, with reads that answer `Pending`
//! at random and positive quanta that yield. Every verdict (code, reason, subcode,
//! offset, path, budget) must be identical. Counts go to `async-sources-*.txt` in the
//! assembled crate. `SNUG_ASYNC_CASES="mutations seed schemas stress"` changes the export.
//! By default (`bb rust-api-test`) the differential runs a seeded slice: every 8th case
//! and every 16th sequence body of at most 64 KiB; `bb rust-api-test full` (`SNUG_ASYNC_FULL=1`) runs all.
use snug::async_source;
use snug::controls::{Chars, Control, Controls};
use snug::schema::{self, BytesBlob as RawBlob, Failure, Options, SourceError};
use snug::{
    read_sequence, read_sequence_async, AsyncBlob, AsyncSource, BytesBlob, CompileOptions, Error, Message, OnInvalid,
    Profile, Program, Schema, SequenceOptions, SourceOptions, ValidationOptions,
};
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::{pin, Pin};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll, Wake, Waker};

// ---------------------------------------------------------------- a minimal executor

struct Flag(AtomicUsize);
impl Wake for Flag {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

/// Poll to completion; every `Pending` must have arranged a wake-up (else a driver
/// would hang under a real executor). Answers the output and the number of Pendings.
fn block_on<F: Future>(f: F) -> (F::Output, usize) {
    let flag = Arc::new(Flag(AtomicUsize::new(0)));
    let waker = Waker::from(flag.clone());
    let mut cx = Context::from_waker(&waker);
    let mut f = pin!(f);
    let mut pendings = 0;
    loop {
        let before = flag.0.load(Ordering::Relaxed);
        match f.as_mut().poll(&mut cx) {
            Poll::Ready(v) => return (v, pendings),
            Poll::Pending => {
                pendings += 1;
                assert!(flag.0.load(Ordering::Relaxed) > before, "Pending without a wake-up");
            }
        }
    }
}

// ---------------------------------------------------------------- deterministic randomness

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n.max(1)
    }
}

// ---------------------------------------------------------------- sources

/// Read sizes: `Fixed(n)` every read, `Random(seed, max)` 1..=max per read.
#[derive(Clone, Copy, Debug)]
enum Split {
    Fixed(usize),
    Random(u32, usize),
}
struct Splitter(Split, Rng);
impl Splitter {
    fn new(s: Split) -> Self {
        Splitter(s, Rng(match s { Split::Random(seed, _) => seed | 1, _ => 1 }))
    }
    fn size(&mut self) -> usize {
        match self.0 {
            Split::Fixed(n) => n,
            Split::Random(_, max) => 1 + self.1.below(max as u32) as usize,
        }
    }
}

/// A sync reader giving the split's read sizes.
struct Trickle<'a> {
    data: &'a [u8],
    split: Splitter,
}
impl io::Read for Trickle<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = self.split.size().min(out.len()).min(self.data.len());
        out[..n].copy_from_slice(&self.data[..n]);
        self.data = &self.data[n..];
        Ok(n)
    }
}

/// The same reads asynchronously, answering `Pending` (after a wake) at random
/// before a read (a Pending consumes nothing, so the read sizes match the sync ones).
struct AsyncTrickle<'a> {
    data: &'a [u8],
    split: Splitter,
    pend: Rng,
    every: u32,
    reads: usize,
    interrupt: bool,
}
impl<'a> AsyncTrickle<'a> {
    fn new(data: &'a [u8], split: Split, seed: u32, every: u32) -> Self {
        AsyncTrickle { data, split: Splitter::new(split), pend: Rng(seed | 1), every, reads: 0, interrupt: false }
    }
}
impl AsyncSource for AsyncTrickle<'_> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, out: &mut [u8]) -> Poll<io::Result<usize>> {
        let me = &mut *self;
        if me.every > 0 && me.pend.below(me.every) == 0 {
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        if me.interrupt && me.pend.below(4) == 0 {
            return Poll::Ready(Err(io::Error::from(io::ErrorKind::Interrupted)));
        }
        me.reads += 1;
        let n = me.split.size().min(out.len()).min(me.data.len());
        out[..n].copy_from_slice(&me.data[..n]);
        me.data = &me.data[n..];
        Poll::Ready(Ok(n))
    }
}

/// An async blob whose reads answer `Pending` at random first.
struct SlowBlob<'a> {
    data: &'a [u8],
    seed: std::cell::Cell<u32>,
    reads: std::cell::Cell<usize>,
}
impl AsyncBlob for SlowBlob<'_> {
    fn size(&self) -> usize {
        self.data.len()
    }
    async fn read(&self, offset: usize, len: usize) -> Result<Vec<u8>, SourceError> {
        let mut r = Rng(self.seed.get() | 1);
        let pend = r.below(3) == 0;
        self.seed.set(r.next());
        self.reads.set(self.reads.get() + 1);
        if pend {
            let mut once = false;
            std::future::poll_fn(|cx| {
                if once {
                    Poll::Ready(())
                } else {
                    once = true;
                    cx.waker().wake_by_ref();
                    Poll::Pending
                }
            })
            .await;
        }
        self.data.get(offset..offset + len).map(<[u8]>::to_vec).ok_or(SourceError::Read)
    }
}

// ---------------------------------------------------------------- cases

/// kin/scripts/ext-cases.mjs's test registry (as bin/vmsession.rs).
struct Even;
impl Control for Even {
    fn check(&self, _a: &[u8], item: &[u8]) -> bool {
        item.len().is_multiple_of(2)
    }
    fn max_bytes(&self) -> u32 {
        300
    }
}
struct Tiny;
impl Control for Tiny {
    fn check(&self, a: &[u8], item: &[u8]) -> bool {
        Chars.check(a, item)
    }
    fn max_bytes(&self) -> u32 {
        8
    }
    fn prepare(&self, pool: &[u8], ao: i32, al: i32) -> Option<Vec<i32>> {
        Chars.prepare(pool, ao, al)
    }
    #[allow(clippy::too_many_arguments)]
    fn run(&self, pool: &[u8], ao: i32, t: &[i32], b: &[u8], s: i32, e: i32, room: i32) -> i32 {
        Chars.run(pool, ao, t, b, s, e, room)
    }
}
struct Costly;
impl Control for Costly {
    fn check(&self, _a: &[u8], item: &[u8]) -> bool {
        !item.len().is_multiple_of(3)
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
    fn check(&self, _a: &[u8], _item: &[u8]) -> bool {
        true
    }
    fn cost(&self, _n: u32) -> u64 {
        1_000_000_000
    }
}
fn test_controls() -> Controls {
    Controls::generic().with("even", Even).with("tiny", Tiny).with("costly", Costly).with("huge", Huge)
}

fn unhex(s: &str) -> Vec<u8> {
    if s == "-" {
        return Vec::new();
    }
    s.as_bytes().chunks_exact(2).map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap()).collect()
}

struct Prog {
    raw: schema::Program,
    words: Vec<i32>,
    pool: Vec<u8>,
}
struct Case {
    prog: usize,
    rule: i32,
    opts: Options,
    bytes: Vec<u8>,
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn load_cases() -> (Vec<Prog>, Vec<Case>) {
    let mut cmd = Command::new("node");
    cmd.arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/async-cases.mjs")).arg(root());
    if let Ok(a) = std::env::var("SNUG_ASYNC_CASES") {
        cmd.args(a.split_whitespace());
    }
    let out = cmd.output().expect("Node must be available for the async source gate");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let controls = test_controls();
    let (mut progs, mut cases) = (Vec::new(), Vec::new());
    for line in String::from_utf8(out.stdout).unwrap().lines() {
        let f: Vec<&str> = line.split(' ').collect();
        match f[0] {
            "prog" => {
                let words: Vec<i32> = f[1].split(',').map(|w| w.parse().unwrap()).collect();
                let pool = unhex(f[2]);
                let mut raw = schema::Program::new(&words, &pool).expect("the case Programs verify");
                raw.bind(&controls).expect("the test registry has every control");
                progs.push(Prog { raw, words, pool });
            }
            "case" => {
                let l: Vec<i32> = f[3].split(',').map(|w| w.parse().unwrap()).collect();
                let lim = |v: i32| if v < 0 { None } else { Some(v) };
                let opts = Options {
                    top_map: l[0] == 0,
                    cose: l[1] == 1,
                    max_bytes: lim(l[2]),
                    max_depth: lim(l[3]),
                    max_entries: lim(l[4]),
                    max_items: lim(l[5]),
                    max_bignum_bytes: lim(l[6]),
                    budget: lim(l[7]),
                    profile: l[9],
                };
                cases.push(Case { prog: f[1].parse().unwrap(), rule: f[2].parse().unwrap(), opts, bytes: unhex(f[4]) });
            }
            _ => panic!("bad case line"),
        }
    }
    (progs, cases)
}

#[derive(Default)]
struct Counts {
    blob_runs: usize,
    reader_runs: usize,
    fail_fast_runs: usize,
    pendings: usize,
    yields_cases: usize,
    sequences: usize,
    sequence_runs: usize,
    sequence_items: usize,
}

fn show(r: &Result<(), Failure>) -> String {
    format!("{r:?}")
}

/// Chunk sizes and read splits by input size (1-byte and small random splits only
/// where they stay cheap in the debug build).
fn chunkings(n: usize, rng: &mut Rng) -> (Vec<usize>, Vec<Split>) {
    let whole = n.max(1);
    if n <= 64 {
        (vec![1, 2, 7, 1 + rng.below(64) as usize, whole],
         vec![Split::Fixed(1), Split::Random(rng.next(), 7), Split::Fixed(whole)])
    } else if n <= 4096 {
        (vec![1 + rng.below(7) as usize, 1 + rng.below(300) as usize, whole],
         vec![Split::Random(rng.next(), 7), Split::Random(rng.next(), 300), Split::Fixed(whole)])
    } else {
        (vec![1 + rng.below(4096) as usize, whole], vec![Split::Random(rng.next(), 4096), Split::Fixed(whole)])
    }
}

fn cases() -> &'static (Vec<Prog>, Vec<Case>) {
    static CASES: OnceLock<(Vec<Prog>, Vec<Case>)> = OnceLock::new();
    CASES.get_or_init(|| {
        let (progs, cases) = load_cases();
        assert!(progs.len() > 500 && cases.len() > 10_000, "the case export shrank: {} / {}", progs.len(), cases.len());
        (progs, cases)
    })
}

/// The gate's mode: `bb rust-api-test full` (SNUG_ASYNC_FULL=1) runs every case;
/// the default runs a seeded slice -- every `stride()`-th case and every
/// `2 * stride()`-th sequence body -- for routine gating.
fn stride() -> usize {
    if std::env::var("SNUG_ASYNC_FULL").is_ok_and(|v| v == "1") { 1 } else { 8 }
}
fn mode() -> &'static str {
    if stride() == 1 { "full" } else { "default slice" }
}

/// Run `f` on the cases of this mode with their buffer verdict, chunkings and quanta
/// (tiny quanta on small inputs; on large ones a quantum that still yields often).
fn each_case(seed: u32, mut f: impl FnMut(&Ctx<'_>, &mut Rng)) -> usize {
    let (progs, cases) = cases();
    let mut scratch = schema::Scratch::new();
    let mut rng = Rng(seed);
    let mut ran = 0;
    for (i, k) in cases.iter().enumerate() {
        if i % stride() != 0 {
            continue;
        }
        ran += 1;
        let p = &progs[k.prog].raw;
        let buffer = schema::validate(p, k.rule, &k.bytes, &k.opts, &mut scratch);
        let (chunks, splits) = chunkings(k.bytes.len(), &mut rng);
        let n = k.bytes.len();
        let quanta = [0, if n <= 64 { 1 + rng.below(3) } else if n <= 4096 { 1 + rng.below(64) } else { 1024 + rng.below(4096) } as i32];
        f(&Ctx { i, p, k, buffer, chunks, splits, quanta }, &mut rng);
    }
    ran
}
struct Ctx<'a> {
    i: usize,
    p: &'a schema::Program,
    k: &'a Case,
    buffer: Result<(), Failure>,
    chunks: Vec<usize>,
    splits: Vec<Split>,
    quanta: [i32; 2],
}
impl Ctx<'_> {
    fn label(&self, what: &str) -> String {
        format!("case {} ({} bytes) {what}", self.i, self.k.bytes.len())
    }
}
fn report(name: &str, text: String) {
    std::fs::write(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("async-sources-{name}.txt")),
                   format!("[{}] {text}\n", mode())).unwrap();
}

#[test]
fn async_blob_driver_equals_the_sync_driver_and_the_buffer() {
    let t = std::time::Instant::now();
    let mut c = Counts::default();
    let n = each_case(0x9e37_79b9, |x, rng| {
        let (p, k, buffer) = (x.p, x.k, &x.buffer);
        for &chunk in &x.chunks {
            for &q in &x.quanta {
                let sync = schema::validate_blob(p, k.rule, &RawBlob(&k.bytes), &k.opts, chunk, q).unwrap();
                assert_eq!(show(&sync), show(buffer), "{}", x.label(&format!("sync blob chunk {chunk} q {q}")));
                let blob = SlowBlob { data: &k.bytes, seed: std::cell::Cell::new(rng.next()), reads: Default::default() };
                let (got, pend) = block_on(async_source::validate_blob(p, k.rule, &blob, &k.opts, chunk, q));
                assert_eq!(show(&got.unwrap()), show(&sync), "{}", x.label(&format!("async blob chunk {chunk} q {q}")));
                c.blob_runs += 1;
                c.pendings += pend;
                if q > 0 && pend > 0 {
                    c.yields_cases += 1;
                }
            }
        }
    });
    report("blob", format!(
        "blob (known length): {n} cases on {} Programs, {} runs: async == sync == buffer; {} Pending polls; {} quantum \
         runs that yielded; {:.1} s", cases().0.len(), c.blob_runs, c.pendings, c.yields_cases, t.elapsed().as_secs_f64()));
    assert!(c.yields_cases > 0 && c.pendings > 0);
}

#[test]
fn async_reader_driver_equals_the_sync_driver_and_the_buffer() {
    let t = std::time::Instant::now();
    let mut c = Counts::default();
    let n = each_case(0x85eb_ca6b, |x, rng| {
        let (p, k, buffer) = (x.p, x.k, &x.buffer);
        for &split in &x.splits {
            let q = x.quanta[rng.below(2) as usize];
            let chunk = [1usize, 4, 64, 4096][rng.below(4) as usize];
            for fail_fast in [false, true] {
                let mut r = Trickle { data: &k.bytes, split: Splitter::new(split) };
                let sync = schema::validate_reader(p, k.rule, &mut r, &k.opts, chunk, q, fail_fast).unwrap();
                let mut src = AsyncTrickle::new(&k.bytes, split, rng.next(), 3);
                src.interrupt = true;
                let (got, pend) = block_on(async_source::validate_reader(p, k.rule, &mut src, &k.opts, chunk, q, fail_fast));
                let what = format!("reader {split:?} chunk {chunk} q {q} fail-fast {fail_fast}");
                assert_eq!(show(&got.unwrap()), show(&sync), "{}", x.label(&what));
                if fail_fast {
                    assert_eq!(sync.is_ok(), buffer.is_ok(), "{}", x.label(&what));
                    if buffer.is_ok() {
                        assert_eq!(&sync, buffer, "{}", x.label(&what));
                    }
                    c.fail_fast_runs += 1;
                } else {
                    assert_eq!(show(&sync), show(buffer), "{}", x.label(&what));
                    c.reader_runs += 1;
                }
                if q > 0 && pend > 0 {
                    c.yields_cases += 1;
                }
                c.pendings += pend;
            }
        }
    });
    report("reader", format!(
        "reader (unknown length): {n} cases, {} drain runs (async == sync == buffer) + {} fail-fast runs (async == sync, \
         accept iff the buffer accepts, equal when it does); {} Pending polls; {} quantum runs that yielded; {:.1} s",
        c.reader_runs, c.fail_fast_runs, c.pendings, c.yields_cases, t.elapsed().as_secs_f64()));
    assert!(c.yields_cases > 0 && c.pendings > 0);
}

/// Every item of a sequence reader, driven by `block_on`.
fn drain<S: AsyncSource + Unpin>(mut r: snug::AsyncSequenceReader<'_, S>) -> (Vec<Result<Message<'static>, Error>>, usize) {
    block_on(async move {
        let mut v = Vec::new();
        while let Some(m) = r.next().await {
            v.push(m);
        }
        v
    })
}

#[test]
fn async_sequence_reader_equals_the_sync_reader() {
    let t = std::time::Instant::now();
    let (progs, cases) = cases();
    let mut c = Counts::default();
    let mut rng = Rng(0xc2b2_ae35);
    // runs of consecutive cases on one Program and rule, schema-validated and profile-only
    let profiles = [Profile::VALID, Profile::DETERMINISTIC, Profile::BINDLE];
    let mut i = 0;
    let mut nth = 0;
    while i < cases.len() {
        let pi = cases[i].prog;
        let rule = cases[i].rule;
        let mut body = Vec::new();
        let mut j = i;
        while j < cases.len() && j < i + 6 && cases[j].prog == pi && cases[j].rule == rule && body.len() < 512 {
            body.extend_from_slice(&cases[j].bytes);
            j += 1;
        }
        nth += 1;
        // the default slice also leaves out the few very large bodies (their many small
        // messages are most of the full run's sequence time)
        let every = if stride() == 1 { 1 } else { 2 * stride() };
        if (nth - 1) % every != 0 || (stride() > 1 && body.len() > 65536) {
            i = j;
            continue;
        }
        let p = &progs[pi];
        let schema = Schema::from_program(Program::from_parts_with(&p.words, &p.pool, &test_controls()).unwrap());
        let name = schema.program().rules()[rule as usize].clone();
        let profile = profiles[rng.below(3) as usize];
        let on_invalid = if rng.below(2) == 0 { OnInvalid::Stop } else { OnInvalid::Skip };
        let fail_fast = rng.below(4) == 0;
        let n = body.len();
        let splits = [if n <= 128 { Split::Fixed(1) } else { Split::Random(rng.next(), 7) }, Split::Random(rng.next(), 300),
                      Split::Fixed(n.max(1))];
        for split in splits {
            let chunk = [1usize, 5, 64, 65536][rng.below(4) as usize];
            let o = SequenceOptions { profile, on_invalid, fail_fast, chunk, ..SequenceOptions::default() };
            // schema-validated, and profile-only (the VM against `any`)
            let sync: Vec<_> = schema.read_sequence(Trickle { data: &body, split: Splitter::new(split) }, &name, &o).unwrap().collect();
            let (got, pend) = drain(schema.read_sequence_async(AsyncTrickle::new(&body, split, rng.next(), 3), &name, &o).unwrap());
            assert_eq!(got, sync, "sequence of cases {i}..{j} {split:?} chunk {chunk}");
            let sync2: Vec<_> = read_sequence(Trickle { data: &body, split: Splitter::new(split) }, &o).unwrap().collect();
            let (got2, pend2) = drain(read_sequence_async(AsyncTrickle::new(&body, split, rng.next(), 3), &o).unwrap());
            assert_eq!(got2, sync2, "profile-only sequence of cases {i}..{j} {split:?} chunk {chunk}");
            c.sequence_items += got.len() + got2.len();
            c.sequence_runs += 2;
            c.pendings += pend + pend2;
        }
        c.sequences += 1;
        i = j;
    }
    report("sequence", format!(
        "sequences: {} bodies of consecutive cases ({} Programs), {} runs, {} items: async == sync (schema and \
         profile-only; Stop/Skip, fail-fast, 1-byte to whole reads); {} Pending polls; {:.1} s",
        c.sequences, progs.len(), c.sequence_runs, c.sequence_items, c.pendings, t.elapsed().as_secs_f64()));
    assert!(c.pendings > 0 && c.sequence_items > 0);
}

// ---------------------------------------------------------------- the public contract

/// Driver options (P9.16: one struct for chunk, quantum and fail-fast).
fn so(chunk: usize, quantum: u32, fail_fast: bool) -> SourceOptions {
    SourceOptions { chunk, quantum, fail_fast }
}

fn schema() -> Schema {
    Schema::compile("m = { id: uint, ? name: tstr, ? blob: bstr, tags: [* tstr] }", &CompileOptions::default()).unwrap()
}

#[test]
fn public_async_forms_match_the_sync_ones() {
    let schema = schema();
    let v = ValidationOptions::default();
    let inputs: Vec<Vec<u8>> = vec![
        vec![0xa2, 0x62, b'i', b'd', 0x07, 0x64, b't', b'a', b'g', b's', 0x80],
        vec![0xa2, 0x62, b'i', b'd', 0x07, 0x64, b't', b'a', b'g', b's'],
        vec![0xa2, 0x62, b'i', b'd', 0x07, 0x64, b't', b'a', b'g', b's', 0x80, 0x01],
        vec![0xa2, 0x62, b'i', b'd', 0x07, 0x64, b'b', b'l', b'o', b'b', 0x59, 0x01, 0x00, 1, 2, 3],
        vec![],
    ];
    for bytes in &inputs {
        for chunk in [1usize, 3, 4096] {
            let sync = schema.validate_blob(&BytesBlob(bytes), "m", &v, &so(chunk, 2, false)).unwrap();
            let (got, _) = block_on(schema.validate_blob_async(&BytesBlob(bytes), "m", &v, &so(chunk, 2, false)));
            assert_eq!(got.unwrap(), sync);
            for fail_fast in [false, true] {
                let mut r: &[u8] = bytes;
                let sync = schema.validate_reader(&mut r, "m", &v, &so(chunk, 0, fail_fast)).unwrap();
                let mut src: &[u8] = bytes;
                let (got, _) = block_on(schema.validate_reader_async(&mut src, "m", &v, &so(chunk, 0, fail_fast)));
                assert_eq!(got.unwrap(), sync);
            }
        }
    }
    // the same misuse and source errors as the sync forms
    let mut empty: &[u8] = &[];
    let (e, _) = block_on(schema.validate_reader_async(&mut empty, "m", &v, &so(0, 0, false)));
    assert_eq!(e.unwrap_err(), Error::Usage("options"));
    let (e, _) = block_on(schema.validate_blob_async(&BytesBlob(&[]), "m", &v, &so(1, u32::MAX, false)));
    assert_eq!(e.unwrap_err(), Error::Usage("options"));
    let (e, _) = block_on(schema.validate_blob_async(&BytesBlob(&[]), "nope", &v, &so(1, 0, false)));
    assert_eq!(e.unwrap_err(), Error::Usage("unknown_rule"));
    assert_eq!(schema.validate_blob(&BytesBlob(&[]), "nope", &v, &so(1, 0, false)).unwrap_err(), Error::Usage("unknown_rule"));
    assert!(matches!(schema.read_sequence_async(&[][..], "nope", &SequenceOptions::default()), Err(Error::Usage("unknown_rule"))));
    let zero = SequenceOptions { chunk: 0, ..SequenceOptions::default() };
    assert!(matches!(schema.read_sequence_async(&[][..], "m", &zero), Err(Error::Usage("options"))));
    // P9.16: a chunk above 2^31 - 1 is misuse, never a panic or a huge reservation
    for chunk in [usize::MAX, (i32::MAX as usize) + 1] {
        let mut empty: &[u8] = &[];
        let (e, _) = block_on(schema.validate_reader_async(&mut empty, "m", &v, &so(chunk, 0, false)));
        assert_eq!(e.unwrap_err(), Error::Usage("options"));
        let (e, _) = block_on(schema.validate_blob_async(&BytesBlob(&[]), "m", &v, &so(chunk, 0, false)));
        assert_eq!(e.unwrap_err(), Error::Usage("options"));
        let mut empty: &[u8] = &[];
        assert_eq!(schema.validate_reader(&mut empty, "m", &v, &so(chunk, 0, false)).unwrap_err(), Error::Usage("options"));
        assert_eq!(schema.validate_blob(&BytesBlob(&[]), "m", &v, &so(chunk, 0, false)).unwrap_err(), Error::Usage("options"));
        let big = SequenceOptions { chunk, ..SequenceOptions::default() };
        assert!(matches!(schema.read_sequence_async(&[][..], "m", &big), Err(Error::Usage("options"))));
        assert!(matches!(snug::read_sequence_async(&[][..], &big), Err(Error::Usage("options"))));
        assert!(matches!(schema.read_sequence(&[][..], "m", &big), Err(Error::Usage("options"))));
        assert!(matches!(snug::read_sequence(&[][..], &big), Err(Error::Usage("options"))));
    }

    struct Short;
    impl AsyncBlob for Short {
        fn size(&self) -> usize {
            8
        }
        async fn read(&self, _offset: usize, len: usize) -> Result<Vec<u8>, SourceError> {
            Ok(vec![0x80; len - 1])
        }
    }
    let (e, _) = block_on(schema.validate_blob_async(&Short, "m", &v, &so(4, 0, false)));
    assert_eq!(e.unwrap_err(), Error::Source("short_read"));
    struct Huge;
    impl AsyncBlob for Huge {
        fn size(&self) -> usize {
            1 << 31
        }
        async fn read(&self, _offset: usize, _len: usize) -> Result<Vec<u8>, SourceError> {
            unreachable!()
        }
    }
    let (e, _) = block_on(schema.validate_blob_async(&Huge, "m", &v, &so(4, 0, false)));
    assert_eq!(e.unwrap_err(), Error::Source("too_large"));

    struct Broken(usize);
    impl AsyncSource for Broken {
        fn poll_read(mut self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
            if self.0 == 0 {
                return Poll::Ready(Err(io::Error::other("transport")));
            }
            self.0 -= 1;
            buf[0] = 0x9f;
            Poll::Ready(Ok(1))
        }
    }
    let (e, _) = block_on(schema.validate_reader_async(&mut Broken(2), "m", &v, &so(4, 0, false)));
    // P9.16: the transport's own error is kept, behind source()
    let e = e.unwrap_err();
    assert_eq!(e.code(), "read");
    assert!(matches!(&e, Error::Io(io) if io.kind() == io::ErrorKind::Other && io.get_ref().to_string() == "transport"));
    assert_eq!(std::error::Error::source(&e).unwrap().to_string(), "transport");
    // a blob backend's io::Error the same way
    struct Failing;
    impl AsyncBlob for Failing {
        fn size(&self) -> usize {
            8
        }
        async fn read(&self, _offset: usize, _len: usize) -> Result<Vec<u8>, SourceError> {
            Err(io::Error::new(io::ErrorKind::TimedOut, "slow").into())
        }
    }
    let (e, _) = block_on(schema.validate_blob_async(&Failing, "m", &v, &so(4, 0, false)));
    assert!(matches!(e.unwrap_err(), Error::Io(io) if io.kind() == io::ErrorKind::TimedOut));
    let mut r = read_sequence_async(Broken(3), &SequenceOptions::default()).unwrap();
    let (items, _) = block_on(async {
        let mut v = Vec::new();
        while let Some(m) = r.next().await {
            v.push(m);
        }
        v
    });
    assert!(matches!(&items[..], [Err(Error::Io(io))] if io.kind() == io::ErrorKind::Other));
}

#[test]
fn async_sources_hold_bounded_bytes_and_stop_early() {
    // a 200 KB byte string streams through a few KiB of window
    let schema = Schema::compile("m = { blob: bstr }", &CompileOptions::default()).unwrap();
    let mut body = vec![0xa1, 0x64, b'b', b'l', b'o', b'b', 0x5a, 0x00, 0x03, 0x0d, 0x40];
    body.extend(std::iter::repeat_n(7u8, 200_000));
    struct Counting<'a>(&'a [u8], usize);
    impl AsyncSource for Counting<'_> {
        fn poll_read(mut self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
            let n = buf.len().min(self.0.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            self.1 += n;
            Poll::Ready(Ok(n))
        }
    }
    let mut src = Counting(&body, 0);
    let (got, _) = block_on(schema.validate_reader_async(&mut src, "m", &ValidationOptions::default(), &so(1024, 0, false)));
    assert!(got.unwrap().is_ok());
    assert_eq!(src.1, body.len());
    // fail-fast stops reading at a certain refusal; drain reads to the end
    let bad = [&[0xa1u8, 0x64, b'b', b'l', b'o', b'b', 0x01][..], &[0u8; 10_000][..]].concat();
    let mut src = Counting(&bad, 0);
    let (got, _) = block_on(schema.validate_reader_async(&mut src, "m", &ValidationOptions::default(), &so(64, 0, true)));
    assert!(got.unwrap().is_err());
    assert!(src.1 < 1000, "fail-fast read {} bytes", src.1);
    let mut src = Counting(&bad, 0);
    let (got, _) = block_on(schema.validate_reader_async(&mut src, "m", &ValidationOptions::default(), &so(64, 0, false)));
    assert_eq!(got.unwrap(), schema.validate(&bad, "m", &mut snug::Scratch::new()));
    assert_eq!(src.1, bad.len());
    // a sequence holds the message in progress only
    let msg = [0xa1u8, 0x64, b'b', b'l', b'o', b'b', 0x43, 1, 2, 3];
    let many: Vec<u8> = msg.iter().copied().cycle().take(msg.len() * 500).collect();
    let mut r = schema.read_sequence_async(&many[..], "m", &SequenceOptions { chunk: 7, ..SequenceOptions::default() }).unwrap();
    let (n, _) = block_on(async {
        let mut n = 0;
        while let Some(m) = r.next().await {
            assert!(m.is_ok());
            assert!(r.bytes_held() <= msg.len());
            n += 1;
        }
        n
    });
    assert_eq!(n, 500);
}

#[test]
fn dropped_futures_are_safe_and_next_is_cancel_safe() {
    let schema = schema();
    let body: Vec<u8> = [0xa2u8, 0x62, b'i', b'd', 0x07, 0x64, b't', b'a', b'g', b's', 0x80].repeat(20);
    // drop validations at every await point: nothing is left behind, the schema is reusable
    for polls in 0..40 {
        let mut src = AsyncTrickle::new(&body, Split::Fixed(3), 7, 2);
        {
            let flag = Arc::new(Flag(AtomicUsize::new(0)));
            let waker = Waker::from(flag);
            let mut cx = Context::from_waker(&waker);
            let v = ValidationOptions::default();
            let o = so(4, 1, false);
            let mut f = pin!(schema.validate_reader_async(&mut src, "m", &v, &o));
            for _ in 0..polls {
                if f.as_mut().poll(&mut cx).is_ready() {
                    break;
                }
            }
        }
        let blob = SlowBlob { data: &body[..11], seed: std::cell::Cell::new(polls + 1), reads: Default::default() };
        let (got, _) = block_on(schema.validate_blob_async(&blob, "m", &ValidationOptions::default(), &so(2, 1, false)));
        assert!(got.unwrap().is_ok());
    }
    // next(): a future dropped while its read is Pending loses no message
    let want: Vec<_> = schema.read_sequence(&body[..], "m", &SequenceOptions { chunk: 5, ..SequenceOptions::default() }).unwrap().collect();
    let mut r = schema
        .read_sequence_async(AsyncTrickle::new(&body, Split::Random(5, 9), 11, 2), "m", &SequenceOptions { chunk: 5, ..SequenceOptions::default() })
        .unwrap();
    let flag = Arc::new(Flag(AtomicUsize::new(0)));
    let waker = Waker::from(flag);
    let mut cx = Context::from_waker(&waker);
    let mut got: Vec<Result<Message<'static>, Error>> = Vec::new();
    let mut dropped = 0;
    loop {
        // poll a fresh next() once; drop it whenever it is Pending
        let mut f = pin!(r.next());
        match f.as_mut().poll(&mut cx) {
            Poll::Ready(Some(m)) => got.push(m),
            Poll::Ready(None) => break,
            Poll::Pending => dropped += 1,
        }
    }
    assert!(dropped > 0);
    assert_eq!(got, want);
}

#[test]
fn async_futures_are_send_when_their_sources_are() {
    fn send<T: Send>(_: &T) {}
    let schema = schema();
    let v = ValidationOptions::default();
    let blob = BytesBlob(&[0x80]);
    let o = so(4, 0, false);
    let f = schema.validate_blob_async(&blob, "m", &v, &o);
    send(&f);
    let mut src: &[u8] = &[0x80];
    let f = schema.validate_reader_async(&mut src, "m", &v, &o);
    send(&f);
    let mut r = schema.read_sequence_async(&[0x80u8][..], "m", &SequenceOptions::default()).unwrap();
    let f = r.next();
    send(&f);
}
