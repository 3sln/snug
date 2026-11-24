//! `SequenceOptions` built as code outside the crate builds it: `#[non_exhaustive]` rules out a
//! struct literal here, so every field is set through its chainable setter (D374). Public API only.

use snug::{read_sequence, CompileOptions, Error, OnInvalid, Profile, Schema, Sequence, SequenceOptions, Top};

#[test]
fn every_setter_sets_its_field_and_nothing_else() {
    let d = SequenceOptions::default();
    let all = SequenceOptions::default()
        .top(Top::Map)
        .cose(true)
        .wire(Profile::BINDLE)
        .max_message_bytes(Some(1 << 20))
        .max_depth(Some(8))
        .max_entries(Some(100))
        .max_items(Some(1000))
        .max_bignum_bytes(Some(16))
        .budget(Some(50_000))
        .on_invalid(OnInvalid::Skip)
        .fail_fast(true)
        .chunk(4096)
        .quantum(64);
    assert_eq!(all.top, Top::Map);
    assert!(all.cose && all.fail_fast);
    assert_eq!(all.wire, Profile::BINDLE);
    assert_eq!((all.max_message_bytes, all.max_depth, all.max_entries), (Some(1 << 20), Some(8), Some(100)));
    assert_eq!((all.max_items, all.max_bignum_bytes, all.budget), (Some(1000), Some(16), Some(50_000)));
    assert_eq!((all.on_invalid, all.chunk, all.quantum), (OnInvalid::Skip, 4096, 64));
    // one setter leaves every other field at its default
    let one = SequenceOptions::default().max_depth(Some(8));
    assert_eq!(one.max_depth, Some(8));
    assert_eq!(format!("{:?}", one.max_depth(d.max_depth)), format!("{d:?}"));
    // the last call wins, and a setter can clear an Option back to None
    let o = SequenceOptions::default().budget(Some(1)).budget(None).chunk(1).chunk(2);
    assert_eq!((o.budget, o.chunk), (None, 2));
    // field assignment still works on a mutable value
    let mut m = SequenceOptions::default();
    m.on_invalid = OnInvalid::Skip;
    assert_eq!(m.on_invalid, OnInvalid::Skip);
}

#[test]
fn built_options_drive_the_readers() {
    // {"t": 1} {"t": "x"} {"t": 2}: the middle one fails the schema
    let body: &[u8] = &[0xa1, 0x61, b't', 0x01, 0xa1, 0x61, b't', 0x61, b'x', 0xa1, 0x61, b't', 0x02];
    let schema = Schema::compile("m = { t: uint }", &CompileOptions::default()).unwrap();
    let skip = SequenceOptions::default().on_invalid(OnInvalid::Skip).chunk(3);
    let got: Vec<bool> = schema.read_sequence(body, "m", &skip).unwrap().map(|r| r.is_ok()).collect();
    assert_eq!(got, [true, false, true]);
    let stop: Vec<bool> = schema.read_sequence(body, "m", &SequenceOptions::default()).unwrap().map(|r| r.is_ok()).collect();
    assert_eq!(stop, [true, false]);
    // a limit set by a setter applies: each message is 4 or 5 bytes
    let small = SequenceOptions::default().max_message_bytes(Some(4));
    let r: Vec<_> = read_sequence(body, &small).unwrap().collect();
    assert!(r[0].is_ok());
    match &r[1] {
        Err(e @ Error::Sequence(f)) => assert_eq!((f.index, e.code()), (1, "too_large")),
        other => panic!("{other:?}"),
    }
    // Top::Map refuses a top-level array
    let map_only = SequenceOptions::default().top(Top::Map);
    assert!(read_sequence(&[0x80u8][..], &map_only).unwrap().next().unwrap().is_err());
    // the sync readers refuse a quantum, as before
    let paced = SequenceOptions::default().quantum(64);
    assert!(matches!(Sequence::new(&paced), Err(Error::Usage("options"))));
}
