use snug::{CompileOptions, Schema, Scratch};
use snug::compile::Regexp;

#[test]
fn xsd_default_and_explicit_iregexp() {
    let schema = Schema::compile(r#"r = tstr .regexp "[a-z-[aeiou]]+""#, &CompileOptions::default()).unwrap();
    let mut scratch = Scratch::new();
    schema.validate(b"\x62bc", "r", &mut scratch).unwrap();
    assert!(schema.validate(b"\x62ba", "r", &mut scratch).is_err());
    let interop = CompileOptions { regexp: Regexp::IRegexp, ..Default::default() };
    assert!(Schema::compile(r#"r = tstr .regexp "[a-z-[aeiou]]+""#, &interop).is_err());
    let ascii = Schema::compile(r#"r = tstr .regexp "[0-9]+""#, &interop).unwrap();
    ascii.validate(b"\x6212", "r", &mut scratch).unwrap();
}

#[test]
fn names_need_no_tables_and_categories_opt_in() {
    let names = Schema::compile(r#"r = tstr .regexp "\\i\\c*""#, &CompileOptions::default()).unwrap();
    names.validate(b"\x62:x", "r", &mut Scratch::new()).unwrap();
    assert!(Schema::compile(r#"r = tstr .regexp "\\d""#, &CompileOptions::default()).is_err());
    let tables = snug::unicode_tables::tables();
    let options = CompileOptions { unicode: Some(&tables), ..Default::default() };
    let digit = Schema::compile(r#"r = tstr .regexp "\\d""#, &options).unwrap();
    digit.validate(b"\x62\xd9\xa3", "r", &mut Scratch::new()).unwrap();
    let error = Schema::compile(r#"r = tstr .regexp "\\p{IsBasicLatin}""#, &options).unwrap_err();
    assert_eq!(error.code(), "regexp");
}
