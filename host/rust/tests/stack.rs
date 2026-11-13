//! D357: every input-depth and schema-depth path runs on a 2 MiB thread (Rust's
//! spawned-thread default) at the default limits AND at the depth ceilings, in
//! debug and release builds (bb rust-api-test runs this file in both), whatever
//! the toolchain's frame sizes. An overflow aborts the test process, so the gate
//! fails rather than passing on a lucky toolchain.
use snug::{
    decode, encode, CompileLimits, CompileOptions, Cursor, DecodeOptions, Document, EncodeOptions,
    Schema, Scratch, ValidationOptions, Value, View,
};

const STACK: usize = 2 * 1024 * 1024;
/// The documented ceilings (guide "Limits"): depth 256, parser nesting 256.
const DEPTH_CEILING: usize = 256;
const NEST_CEILING: u32 = 256;
/// The defaults: depth 32, parser nesting 64.
const DEPTH_DEFAULT: usize = 32;
const NEST_DEFAULT: u32 = 64;

fn on_small_stack(name: &str, f: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .name(name.into())
        .stack_size(STACK)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap_or_else(|_| panic!("{name} panicked"));
}
fn nested_array(n: usize) -> Vec<u8> {
    let mut v = vec![0x81; n];
    v.push(0);
    v
}
fn nested_map(n: usize) -> Vec<u8> {
    // {"a": {"a": ... 0}}
    let mut v = Vec::new();
    for _ in 0..n {
        v.extend_from_slice(&[0xa1, 0x61, 0x61]);
    }
    v.push(0);
    v
}
fn nested_tag(n: usize) -> Vec<u8> {
    // a tag level per level (an unassigned tag number the valid preset admits)
    let mut v = Vec::new();
    for _ in 0..n {
        v.extend_from_slice(&[0xd9, 0x01, 0x00]);
    }
    v.push(0);
    v
}
fn nested_value(n: usize) -> Value {
    let mut v = Value::Uint(0);
    for _ in 0..n {
        v = Value::Array(vec![v]);
    }
    v
}
fn schema(text: &str, depth: usize, nesting: u32) -> Schema {
    let options = CompileOptions {
        limits: CompileLimits {
            depth: Some(depth as u32),
            nesting: Some(nesting),
            ..Default::default()
        },
        ..Default::default()
    };
    Schema::compile(text, &options).unwrap_or_else(|e| panic!("{text:.40}: {e}"))
}
fn input_paths(depth: usize) {
    let options = DecodeOptions {
        max_depth: Some(depth as u32),
        ..DecodeOptions::any()
    };
    for bytes in [nested_array(depth), nested_map(depth), nested_tag(depth)] {
        // decode, then encode the decoded tree back to the same bytes
        let value = decode(&bytes, &options).unwrap();
        let again = encode(
            &value,
            &EncodeOptions {
                max_depth: options.max_depth,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(again, bytes);
        // one level more is refused, not a crash
        let mut deeper = bytes.clone();
        deeper.insert(0, 0x81);
        assert_eq!(decode(&deeper, &options).unwrap_err().code(), "depth");
        // views: open, walk the cursor to the bottom, build the value from a view
        let document = Document::open(&bytes, &options).unwrap();
        let mut cursor: Cursor<'_> = document.view().cursor();
        let mut levels = 0;
        while cursor.enter() {
            levels += 1;
            while cursor.next() {}
        }
        assert!(levels >= depth);
        let view = View::open(&bytes, &options).unwrap();
        assert_eq!(view.value().unwrap(), value);
        // validation against `any` and against a schema that keeps every level live
        let any = schema("r = any", depth, NEST_DEFAULT);
        any.validate(&bytes, "r", &mut Scratch::new()).unwrap();
        let live = schema(
            "r = [r] / {a: r} / #6.256(r) / uint",
            depth,
            NEST_DEFAULT,
        );
        live.validate(&bytes, "r", &mut Scratch::new()).unwrap();
        assert_eq!(live.decode(&bytes, "r", &mut Scratch::new()).unwrap(), value);
        let tight = ValidationOptions {
            max_depth: Some(depth as u32 - 1),
            ..Default::default()
        };
        assert_eq!(
            live.validate_with_options(&bytes, "r", &tight, &mut Scratch::new())
                .unwrap_err()
                .reason,
            "cbor/depth"
        );
        drop(value);
    }
    // a caller-built tree at the depth: encode, then drop it
    let value = nested_value(depth);
    encode(
        &value,
        &EncodeOptions {
            max_depth: Some(depth as u32),
            ..Default::default()
        },
    )
    .unwrap();
    drop(value);
}
fn schema_paths(nesting: u32) {
    // Each form at the deepest it compiles under `nesting` (its next level is
    // `limit_nesting`, not a crash), so every form meets the limit exactly.
    let options = CompileOptions {
        limits: CompileLimits {
            depth: Some(DEPTH_CEILING as u32),
            nesting: Some(nesting),
            ..Default::default()
        },
        ..Default::default()
    };
    for (open, close) in [("[", "]"), ("{a: ", "}"), ("[* ", "]"), ("(", ")"), ("[[", "]]")] {
        let text = |k: usize| format!("r = {}uint{}", open.repeat(k), close.repeat(k));
        let mut k = nesting as usize;
        let s = loop {
            match Schema::compile(&text(k), &options) {
                Ok(s) => break s,
                Err(e) => {
                    assert!(e.to_string().contains("limit_nesting"), "{open}: {e}");
                    k -= 1;
                }
            }
        };
        assert!(k > 0, "{open}: nothing compiles");
        // the matching input, validated
        let levels = k * open.matches(['[', '{']).count();
        let bytes = if open.starts_with('{') {
            nested_map(levels)
        } else {
            nested_array(levels)
        };
        if open != "(" {
            s.validate(&bytes, "r", &mut Scratch::new()).unwrap();
        }
    }
}

#[test]
fn input_depth_default_on_2mib() {
    on_small_stack("input-default", || input_paths(DEPTH_DEFAULT));
}
#[test]
fn input_depth_ceiling_on_2mib() {
    on_small_stack("input-ceiling", || input_paths(DEPTH_CEILING));
}
#[test]
fn schema_nesting_default_on_2mib() {
    on_small_stack("schema-default", || schema_paths(NEST_DEFAULT));
}
#[test]
fn schema_nesting_ceiling_on_2mib() {
    on_small_stack("schema-ceiling", || schema_paths(NEST_CEILING));
}
