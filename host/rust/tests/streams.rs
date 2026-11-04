//! D085: messages of unknown length on the Rust host (drain mode, fail-fast).
use snug::{CompileOptions, Schema, Scratch};

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
            let got = schema.validate_reader(&mut Trickle(bytes, step), "m", &validation, 4, false).unwrap();
            assert_eq!(got, want, "{:02x?} step {}", bytes, step);
            let ff = schema.validate_reader(&mut Trickle(bytes, step), "m", &validation, 4, true).unwrap();
            assert_eq!(ff.is_ok(), want.is_ok(), "fail-fast {:02x?}", bytes);
        }
    }
    // more bytes than the input limit: too_large
    let small = snug::ValidationOptions { max_bytes: Some(4), ..snug::ValidationOptions::default() };
    let big = [0x45u8, 1, 2, 3, 4, 5];
    let want = schema.validate_with_options(&big, "m", &small, &mut s);
    let got = schema.validate_reader(&mut Trickle(&big, 1), "m", &small, 2, false).unwrap();
    assert_eq!(got, want);
    assert_eq!(got.unwrap_err().reason, "cbor/too_large");
}
