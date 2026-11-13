use snug::{
    decode, encode, Blob, BytesBlob, CompileOptions, DecodeOptions, EncodeOptions, Error, Integer,
    Limits, Program, Schema, Scratch, Segment, Top, TypedArray, TypedElement, ValidationOptions,
    Value, View, Writer,
};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::OnceLock,
};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}
fn oracle() -> Command {
    let mut cmd = Command::new("node");
    cmd.arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures.mjs"))
        .arg(root());
    cmd
}
fn rows() -> &'static Vec<Vec<String>> {
    static ROWS: OnceLock<Vec<Vec<String>>> = OnceLock::new();
    ROWS.get_or_init(|| {
        let result = oracle()
            .output()
            .expect("Node must be available for the JS parity gate");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout)
            .unwrap()
            .lines()
            .map(|s| s.split('\t').map(str::to_owned).collect())
            .collect()
    })
}
fn unhex(s: &str) -> Vec<u8> {
    s.as_bytes()
        .chunks_exact(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect()
}
fn text(s: &str) -> String {
    String::from_utf8(unhex(s)).unwrap()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}
fn string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
fn path_json(path: &[Segment]) -> String {
    let mut parts = Vec::new();
    for s in path {
        match s {
            Segment::Index(i) => parts.push(i.to_string()),
            Segment::Key(k) => parts.push(string(k)),
            Segment::AnyKey => parts.push(string("*")),
            Segment::Tag => parts.push(string("#tag")),
            Segment::Embedded => parts.push(string("cbor")),
            Segment::EmbeddedItem(i) => {
                parts.push(string("cbor"));
                parts.push(i.to_string());
            }
            // D339: `Segment` is non_exhaustive; a consumer renders an unknown kind
            other => panic!("a segment kind this test does not know: {other:?}"),
        }
    }
    format!("[{}]", parts.join(","))
}

#[test]
fn all_profile_vectors_and_seeded_mutations_match_js() {
    let mut count = 0;
    for row in rows().iter().filter(|r| r[0] == "c") {
        let bytes = unhex(&row[2]);
        // The fixtures are the Bindle profile's (cbor.mjs), so the Bindle preset, any root.
        let options = DecodeOptions {
            cose: row[1] == "1",
            top: Top::Any,
            ..DecodeOptions::bindle()
        };
        match decode(&bytes, &options) {
            Ok(v) => {
                assert_eq!(row[3], "ok", "fixture {count}");
                assert_eq!(
                    encode(
                        &v,
                        &EncodeOptions {
                            cose: options.cose,
                            ..EncodeOptions::bindle()
                        }
                    )
                    .unwrap(),
                    bytes,
                    "round trip {count}"
                );
                let view = View::open(&bytes, &options).unwrap();
                assert_eq!(view.value().unwrap(), v, "view {count}");
            }
            Err(e) => assert_eq!(e.code(), row[3], "fixture {count}"),
        }
        count += 1;
    }
    assert_eq!(count, 1243); // 216 corpus + 1024 mutations + 3 COSE probes.
}
struct Random(u32);
impl Random {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    fn value(&mut self, depth: usize) -> Value {
        match self.next() % if depth < 3 { 10 } else { 7 } {
            0 => Value::Uint(self.next() as u64),
            1 => Value::Nint(self.next() as u64),
            2 => Value::Text(format!("s{}", self.next())),
            3 => Value::Bool(self.next() & 1 != 0),
            4 => Value::Null,
            5 => Value::Bytes(vec![
                self.next() as u8,
                self.next() as u8,
                self.next() as u8,
            ]),
            6 => Value::Float((self.next() % 1000) as f64 + 0.5),
            7 => {
                let n = self.next() % 5;
                Value::Array((0..n).map(|_| self.value(depth + 1)).collect())
            }
            n => {
                let (k1, k2) = if n == 8 { ("z", "a") } else { ("long", "b") };
                Value::Map(vec![
                    (Value::Text(k1.into()), self.value(depth + 1)),
                    (Value::Text(k2.into()), self.value(depth + 1)),
                ])
            }
        }
    }
}
#[test]
fn independently_generated_values_encode_identically_to_js() {
    let mut random = Random(0x5a17c0de);
    let mut count = 0;
    for row in rows().iter().filter(|r| r[0] == "g") {
        let v = random.value(0);
        let bytes = encode(&v, &EncodeOptions::default()).unwrap();
        assert_eq!(hex(&bytes), row[1], "seeded value {count}");
        assert_eq!(
            encode(
                &decode(&bytes, &DecodeOptions::any()).unwrap(),
                &EncodeOptions::default()
            )
            .unwrap(),
            bytes
        );
        count += 1;
    }
    assert_eq!(count, 512);
}
#[test]
fn study_contract_verdicts_witnesses_and_sessions_match_js() {
    let mut scratch = Scratch::new();
    let mut count = 0;
    let mut schemas = std::collections::HashMap::new();
    for row in rows().iter().filter(|r| r[0] == "s") {
        let schema = schemas.entry(row[1].clone()).or_insert_with(|| {
            Schema::compile(&text(&row[1]), &CompileOptions::default()).unwrap()
        });
        let bytes = unhex(&row[3]);
        let result = schema.validate(&bytes, &row[2], &mut scratch);
        match &result {
            Ok(()) => {
                assert_eq!(row[4], "ok");
                assert_eq!(
                    encode(
                        &schema.decode(&bytes, &row[2], &mut scratch).unwrap(),
                        &EncodeOptions::default()
                    )
                    .unwrap(),
                    bytes
                );
            }
            Err(e) => {
                assert_eq!(e.reason, row[4]);
                assert_eq!(e.offset.to_string(), row[5]);
                assert_eq!(path_json(&e.path), text(&row[6]));
                assert_eq!(e.subcode.unwrap_or(""), row[7]);
            }
        }
        for chunk in [1, 7, 65536] {
            assert_eq!(
                schema
                    .validate_blob(
                        &BytesBlob(&bytes),
                        &row[2],
                        &ValidationOptions::default(),
                        &snug::SourceOptions { chunk, quantum: 7, ..Default::default() }
                    )
                    .unwrap(),
                result,
                "session {count}, chunk {chunk}"
            );
        }
        count += 1;
    }
    assert_eq!(count, 45);
    assert_eq!(schemas.len(), 6);
}
#[test]
fn programs_interoperate_with_js_both_directions() {
    let mut serials = String::new();
    let mut count = 0;
    for row in rows().iter().filter(|r| r[0] == "p") {
        let js = unhex(&row[2]);
        let loaded = Program::deserialize(&js).unwrap();
        assert_eq!(loaded.serialize().unwrap(), js);
        let rust = Schema::compile(&text(&row[1]), &CompileOptions::default()).unwrap();
        let out = rust.program().serialize().unwrap();
        assert_eq!(out, js, "Program {count}");
        assert_eq!(loaded.rules(), rust.program().rules());
        serials.push_str(&hex(&out));
        serials.push('\n');
        count += 1;
    }
    let mut child = oracle()
        .arg("load")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serials.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout, b"ok\n");
    assert_eq!(count, 6);
}
#[test]
fn exact_specialized_values_and_typed_bits() {
    let values = [
        Value::Nint(u64::MAX),
        Value::Uint(u64::MAX),
        Value::BigInt {
            negative: true,
            magnitude: vec![1; 128],
        },
        Value::Decimal {
            mantissa: Integer::BigInt {
                negative: false,
                magnitude: vec![1, 0, 0, 0, 0, 0, 0, 0, 1],
            },
            exponent: -1,
        },
        Value::NDArray {
            shape: vec![2],
            data: Box::new(Value::TypedArray(TypedArray::F16(vec![0x8000, 0xfc00]))),
        },
        Value::TypedArray(TypedArray::F64(vec![
            -0.0,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ])),
    ];
    for value in values {
        let b = encode(&value, &EncodeOptions::default()).unwrap();
        assert_eq!(
            encode(
                &decode(&b, &DecodeOptions::any()).unwrap(),
                &EncodeOptions::default()
            )
            .unwrap(),
            b
        );
    }
    assert_eq!(
        encode(&Value::Float(1.0), &EncodeOptions::bindle())
            .unwrap_err()
            .code(),
        "float"
    );
    // The deterministic preset (the default, D122) writes integral floats, NaN, infinities and -0 as floats.
    assert_eq!(encode(&Value::Float(1.0), &EncodeOptions::default()).unwrap(), [0xf9, 0x3c, 0x00]);
    assert_eq!(encode(&Value::Float(f64::NAN), &EncodeOptions::default()).unwrap(), [0xf9, 0x7e, 0x00]);
    assert_eq!(encode(&Value::Float(-0.0), &EncodeOptions::default()).unwrap(), [0xf9, 0x80, 0x00]);
    assert_eq!(encode(&Value::Undefined, &EncodeOptions::default()).unwrap(), [0xf7]);
    assert_eq!(encode(&Value::Undefined, &EncodeOptions::bindle()).unwrap_err().code(), "simple");
    // D265: the little-endian NaN and decimal normalisation rules are the Bindle tag set's
    assert!(encode(&Value::TypedArray(TypedArray::F32(vec![f32::NAN])), &EncodeOptions::default()).is_ok());
    assert_eq!(
        encode(&Value::TypedArray(TypedArray::F32(vec![f32::NAN])), &EncodeOptions::bindle())
            .unwrap_err()
            .code(),
        "typed_array"
    );
    let unnormal = Value::Decimal { mantissa: Integer::Uint(150), exponent: -2 };
    assert!(encode(&unnormal, &EncodeOptions::default()).is_ok());
    assert_eq!(encode(&unnormal, &EncodeOptions::bindle()).unwrap_err().code(), "decimal");
    assert_eq!(
        encode(
            &Value::Tag(0, Box::new(Value::Uint(1))),
            &EncodeOptions::default()
        )
        .unwrap_err()
        .code(),
        "tag"
    );
}
#[test]
fn writer_grammar_sorting_and_sticky_failure() {
    let mut writer = Writer::new(&EncodeOptions::default()).unwrap();
    writer
        .begin_map(2)
        .unwrap()
        .key("z")
        .unwrap()
        .begin_array(1)
        .unwrap()
        .uint(1)
        .unwrap()
        .end()
        .unwrap()
        .key("a")
        .unwrap()
        .int(i128::MIN)
        .unwrap()
        .end()
        .unwrap();
    let bytes = writer.finish().unwrap();
    let root = View::open(&bytes, &DecodeOptions::default()).unwrap();
    assert_eq!(root.entry(0).unwrap().0.text(), Some("a"));
    assert_eq!(root.get("z").unwrap().at(0).unwrap().uint(), Some(1));
    assert_eq!(writer.finish().unwrap_err().code(), "grammar");
    assert_eq!(writer.null().err().unwrap().code(), "writer_failed");
    let mut incomplete = Writer::new(&EncodeOptions::default()).unwrap();
    incomplete.begin_array(1).unwrap();
    assert_eq!(incomplete.end().err().unwrap().code(), "grammar");
    assert_eq!(incomplete.failure().unwrap().code(), "grammar");
    assert_eq!(incomplete.finish().unwrap_err().code(), "writer_failed");
    let duplicate = Value::Map(vec![
        (Value::Text("x".into()), Value::Null),
        (Value::Text("x".into()), Value::Null),
    ]);
    assert_eq!(
        encode(&duplicate, &EncodeOptions::default())
            .unwrap_err()
            .code(),
        "duplicate_key"
    );
}
#[test]
fn checked_views_cursors_and_unaligned_typed_access() {
    let bytes = unhex("a261618201026162d8454401000200");
    let root = View::open(&bytes, &DecodeOptions::default()).unwrap();
    let mut cursor = root.cursor();
    assert!(!cursor.up());
    assert!(!cursor.next());
    assert!(cursor.enter());
    assert_eq!(cursor.key().unwrap().text(), Some("a"));
    assert!(cursor.enter());
    assert_eq!(cursor.view().uint(), Some(1));
    assert!(cursor.next());
    assert_eq!(cursor.view().uint(), Some(2));
    assert!(!cursor.next());
    assert!(cursor.up());
    assert!(cursor.next());
    assert_eq!(cursor.key().unwrap().text(), Some("b"));
    assert!(!cursor.next());
    let typed = cursor.view().typed_view().unwrap();
    assert_eq!(typed.len(), 2);
    assert_eq!(typed.get(1), Some(TypedElement::Uint(2)));
    assert_eq!(typed.get(usize::MAX), None);
    assert!(typed.bytes().as_ptr() >= bytes.as_ptr());
    assert_eq!(root.get("missing").map(|v| v.offset()), None);
    assert_eq!(root.at(0).map(|v| v.offset()), None);
    assert!(root.entry(usize::MAX).is_none());
    let content = root.get("a").unwrap().raw();
    assert_eq!(content.as_ptr(), bytes[3..].as_ptr());
}
#[test]
fn limits_and_safe_refusals() {
    let mut options = DecodeOptions::any();
    options.limits.max_depth = 257;
    assert_eq!(decode(&[], &options).unwrap_err().code(), "options");
    options = DecodeOptions::any();
    options.limits.max_bytes = 0;
    assert_eq!(decode(&[0], &options).unwrap_err().code(), "too_large");
    options = DecodeOptions::any();
    options.limits.max_depth = 0;
    assert_eq!(decode(&[0x80], &options).unwrap_err().code(), "depth");
    let limits = Limits {
        max_bytes: 1,
        ..Limits::default()
    };
    assert_eq!(
        encode(
            &Value::Text("secret".into()),
            &EncodeOptions {
                limits,
                cose: false,
                ..Default::default()
            }
        )
        .unwrap_err()
        .code(),
        "too_large"
    );
    let schema = Schema::compile("r = { a: uint }", &CompileOptions::default()).unwrap();
    let bytes = encode(
        &Value::Map(vec![(
            Value::Text("unrecognized-secret".into()),
            Value::Text("payload-secret".into()),
        )]),
        &EncodeOptions::default(),
    )
    .unwrap();
    let e = schema.decode(&bytes, "r", &mut Scratch::new()).unwrap_err();
    assert!(!format!("{e:?} {e}").contains("secret"));
    assert_eq!(
        schema
            .validate(&[0], "missing", &mut Scratch::new())
            .unwrap_err()
            .reason,
        "unknown_rule"
    );
}
#[test]
fn named_compile_limits_runtime_caps_and_depth_ceiling() {
    let options = CompileOptions {
        profile: snug::CompilerProfile::Bindle,
        limits: snug::CompileLimits {
            input_bytes: Some(100),
            depth: Some(4),
            entries: Some(8),
            items: Some(16),
            budget: Some(1000),
            ..Default::default()
        },
        ..Default::default()
    };
    let schema = Schema::compile("r = [* uint]", &options).unwrap();
    let row = rows().iter().find(|r| r[0] == "q").unwrap();
    assert_eq!(hex(&schema.program().serialize().unwrap()), row[1]);
    let mut scratch = Scratch::new();
    schema.validate(&[0x81, 7], "r", &mut scratch).unwrap();
    let zero = ValidationOptions {
        budget: Some(0),
        ..Default::default()
    };
    assert_eq!(
        schema
            .validate_with_options(&[0x81, 7], "r", &zero, &mut scratch)
            .unwrap_err()
            .reason,
        "budget"
    );
    let tight = ValidationOptions {
        max_bytes: Some(1),
        ..Default::default()
    };
    assert_eq!(
        schema
            .validate_with_options(&[0x81, 7], "r", &tight, &mut scratch)
            .unwrap_err()
            .reason,
        "cbor/too_large"
    );
    let mut deep = vec![0x81; 256];
    deep.push(0);
    let options = DecodeOptions {
        limits: Limits {
            max_depth: 256,
            ..Default::default()
        },
        ..DecodeOptions::any()
    };
    let value = decode(&deep, &options).unwrap();
    assert_eq!(
        encode(
            &value,
            &EncodeOptions {
                limits: options.limits,
                ..Default::default()
            }
        )
        .unwrap(),
        deep
    );
    deep.insert(0, 0x81);
    assert_eq!(decode(&deep, &options).unwrap_err().code(), "depth");
    for map in [false, true] {
        let mut writer = Writer::new(&EncodeOptions::default()).unwrap();
        let error = if map {
            writer.begin_map(usize::MAX)
        } else {
            writer.begin_array(usize::MAX)
        };
        assert_eq!(error.err().unwrap().code(), "too_many_entries");
    }
}
fn rehash(bytes: &mut [u8]) {
    let mut pre = bytes[..56].to_vec();
    pre.extend_from_slice(&bytes[88..]);
    bytes[56..88].copy_from_slice(&snug::sha256::sha256(&pre));
}
#[test]
fn program_refusals_compatibility_and_provenance() {
    let schema = Schema::compile("r = uint", &CompileOptions::default()).unwrap();
    let bytes = schema.program().serialize().unwrap();
    assert_eq!(
        Program::deserialize(&bytes[..95]).unwrap_err().code(),
        "length"
    );
    for (at, v, code) in [
        (0, 0, "magic"),
        (8, 2, "container_version"),
        (12, 3, "format_version"),
        (14, 2, "format_version"),
        (24, 0, "version"),
        (88, 1, "reserved"),
        (96, 0, "digest"),
    ] {
        let mut b = bytes.clone();
        b[at] = v;
        assert_eq!(Program::deserialize(&b).unwrap_err().code(), code);
    }
    let mut b = bytes.clone();
    b[96] = 0;
    rehash(&mut b);
    assert_eq!(Program::deserialize(&b).unwrap_err().code(), "verify");
    let mut b = bytes.clone();
    b[24..56].fill(0);
    b[24..29].copy_from_slice(b"9.8.7");
    rehash(&mut b);
    let p = Program::deserialize(&b).unwrap();
    assert_eq!(p.producer_version(), "9.8.7");
    assert_eq!(p.serialize().unwrap(), b);
    assert_eq!(Program::from_parts(&[], &[]).unwrap_err().code(), "verify");
}
#[test]
fn arbitrary_bytes_and_program_words_never_panic() {
    let mut random = Random(0x70e57eed);
    for i in 0..8192 {
        let n = (random.next() % 65) as usize;
        let bytes: Vec<u8> = (0..n).map(|_| (random.next() >> 16) as u8).collect();
        let options = DecodeOptions {
            top: if i % 2 == 0 { Top::Map } else { Top::Any },
            ..DecodeOptions::any()
        };
        if let Ok(v) = decode(&bytes, &options) {
            encode(&v, &EncodeOptions::default()).unwrap();
            View::open(&bytes, &options).unwrap();
        }
        Program::deserialize(&bytes).unwrap_err();
    }
    let schema = Schema::compile("r = any", &CompileOptions::default()).unwrap();
    let p = schema.program();
    for _ in 0..1024 {
        let mut words = p.words().to_vec();
        let i = (random.next() as usize) % words.len();
        words[i] = random.next() as i32;
        let _ = Program::from_parts(&words, p.pool());
    }
}
#[test]
fn shared_schemas_independent_scratch_and_source_errors() {
    let schema = Schema::compile("r = uint", &CompileOptions::default()).unwrap();
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let s = &schema;
            scope.spawn(move || {
                let mut scratch = Scratch::new();
                for _ in 0..32 {
                    s.validate(&[7], "r", &mut scratch).unwrap();
                }
            });
        }
    });
    struct Short;
    impl Blob for Short {
        fn size(&self) -> usize {
            1
        }
        fn read(&self, _: usize, _: usize) -> Result<Vec<u8>, snug::schema::SourceError> {
            Ok(vec![])
        }
    }
    assert_eq!(
        schema
            .validate_blob(&Short, "r", &ValidationOptions::default(), &snug::SourceOptions { chunk: 1, ..Default::default() })
            .unwrap_err()
            .code(),
        "short_read"
    );
    assert!(BytesBlob(&[0]).read(usize::MAX, 1).is_err());
    assert!(matches!(
        schema.validate_blob(&BytesBlob(&[0]), "r", &ValidationOptions::default(), &snug::SourceOptions { chunk: 0, ..Default::default() }),
        Err(Error::Usage(_))
    ));
}

#[test]
fn any_tag_level_d180() {
    use snug::{Profile, Tags};
    assert_eq!(Profile::DETERMINISTIC.tags, Tags::Any);
    assert_eq!(Profile::DETERMINISTIC.flags(), 122);
    let standard = Profile {
        tags: Tags::Standard,
        ..Profile::DETERMINISTIC
    };
    assert_eq!(standard.flags(), 118);
    // COSE_Sign1 (RFC 9052 C.2.1 shape) decodes to Value::Tag(18, ..) and re-encodes byte for byte.
    let sign1 = unhex("d28443a10126a10442313154746869732069732074686520636f6e74656e742e4100");
    let v = decode(&sign1, &DecodeOptions::default()).unwrap();
    assert!(matches!(&v, Value::Tag(18, _)));
    assert_eq!(encode(&v, &EncodeOptions::default()).unwrap(), sign1);
    let std_opts = DecodeOptions {
        profile: standard,
        ..DecodeOptions::default()
    };
    assert_eq!(decode(&sign1, &std_opts).unwrap_err().code(), "tag");
    // 64-bit tag numbers: the whole number, never a bignum; the invalid numbers refused.
    let wide = Value::Tag((1 << 32) + 2, Box::new(Value::Bytes(vec![0])));
    let bytes = encode(&wide, &EncodeOptions::default()).unwrap();
    assert_eq!(hex(&bytes), "db00000001000000024100");
    assert_eq!(decode(&bytes, &DecodeOptions::default()).unwrap(), wide);
    let top = Value::Tag(u64::MAX - 1, Box::new(Value::Uint(0)));
    assert_eq!(hex(&encode(&top, &EncodeOptions::default()).unwrap()), "dbfffffffffffffffe00");
    for n in [65535u64, (1 << 32) - 1, u64::MAX] {
        let e = encode(&Value::Tag(n, Box::new(Value::Uint(0))), &EncodeOptions::default()).unwrap_err();
        assert_eq!(e.code(), "tag", "tag {n}");
    }
    // RFC 8746 typed arrays outside the Bindle set: a byte string of whole elements, kept as a Tag.
    let be16 = unhex("d841420001");
    assert_eq!(
        decode(&be16, &DecodeOptions::default()).unwrap(),
        Value::Tag(65, Box::new(Value::Bytes(vec![0, 1])))
    );
    assert_eq!(decode(&unhex("d84143000102"), &DecodeOptions::default()).unwrap_err().code(), "tag");
    // A view reads the whole tag number.
    let view = View::open(&bytes, &DecodeOptions::default()).unwrap();
    assert_eq!(view.value().unwrap(), wide);
}
#[test]
fn group_arena_grows_and_group_limit_at_explicit_cap() {
    // program-2 §9.4 (D313): 1000 T records of 5 words outgrow the 4096-word lease;
    // an explicit groupWords cap below them is group_limit
    let text = "r = {* (tstr => uint // tstr => tstr)}";
    let big = Value::Map(
        (0..1000)
            .map(|i| (Value::Text(format!("k{i:05}")), Value::Uint(i as u64)))
            .collect(),
    );
    let bytes = encode(&big, &EncodeOptions::default()).unwrap();
    let mut scratch = Scratch::new();
    let open = Schema::compile(text, &CompileOptions::default()).unwrap();
    open.validate(&bytes, "r", &mut scratch).unwrap();
    let capped = Schema::compile(
        text,
        &CompileOptions {
            group_words: Some(64),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        capped.validate(&bytes, "r", &mut scratch).unwrap_err().reason,
        "group_limit"
    );
}

#[test]
fn d342_f8_malformed_and_bignum_keys_distinct() {
    // RFC 8949 §3.3: f8 below 32 is not well-formed under every preset
    for h in ["f800", "f805", "f817", "f818", "f81f"] {
        for o in [DecodeOptions::default(), DecodeOptions::deterministic(), DecodeOptions { top: Top::Any, ..DecodeOptions::bindle() }] {
            assert_eq!(decode(&unhex(h), &o).unwrap_err().code(), "malformed", "{h}");
        }
    }
    // RFC 8949 §5.6.1: 1 and 2(h'01') are distinct keys; decode keeps the bignum's bytes
    let m = decode(&unhex("a20100c2410101"), &DecodeOptions::default()).unwrap();
    assert_eq!(
        m,
        Value::Map(vec![
            (Value::Uint(1), Value::Uint(0)),
            (Value::BigInt { negative: false, magnitude: vec![1] }, Value::Uint(1)),
        ])
    );
    // and encodes it as its integer in preferred serialization
    let one = Value::BigInt { negative: false, magnitude: vec![0, 1] };
    assert_eq!(encode(&one, &EncodeOptions::default()).unwrap(), vec![1]);
    // the duplicate check agrees
    let s = Schema::compile("r = { * any => any }", &CompileOptions::default()).unwrap();
    let mut scratch = Scratch::new();
    s.validate(&unhex("a20100c2410101"), "r", &mut scratch).unwrap();
    assert_eq!(
        s.validate(&unhex("a2c2410100c2410101"), "r", &mut scratch).unwrap_err().reason,
        "cbor/duplicate_key"
    );
}

#[test]
fn p916_warnings_cut_subcode_and_root_reexports() {
    // compile warnings reach the public Schema; a loaded Program has none
    let text = "r = { kind: \"a\", x: int // kind: \"b\", y: tstr }";
    let s = Schema::compile(text, &CompileOptions::default()).unwrap();
    let w: &[snug::Warning] = s.warnings();
    assert_eq!(w.len(), 1);
    assert_eq!((w[0].code, w[0].rule.as_deref(), w[0].line), ("W8", Some("r"), 1));
    assert!(Schema::compile("r = uint", &CompileOptions::default()).unwrap().warnings().is_empty());
    assert!(Schema::from_serialized(&s.program().serialize().unwrap()).unwrap().warnings().is_empty());
    // the cut subcode: a key matched a cut member whose value failed, and the cut
    // stopped the alternative that would have matched
    let mut scratch = Scratch::new();
    let kind_b = unhex("a2646b696e6461626179617a"); // {"kind": "b", "y": "z"}
    let e = s.validate(&kind_b, "r", &mut scratch).unwrap_err();
    assert_eq!((e.reason, e.subcode), ("value", Some("cut")));
    let branch = Schema::compile(text, &CompileOptions { cuts: snug::Cuts::Branch, ..Default::default() }).unwrap();
    branch.validate(&kind_b, "r", &mut scratch).unwrap();
    // an ordinary wrong value has no subcode
    let plain = Schema::compile("r = { a: \"x\" }", &CompileOptions::default()).unwrap();
    let e = plain.validate(&unhex("a161616179"), "r", &mut scratch).unwrap_err();
    assert_eq!((e.reason, e.subcode), ("value", None));
    // every type a public signature names is at the crate root
    let _: Option<snug::SchemaError> = None;
    let _: Option<snug::SourceError> = None;
    let _: Option<snug::IoError> = None;
    let _ = (snug::Regexp::Xsd, snug::Cuts::Rfc, snug::AbnfMode::default(), snug::Controls::default());
    let _ = snug::SourceOptions::default();
    match Schema::compile("r = ", &CompileOptions::default()) {
        Err(Error::Compile(e)) => {
            let e: snug::SchemaError = e;
            assert_eq!(e.code, "syntax");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn d348_normalized_bignum_key_collisions_refuse_to_encode() {
    let normalized = |e: Error| (e.code().to_string(), e.subcode());
    // {0: null, 2(h''): null}, {-1: null, 3(h''): null}, and the first nested in a map value
    for h in ["a200f6c240f6", "a220f6c340f6", "a16178a200f6c240f6", "a28100f681c240f6"] {
        let v = decode(&unhex(h), &DecodeOptions::default()).unwrap();
        let e = encode(&v, &EncodeOptions::default()).unwrap_err();
        assert_eq!(normalized(e), ("duplicate_key".into(), Some("normalized")), "{h}");
        // the streaming Writer says the same
        let mut w = Writer::new(&EncodeOptions::default()).unwrap();
        let r = w.value(&v).and_then(|w| w.finish().map(|_| ()));
        assert_eq!(r.map_err(normalized), Err(("duplicate_key".into(), Some("normalized"))), "{h}");
    }
    // a non-preferred bignum key on its own re-encodes as its integer
    let v = decode(&unhex("a1c240f6"), &DecodeOptions::default()).unwrap();
    assert_eq!(encode(&v, &EncodeOptions::default()).unwrap(), unhex("a100f6"));
    // an ordinary duplicate has no subcode
    let dup = Value::Map(vec![(Value::Uint(1), Value::Null), (Value::Uint(1), Value::Null)]);
    assert_eq!(normalized(encode(&dup, &EncodeOptions::default()).unwrap_err()), ("duplicate_key".into(), None));
    // the deterministic preset refuses the non-preferred bignum on decode already
    assert_eq!(decode(&unhex("a200f6c240f6"), &DecodeOptions::deterministic()).unwrap_err().code(), "bignum");
}

/// D351: a Program with `.cbor` re-scans embedded content after the item's canonical copy;
/// that used to overwrite the item's outcome bits, so valid input that is not its own
/// deterministic form lost its copy (a view then walked the raw indefinite bytes) and a
/// map out of canonical order was searched as if sorted.
#[test]
fn regression_d351_embedded_content_keeps_the_items_copy_and_order() {
    let mut s = Scratch::new();
    let v = ValidationOptions::default();
    let indef = [0x5f, 0x41, 0x00, 0x42, 0x01, 0x02, 0xff];
    for src in ["r = bstr", "r = bstr .cbor {a: int} / bstr .size (0..16)"] {
        let schema = Schema::compile(src, &CompileOptions::default()).unwrap();
        let doc = schema.document(&indef, "r", &v, &mut s).unwrap();
        assert_eq!(doc.view().raw(), &[0x43, 0x00, 0x01, 0x02], "{src}");
        assert!(schema.view(&indef, "r", &mut s).is_err(), "{src}: not borrowable");
    }
    // [ {"b": 1, "a": 2}, h'01' ]: keys out of order, then embedded content in order
    let b = [0x82, 0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02, 0x41, 0x01];
    for src in ["r = [ {* tstr => int}, bstr ]", "r = [ {* tstr => int}, bstr .cbor int ]"] {
        let schema = Schema::compile(src, &CompileOptions::default()).unwrap();
        let doc = schema.document(&b, "r", &v, &mut s).unwrap();
        let m = doc.view().at(0).unwrap();
        assert!(m.get("a").is_some() && m.get("b").is_some(), "{src}");
    }
}
