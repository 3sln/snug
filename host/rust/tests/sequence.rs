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
        let got: Vec<_> = read_sequence(&bytes[..], &opts).map(Result::unwrap).collect();
        assert_eq!(got.iter().map(|m| m.offset as usize).collect::<Vec<_>>(), offsets[..3].to_vec());
        assert_eq!(got[2].view().get("type").and_then(|v| v.text()), Some("c"));
    }
    assert_eq!(read_sequence(&[][..], &SequenceOptions::default()).count(), 0);
}

#[test]
fn refusals_carry_index_and_absolute_offsets() {
    let schema = event_schema();
    let (bytes, offsets) = body();
    // a truncated tail
    let got: Vec<_> = read_sequence(&bytes[..offsets[2] + 2], &SequenceOptions::default()).collect();
    assert_eq!(got.len(), 3);
    match &got[2] {
        Err(Error::Sequence(f)) => {
            assert_eq!((f.index, f.message_offset, f.failure.reason, f.skippable), (2, offsets[2] as u64, "cbor/truncated", false));
        }
        other => panic!("{:?}", other),
    }
    // oversize
    let small = SequenceOptions { max_message_bytes: Some(10), ..SequenceOptions::default() };
    let e = read_sequence(&bytes[..], &small).find_map(Result::err).unwrap();
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
    assert_eq!(items[1].as_ref().unwrap_err().code(), "indefinite");
    assert!(seq.is_done());
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
    let valid = SequenceOptions { profile: snug::Profile::VALID, ..SequenceOptions::default() };
    let mut seq = Sequence::new(&valid).unwrap();
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
    let mut det = Sequence::new(&SequenceOptions::default()).unwrap();
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
