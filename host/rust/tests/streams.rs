//! D085: messages of unknown length on the Rust host (drain mode, fail-fast).
use snug::{CompileOptions, Error, Schema, Scratch, SourceOptions};

/// D085: messages of unknown length through `Schema::validate_reader` (drain mode,
/// fail-fast), against the buffer verdict, under several read sizes.
#[test]
fn unknown_length_readers_match_the_buffer() {
    struct Trickle<'a>(&'a [u8], usize);
    impl std::io::Read for Trickle<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let n = self.1.min(out.len()).min(self.0.len());
            out[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }
    let schema = Schema::compile("m = { id: uint, ? name: tstr, ? blob: bstr, tags: [* tstr] }", &CompileOptions::default()).unwrap();
    let mut s = Scratch::new();
    let cases: Vec<Vec<u8>> = vec![
        vec![0xa2, 0x62, b'i', b'd', 0x07, 0x64, b't', b'a', b'g', b's', 0x80],
        vec![0xa2, 0x62, b'i', b'd', 0x07, 0x64, b't', b'a', b'g', b's'],
        vec![0xa2, 0x62, b'i', b'd', 0x07, 0x64, b't', b'a', b'g', b's', 0x80, 0x01],
        vec![0xa3, 0x62, b'i', b'd', 0x19, 0x01, 0x35, 0x64, b'n'],
        vec![0xa2, 0x62, b'i', b'd', 0x07, 0x64, b'b', b'l', b'o', b'b', 0x59, 0x01, 0x00, 1, 2, 3],
        vec![0x92, 0xe8, 0xbd, 0xa0, 0x9f, 0xf9, 0x00],
        vec![],
    ];
    let validation = snug::ValidationOptions::default();
    for bytes in &cases {
        let want = schema.validate_with_options(bytes, "m", &validation, &mut s);
        for step in [1usize, 2, 3, 64] {
            let drain = SourceOptions { chunk: 4, ..SourceOptions::default() };
            let got = schema.validate_reader(&mut Trickle(bytes, step), "m", &validation, &drain).unwrap();
            assert_eq!(got, want, "{:02x?} step {}", bytes, step);
            let fast = SourceOptions { fail_fast: true, ..drain };
            let ff = schema.validate_reader(&mut Trickle(bytes, step), "m", &validation, &fast).unwrap();
            assert_eq!(ff.is_ok(), want.is_ok(), "fail-fast {:02x?}", bytes);
        }
    }
    // more bytes than the input limit: too_large
    let small = snug::ValidationOptions { max_bytes: Some(4), ..snug::ValidationOptions::default() };
    let big = [0x45u8, 1, 2, 3, 4, 5];
    let want = schema.validate_with_options(&big, "m", &small, &mut s);
    let got = schema.validate_reader(&mut Trickle(&big, 1), "m", &small, &SourceOptions { chunk: 2, ..SourceOptions::default() }).unwrap();
    assert_eq!(got, want);
    assert_eq!(got.unwrap_err().reason, "cbor/too_large");
}

/// P9.16: a reader's own error is kept (Error::Io, `source()`), and an unknown
/// rule is `Error::Usage("unknown_rule")` on every driver.
#[test]
fn read_errors_keep_the_io_error_and_unknown_rules_are_usage() {
    use std::error::Error as _;
    struct Reset;
    impl std::io::Read for Reset {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "peer reset"))
        }
    }
    let schema = Schema::compile("m = uint", &CompileOptions::default()).unwrap();
    let v = snug::ValidationOptions::default();
    let e = schema.validate_reader(&mut Reset, "m", &v, &SourceOptions::default()).unwrap_err();
    assert_eq!(e.code(), "read");
    assert_eq!(e.to_string(), "snug: operation refused (read)");
    let Error::Io(io) = &e else { panic!("{e:?}") };
    assert_eq!(io.kind(), std::io::ErrorKind::ConnectionReset);
    let src = e.source().unwrap().downcast_ref::<std::io::Error>().unwrap();
    assert_eq!(src.kind(), std::io::ErrorKind::ConnectionReset);
    assert_eq!(src.to_string(), "peer reset");
    let items: Vec<_> = snug::read_sequence(Reset, &snug::SequenceOptions::default()).unwrap().collect();
    assert!(matches!(&items[..], [Err(Error::Io(io))] if io.kind() == std::io::ErrorKind::ConnectionReset));
    // unknown rules: one report on every Result<_, Error> API
    let mut s = Scratch::new();
    let unknown = Error::Usage("unknown_rule");
    assert_eq!(schema.validate_reader(&mut &[0u8][..], "nope", &v, &SourceOptions::default()).unwrap_err(), unknown);
    assert_eq!(schema.validate_blob(&snug::BytesBlob(&[0]), "nope", &v, &SourceOptions::default()).unwrap_err(), unknown);
    assert_eq!(schema.decode(&[0], "nope", &mut s).unwrap_err(), unknown);
    assert_eq!(schema.view(&[0], "nope", &mut s).unwrap_err(), unknown);
    assert_eq!(schema.document(&[0], "nope", &v, &mut s).unwrap_err(), unknown);
    assert_eq!(schema.sequence("nope", &snug::SequenceOptions::default()).err().unwrap(), unknown);
    // validate answers a Failure (code -1); `?` into Error gives the same Usage
    let f = schema.validate(&[0], "nope", &mut s).unwrap_err();
    assert_eq!((f.code, f.reason), (-1, "unknown_rule"));
    assert_eq!(Error::from(f), unknown);
}
