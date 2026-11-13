//! D361: `use snug::*;` brings the crate root's items in without meeting a module
//! named `snug` (it used to be E0659, ambiguous with the crate itself).
use snug::*;

#[test]
fn a_glob_import_of_the_crate_root_resolves() {
    let schema = Schema::compile("r = [* uint]", &CompileOptions::default()).unwrap();
    schema.validate(&[0x81, 0x01], "r", &mut Scratch::new()).unwrap();
    let bytes = encode(&Value::Uint(7), &EncodeOptions::default()).unwrap();
    assert_eq!(decode(&bytes, &DecodeOptions { wire: Profile::DETERMINISTIC, ..DecodeOptions::default() }).unwrap(), Value::Uint(7));
    assert_eq!(snug::decode(&bytes, &DecodeOptions::default()).unwrap(), Value::Uint(7));
}
