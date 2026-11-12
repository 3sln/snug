//! P9.14 (D334): `.abnf` / `.abnfb` through the public Rust API. The engine's verdicts
//! and charges are compared with JS whole by `bb abnf-test`; this checks the binding:
//! the optional registry entries, compile-time refusals, the item bound, budget and
//! serialised Programs.
use snug::abnf::{check_abnf, Abnf};
use snug::controls::Controls;
use snug::{CompileOptions, Program, Schema, Scratch, ValidationOptions};

fn text(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut v = match b.len() {
        n if n < 24 => vec![0x60 | n as u8],
        n if n < 256 => vec![0x78, n as u8],
        n if n < 65536 => vec![0x79, (n >> 8) as u8, n as u8],
        n => {
            let mut h = vec![0x7a];
            h.extend((n as u32).to_be_bytes());
            h
        }
    };
    v.extend_from_slice(b);
    v
}

#[test]
fn without_the_module_and_with_it() {
    let err = Schema::compile("r = text .abnf \"x\"", &CompileOptions::default()).unwrap_err();
    assert_eq!(err.code(), "unsupported_control");
    assert!(err.to_string().contains("unsupported_control"));
    match &err {
        snug::Error::Compile(c) => assert!(c.message.contains("ABNF controls")),
        other => panic!("{:?}", other),
    }
    let controls = Controls::generic().with_abnf();
    let opts = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
    let schema = Schema::compile(
        "date = text .abnf \"4DIGIT \\\"-\\\" 2DIGIT \\\"-\\\" 2DIGIT\\nDIGIT = %x30-39\"\n\
         oid = bytes .abnfb 'oid\noid = 1*arc\nroid = *arc\narc = [nlsb] %x00-7f\nnlsb = %x81-ff *%x80-ff\n'",
        &opts,
    )
    .unwrap();
    let mut s = Scratch::new();
    assert!(schema.validate(&text("2024-01-31"), "date", &mut s).is_ok());
    assert_eq!(schema.validate(&text("2024-1-31"), "date", &mut s).unwrap_err().reason, "control");
    assert!(schema.validate(&[0x41, 0x00], "oid", &mut s).is_ok());
    assert_eq!(schema.validate(&[0x40], "oid", &mut s).unwrap_err().reason, "control");
    assert_eq!(schema.validate(&[0x41, 0x81], "oid", &mut s).unwrap_err().reason, "control");
    assert_eq!(schema.program().controls(), vec!["abnf", "abnfb"]);
}

#[test]
fn refusals_name_the_abnf_place() {
    let controls = Controls::new().with_abnf();
    let opts = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
    let err = Schema::compile("r = text .abnf \"a\\na = \\\"x\\\" / <later>\"", &opts).unwrap_err();
    assert_eq!(err.code(), "control_value");
    match err {
        snug::Error::Compile(c) => assert_eq!(c.detail.as_deref(),
            Some("abnf argument: prose-val (<...>) is not supported at ABNF line 2, column 11")),
        other => panic!("{:?}", other),
    }
    assert!(check_abnf("1*DIGIT").unwrap_err().starts_with("undefined rule"));
    assert_eq!(check_abnf("a\na = a \"x\" / \"\""), Ok(()));
    // valid ABNF that matches nothing (RFC 5234 §4 admits both; D334)
    assert_eq!(check_abnf("3*2\"a\""), Ok(()));
    assert_eq!(check_abnf("%x39-30"), Ok(()));
    assert!(check_abnf("a\na = \"x\"\nA = \"y\"").unwrap_err().starts_with("rule defined twice"));
}

#[test]
fn budget_item_bound_and_serialised_programs() {
    let controls = Controls::new().with_abnf();
    let opts = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
    let schema = Schema::compile("r = text .abnf \"a\\na = a a / \\\"x\\\" / \\\"\\\"\"", &opts).unwrap();
    let mut s = Scratch::new();
    assert_eq!(schema.validate(&text(&"x".repeat(300)), "r", &mut s).unwrap_err().reason, "budget");
    assert!(schema.validate(&text("xxxx"), "r", &mut s).is_ok());
    let small = ValidationOptions { budget: Some(20), ..ValidationOptions::default() };
    assert_eq!(schema.validate_with_options(&text("xxxx"), "r", &small, &mut s).unwrap_err().reason, "budget");

    let star = Schema::compile("r = text .abnf \"*%x61\"", &opts).unwrap();
    let long = text(&"a".repeat(70000));
    let roomy = ValidationOptions { budget: Some(100_000_000), ..ValidationOptions::default() };
    assert_eq!(star.validate_with_options(&long, "r", &roomy, &mut s).unwrap_err().reason, "control_size");
    let mut wide = Controls::new();
    wide.insert_abnf(Abnf::text().with_max_bytes(1 << 20));
    let wopts = CompileOptions { controls: Some(&wide), ..CompileOptions::default() };
    let big = Schema::compile("r = text .abnf \"*%x61\"", &wopts).unwrap();
    assert!(big.validate_with_options(&long, "r", &roomy, &mut s).is_ok());

    // the matcher scratch cap is the host's: past it, budget
    let mut tight = Controls::new();
    tight.insert_abnf(Abnf::text().with_max_words(65536));
    let topts = CompileOptions { controls: Some(&tight), ..CompileOptions::default() };
    let amb = "r = text .abnf \"*(%x61 / %x61 %x61)\"";
    let doc = text(&"a".repeat(3000));
    assert_eq!(Schema::compile(amb, &topts).unwrap().validate_with_options(&doc, "r", &roomy, &mut s).unwrap_err().reason, "budget");
    assert!(Schema::compile(amb, &opts).unwrap().validate_with_options(&doc, "r", &roomy, &mut s).is_ok());

    let bytes = star.program().serialize().unwrap();
    match Program::deserialize(&bytes) {
        Err(snug::Error::MissingControls(names)) => assert_eq!(names, vec!["abnf".to_owned()]),
        other => panic!("{:?}", other.map(|_| ())),
    }
    let again = Schema::from_serialized_with(&bytes, &controls).unwrap();
    assert!(again.validate(&text("aaa"), "r", &mut s).is_ok());
    assert_eq!(again.validate(&text("ab"), "r", &mut s).unwrap_err().reason, "control");
}
