//! CBOR sequences (P7.13, D210–D217) on the Rust host. The exhaustive
//! differential is `bb sequence-test`; these pin the public contract.
use snug::{read_sequence, CompileLimits, CompileOptions, Error, OnInvalid, Schema, Sequence, SequenceOptions};

fn event_schema() -> Schema {
    Schema::compile("event = { type: tstr, ? n: uint }", &CompileOptions::default()).unwrap()
}
// {"n": 1, "type": "a"}, {"type": "bb"}, {"type": "c"}
fn body() -> (Vec<u8>, Vec<usize>) {
    let parts: Vec<Vec<u8>> = vec![
        vec![0xa2, 0x61, b'n', 0x01, 0x64, b't', b'y', b'p', b'e', 0x61, b'a'],
        vec![0xa1, 0x64, b't', b'y', b'p', b'e', 0x62, b'b', b'b'],
        vec![0xa1, 0x64, b't', b'y', b'p', b'e', 0x61, b'c'],
    ];
    let mut offsets = vec![0];
    for p in &parts {
        offsets.push(offsets.last().unwrap() + p.len());
    }
    (parts.concat(), offsets)
}

#[test]
fn the_builtin_any_program_is_the_compilers() {
    let limits = CompileLimits { depth: Some(256), input_bytes: Some(i32::MAX as u32), entries: Some(1 << 24),
                                 items: Some(1 << 24), budget: Some(i32::MAX as u32), ..CompileLimits::default() };
    let s = Schema::compile("r = any", &CompileOptions { limits, ..CompileOptions::default() }).unwrap();
    let w = s.program().words();
    // The public CompileLimits clamp at 2^31 - 2, so the input limit and budget words (33,
    // 37) say so and the source key (7..14) differs; JS's stream test compares every word.
    let same = w.len() == snug::sequence::ANY_P.len()
        && w.iter().zip(snug::sequence::ANY_P.iter()).enumerate().all(|(i, (a, b))| {
            (7..=14).contains(&i) || a == b || ((i == 33 || i == 37) && *a == i32::MAX - 1 && *b == i32::MAX)
        });
    assert!(same, "ANY_P differs from the compiled `r = any`");
    assert_eq!(s.program().pool(), &snug::sequence::ANY_B);
}

#[test]
fn push_messages_borrow_inside_a_chunk_and_own_across_chunks() {
    let schema = event_schema();
    let (bytes, offsets) = body();
    let mut seq = schema.sequence("event", &SequenceOptions::default()).unwrap();
    let (a, b) = bytes.split_at(offsets[1] + 3);
    let first: Vec<_> = seq.feed(a).into_iter().map(Result::unwrap).collect();
    assert_eq!(first.len(), 1);
    assert!(first[0].is_borrowed());
    assert_eq!((first[0].index, first[0].offset, first[0].bytes()), (0, 0, &bytes[..offsets[1]]));
    let rest: Vec<_> = seq.feed(b).into_iter().map(Result::unwrap).collect();
    assert_eq!(rest.len(), 2);
    assert!(!rest[0].is_borrowed() && rest[1].is_borrowed());
    assert_eq!(rest[0].offset, offsets[1] as u64);
    assert_eq!(rest[0].view().get("type").and_then(|v| v.text()), Some("bb"));
    assert!(seq.finish().is_empty());
    assert!(seq.is_done());
}

#[test]
fn read_sequence_yields_owned_messages_and_ends_cleanly() {
    let (bytes, offsets) = body();
    for chunk in [1usize, 4, 1000] {
        let opts = SequenceOptions { chunk, ..SequenceOptions::default() };
        let got: Vec<_> = read_sequence(&bytes[..], &opts).unwrap().map(Result::unwrap).collect();
        assert_eq!(got.iter().map(|m| m.offset as usize).collect::<Vec<_>>(), offsets[..3].to_vec());
        assert_eq!(got[2].view().get("type").and_then(|v| v.text()), Some("c"));
    }
    assert_eq!(read_sequence(&[][..], &SequenceOptions::default()).unwrap().count(), 0);
}

#[test]
fn refusals_carry_index_and_absolute_offsets() {
    let schema = event_schema();
    let (bytes, offsets) = body();
    // a truncated tail
    let got: Vec<_> = read_sequence(&bytes[..offsets[2] + 2], &SequenceOptions::default()).unwrap().collect();
    assert_eq!(got.len(), 3);
    match &got[2] {
        Err(Error::Sequence(f)) => {
            assert_eq!((f.index, f.message_offset, f.failure.reason, f.skippable), (2, offsets[2] as u64, "cbor/truncated", false));
        }
        other => panic!("{:?}", other),
    }
    // oversize
    let small = SequenceOptions { max_message_bytes: Some(10), ..SequenceOptions::default() };
    let e = read_sequence(&bytes[..], &small).unwrap().find_map(Result::err).unwrap();
    assert_eq!(e.code(), "too_large");
    // a schema refusal: stop, or skip and go on
    let mut bad = bytes.clone();
    bad.splice(offsets[1]..offsets[1], [0xa1, 0x64, b't', b'y', b'p', b'e', 0x05]);
    let stop: Vec<_> = schema.read_sequence(&bad[..], "event", &SequenceOptions::default()).unwrap().collect();
    assert_eq!(stop.len(), 2);
    let Err(Error::Sequence(f)) = &stop[1] else { panic!("{:?}", stop[1]) };
    assert_eq!((f.index, f.failure.reason, f.skippable, f.offset), (1, "type", true, offsets[1] as u64 + 6));
    assert_eq!(stop[1].as_ref().unwrap_err().code(), "schema/type");
    let skip = SequenceOptions { on_invalid: OnInvalid::Skip, ..SequenceOptions::default() };
    let all: Vec<_> = schema.read_sequence(&bad[..], "event", &skip).unwrap().collect();
    assert_eq!(all.iter().filter(|r| r.is_ok()).count(), 3);
    assert_eq!(all.iter().filter(|r| r.is_err()).count(), 1);
    // a profile refusal is never skipped
    let mut broken = bytes.clone();
    broken.insert(offsets[1], 0xff);
    let mut seq = Sequence::new(&skip).unwrap();
    let items = seq.feed(&broken);
    assert_eq!(items.len(), 2);
    assert_eq!(items[1].as_ref().unwrap_err().code(), "malformed");  // a lone break (valid default)
    assert!(seq.is_done());
    let det_skip = SequenceOptions { wire: snug::Profile::DETERMINISTIC, ..skip };
    let mut seq = Sequence::new(&det_skip).unwrap();
    assert_eq!(seq.feed(&broken)[1].as_ref().unwrap_err().code(), "indefinite");
    assert!(schema.sequence("nope", &skip).is_err());
}

#[test]
fn an_accepted_message_is_released_by_its_last_byte() {
    let schema = event_schema();
    let (bytes, offsets) = body();
    let mut seq = schema.sequence("event", &SequenceOptions::default()).unwrap();
    let mut seen = Vec::new();
    for i in 0..bytes.len() {
        for m in seq.feed(&bytes[i..i + 1]) {
            seen.push((m.unwrap().index, i + 1));
        }
    }
    assert_eq!(seen, vec![(0, offsets[1]), (1, offsets[2]), (2, offsets[3])]);
}

#[test]
fn valid_messages_with_indefinite_items_read_through_their_canonical_copy() {
    // P8.4: [_ 1, 2], {_ "b": 2, "a": 1}, {"t": (_ "ab", "c")} -- each released by its last
    // byte; the View reads the canonical copy (definite lengths, wire order kept)
    let parts: Vec<Vec<u8>> = vec![
        vec![0x9f, 0x01, 0x02, 0xff],
        vec![0xbf, 0x61, b'b', 0x02, 0x61, b'a', 0x01, 0xff],
        vec![0xa1, 0x61, b't', 0x7f, 0x62, b'a', b'b', 0x61, b'c', 0xff],
    ];
    let bytes = parts.concat();
    let mut seq = Sequence::new(&SequenceOptions::default()).unwrap();  // the valid default
    let mut got = Vec::new();
    for i in 0..bytes.len() {
        for m in seq.feed(&bytes[i..i + 1]) {
            got.push((m.unwrap().into_owned(), i + 1));
        }
    }
    assert!(seq.finish().is_empty());
    let ends: Vec<usize> = got.iter().map(|(_, e)| *e).collect();
    assert_eq!(ends, vec![4, 12, 22]);
    assert_eq!(got[0].0.view().at(1).and_then(|v| v.uint()), Some(2));
    assert_eq!(got[1].0.view().get("a").and_then(|v| v.uint()), Some(1));
    assert_eq!(got[1].0.view().get("b").and_then(|v| v.uint()), Some(2));
    assert_eq!(got[2].0.view().get("t").and_then(|v| v.text()), Some("abc"));
    // the deterministic preset refuses the first message
    let mut det = Sequence::new(&SequenceOptions { wire: snug::Profile::DETERMINISTIC, ..SequenceOptions::default() }).unwrap();
    assert_eq!(det.feed(&bytes)[0].as_ref().unwrap_err().code(), "indefinite");
}

#[test]
fn regression_complete_message_then_more_than_the_limit() {
    // 2026-11-11: a 65,541-byte map, then zeros up to 1,500,000 bytes and a0 (P = 1,500,000)
    let mut big = vec![0u8; 1_500_001];
    big[..6].copy_from_slice(&[0xa1, 0x61, 0x61, 0x59, 0xff, 0xff]);
    big[1_500_000] = 0xa0;
    let opts = SequenceOptions { top: snug::Top::Map, max_message_bytes: Some(1_500_000), ..SequenceOptions::default() };
    for cuts in [vec![big.len()], vec![65536, big.len()], vec![6, 65541, big.len()]] {
        let mut seq = Sequence::new(&opts).unwrap();
        let mut got = Vec::new();
        let mut from = 0;
        for to in cuts.iter().copied() {
            for item in seq.feed(&big[from..to]) {
                got.push(match item {
                    Ok(m) => format!("m{}+{}", m.index, m.len()),
                    Err(e) => format!("x {}", e.code()),
                });
            }
            from = to;
            if seq.is_done() { break; }
        }
        assert_eq!(got, ["m0+65541", "x not_map"], "{:?}", cuts);
    }
}

#[test]
fn regression_d355_a_count_claim_inside_a_tag_4_outranks_a_later_key_type() {
    // D355 (P9.9): a tag 4 taken whole above the Bindle tag set, holding a map whose count claims
    // past the input, then an integer key under text keys: truncated at the map's head (D211)
    let s = [0xa0u8, 0xc4, 0x82, 0x00, 0xb3, 0x18, 0x64, 0x1c];
    let profile = snug::Profile { keys: snug::Keys::Text, ..snug::Profile::DETERMINISTIC };
    let opts = SequenceOptions { wire: profile, ..SequenceOptions::default() };
    for cuts in [vec![8], vec![1, 8], vec![3, 5, 8], (1..=8).collect::<Vec<usize>>()] {
        let mut seq = Sequence::new(&opts).unwrap();
        let mut items: Vec<Result<snug::Message<'static>, Error>> = Vec::new();
        let mut from = 0;
        for to in cuts.iter().copied() {
            items.extend(seq.feed(&s[from..to]).into_iter().map(|i| i.map(|m| m.into_owned())));
            from = to;
            if seq.is_done() { break; }
        }
        if !seq.is_done() { items.extend(seq.finish()); }
        let got: Vec<String> = items.into_iter().map(|item| match item {
            Ok(m) => format!("m{}+{}", m.index, m.len()),
            Err(Error::Sequence(f)) => format!("x{} {} @{}", f.index, f.failure.reason, f.offset),
            Err(e) => format!("x {}", e.code()),
        }).collect();
        assert_eq!(got, ["m0+1", "x1 cbor/truncated @4"], "{:?}", cuts);
    }
}

/// P9.13 (CODE-S6): a predicate that panics inside `feed` leaves the sequence
/// half-updated; a caller that catches the panic gets `Error::Usage("poisoned")` from
/// every later call instead of a corrupted run. (N2) A reader that reports more bytes
/// than the buffer holds is an error, never a slice panic.
#[test]
fn a_predicate_panic_poisons_the_sequence_and_an_over_reporting_reader_is_an_error() {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    struct Boom;
    impl snug::Control for Boom {
        fn check(&self, _argument: &[u8], _item: &[u8]) -> bool {
            panic!("predicate panic")
        }
    }
    let controls = snug::Controls::new().with("boom", Boom);
    let schema = Schema::compile("r = [ uint .boom 0, tstr ]", &CompileOptions { controls: Some(&controls), ..CompileOptions::default() }).unwrap();
    let b = [0x82u8, 1, 0x61, b'x'];
    let mut seq = schema.sequence("r", &SequenceOptions::default()).unwrap();
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    assert!(catch_unwind(AssertUnwindSafe(|| seq.feed(&b).len())).is_err());
    std::panic::set_hook(hook);
    assert!(seq.is_done());
    let again = seq.feed(&b);
    assert!(matches!(again.as_slice(), [Err(snug::Error::Usage("poisoned"))]));
    assert!(matches!(seq.finish().as_slice(), [Err(snug::Error::Usage("poisoned"))]));
    drop(seq);

    struct OverRead;
    impl std::io::Read for OverRead {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            Ok(b.len() + 5)
        }
    }
    let plain = Schema::compile("r = [ uint, tstr ]", &CompileOptions::default()).unwrap();
    let opts = snug::ValidationOptions::default();
    assert!(plain.validate_reader(&mut OverRead, "r", &opts, &snug::SourceOptions::default()).is_err());
    let first = snug::read_sequence(OverRead, &SequenceOptions::default()).unwrap().next();
    assert!(matches!(first, Some(Err(snug::Error::Io(_)))));
}
