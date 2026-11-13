//! P7.2: the generic extension controls on the Rust host check the table the JS
//! host checks (tests/controls.json; host/js/test/controls.test.mjs), and the
//! public API binds, refuses and serialises Programs that use controls.
use snug::controls::{Chars, Control, Controls, Samelen, Unique};
use snug::{CompileOptions, CompilerProfile, Program, Schema, Scratch};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}
fn field<'a>(line: &'a str, name: &str) -> &'a str {
    let key = format!("\"{}\":", name);
    let at = line.find(&key).unwrap() + key.len();
    let rest = &line[at..];
    let end = rest.find([',', '}']).unwrap();
    rest[..end].trim_matches('"')
}

#[test]
fn generic_controls_match_the_shared_table() {
    let table = include_str!("controls.json");
    let mut n = 0;
    for line in table.lines().filter(|l| l.contains("\"control\"")) {
        let (c, a, item, want) = (field(line, "control"), unhex(field(line, "argument")), unhex(field(line, "item")), field(line, "expect") == "true");
        let got = match c {
            "chars" => Chars.check(&a, &item),
            "unique" => Unique.check(&a, &item),
            "samelen" => Samelen.check(&a, &item),
            _ => panic!("control {}", c),
        };
        assert_eq!(got, want, "{}", line);
        n += 1;
    }
    assert!(n >= 40);
}

#[test]
fn compile_validate_serialise_and_refuse() {
    let controls = Controls::generic();
    let opts = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
    let schema = Schema::compile("r = (tstr .chars (1..3)) / (tstr .size 10)\nu = [* int] .unique true", &opts).unwrap();
    let mut s = Scratch::new();
    assert!(schema.validate(&[0x62, b'a', b'b'], "r", &mut s).is_ok());
    let e = schema.validate(&[0x64, b'a', b'b', b'c', b'd'], "r", &mut s).unwrap_err();
    assert_eq!(e.reason, "control");
    assert!(schema.validate(b"\x6a0123456789", "r", &mut s).is_ok());
    assert_eq!(schema.validate(&[0x82, 1, 1], "u", &mut s).unwrap_err().reason, "control");
    assert_eq!(schema.program().controls(), vec!["chars", "unique"]);
    assert_eq!(schema.program().words()[1], 2);  // format 2.0 (D279, D318) carries 1.1's control table

    // an unregistered control names itself
    let err = Schema::compile("r = tstr .nope 1", &opts).unwrap_err();
    assert_eq!(err.code(), "unknown_control");
    match err {
        snug::Error::Compile(c) => assert_eq!(c.detail.as_deref(), Some("nope")),
        other => panic!("{:?}", other),
    }
    // D354: the refusal's detail (compile.rs check_arguments) is the control's name when it
    // gives no detail, and "{name} argument: {detail}" when it does (abnf.rs), byte for byte
    match Schema::compile("r = tstr .chars \"x\"", &opts).unwrap_err() {
        snug::Error::Compile(c) => {
            assert_eq!(c.code, "control_value");
            assert_eq!(c.detail.as_deref(), Some("chars"));
        }
        other => panic!("{:?}", other),
    }

    // serialised Programs need the registry again
    let bytes = schema.program().serialize().unwrap();
    match Program::deserialize(&bytes) {
        Err(snug::Error::MissingControls(names)) => assert_eq!(names, vec!["chars", "unique"]),
        other => panic!("{:?}", other.map(|_| ())),
    }
    let loaded = Schema::from_serialized_with(&bytes, &controls).unwrap();
    assert!(loaded.validate(&[0x63, b'a', b'b', b'c'], "r", &mut s).is_ok());

    // the bus profile refuses them unless admitted
    let bus = CompileOptions { profile: CompilerProfile::Bus, controls: Some(&controls), ..CompileOptions::default() };
    assert_eq!(Schema::compile("r = (tstr .size (0..9)) .chars 2", &bus).unwrap_err().code(), "profile");
    let mut admitted = controls.clone();
    admitted.in_bus = true;
    let bus2 = CompileOptions { profile: CompilerProfile::Bus, controls: Some(&admitted), ..CompileOptions::default() };
    assert!(Schema::compile("r = (tstr .size (0..9)) .chars 2", &bus2).is_ok());
}

#[test]
fn closures_are_controls_and_max_bytes_bounds_the_item() {
    struct Short;
    impl Control for Short {
        fn check(&self, _a: &[u8], _item: &[u8]) -> bool { true }
        fn max_bytes(&self) -> u32 { 4 }
    }
    let controls = Controls::new().with("short", Short).with("even", |_a: &[u8], item: &[u8]| item.len() % 2 == 0);
    let opts = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
    let schema = Schema::compile("r = [* (tstr .short 0)]\ne = bstr .even 0", &opts).unwrap();
    let mut s = Scratch::new();
    assert!(schema.validate(&[0x81, 0x63, b'a', b'b', b'c'], "r", &mut s).is_ok());
    assert_eq!(schema.validate(&[0x81, 0x68, b'a', b'b', b'c', b'd', b'e', b'f', b'g', b'h'], "r", &mut s).unwrap_err().reason, "control_size");
    assert!(schema.validate(&[0x41, 0], "e", &mut s).is_ok());
    assert_eq!(schema.validate(&[0x40], "e", &mut s).unwrap_err().reason, "control");
}
