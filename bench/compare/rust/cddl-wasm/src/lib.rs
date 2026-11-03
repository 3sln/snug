//! The `cddl` crate (0.10.7) built for wasm32 with a plain integer ABI (P7.8). Same crate, features and parse/validate
//! calls as the 3sln.me study's binding (corpus/cddl-study/oracle-binding: pest parser, target rule moved first,
//! `decode_cbor` then `CBORValidator`), but no wasm-bindgen glue and no JSON result string: a validate call returns
//! 1 (valid), 0 (invalid), -1 (CBOR decode error), -2 (other error). That makes each call slightly cheaper than the
//! study binding's. The crate's own wasm-bindgen exports are linked in (its `std` feature pulls wasm-bindgen) but
//! never called; the harness stubs their imports.
use cddl::ast::{Rule, CDDL};
use cddl::validator::cbor::{self, CBORValidator};
use cddl::validator::cbor_value::decode_cbor;
use cddl::validator::Validator;
use std::cell::RefCell;

struct Compiled {
    _src: &'static str,
    ast: CDDL<'static>,
}

thread_local! {
    static HANDLES: RefCell<Vec<Option<Box<Compiled>>>> = RefCell::new(vec![None]);
}

#[no_mangle]
pub extern "C" fn cw_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p`/`n` must come from `cw_alloc(n)`.
#[no_mangle]
pub unsafe extern "C" fn cw_free(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n.max(1)));
}

/// Parse CDDL text with `rule` moved first (the crate validates against the first rule). 0 = parse error / no rule.
///
/// # Safety
/// The pointers must address `tn` and `rn` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn cw_compile(tp: *const u8, tn: usize, rp: *const u8, rn: usize) -> u32 {
    let text = std::str::from_utf8(std::slice::from_raw_parts(tp, tn)).unwrap_or("");
    let rule = std::str::from_utf8(std::slice::from_raw_parts(rp, rn)).unwrap_or("");
    let src: &'static str = Box::leak(text.to_string().into_boxed_str());
    let mut ast = match cddl::pest_bridge::cddl_from_pest_str_checked(src) { Ok(a) => a, Err(_) => return 0 };
    let idx = ast.rules.iter().position(|r| matches!(r, Rule::Type { rule: tr, .. } if tr.name.ident == rule && tr.generic_params.is_none()));
    let Some(idx) = idx else { return 0 };
    let r = ast.rules.remove(idx);
    ast.rules.insert(0, r);
    HANDLES.with(|h| {
        let mut h = h.borrow_mut();
        h.push(Some(Box::new(Compiled { _src: src, ast })));
        (h.len() - 1) as u32
    })
}

/// # Safety
/// `p` must address `n` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn cw_validate(handle: u32, p: *const u8, n: usize) -> i32 {
    let bytes = std::slice::from_raw_parts(p, n);
    HANDLES.with(|h| {
        let h = h.borrow();
        let Some(Some(c)) = h.get(handle as usize) else { return -2 };
        let value = match decode_cbor(bytes) { Ok(v) => v, Err(_) => return -1 };
        let mut cv = CBORValidator::new(&c.ast, value, None);
        match Validator::<cbor::Error<std::io::Error>>::validate(&mut cv) {
            Ok(()) => 1,
            Err(cbor::Error::Validation(_)) => 0,
            Err(_) => -2,
        }
    })
}
