//! P7.9 (D005 re-take): the CDDL compiler as its own wasm module, loaded
//! lazily by host/wasm-sdk as the JS package loads its compiler chunk. Plain
//! integer ABI, no imports. host/rust/src/compile.rs (the Rust host's loop:
//! arena, D020 float port, SOURCE_KEY digest) is reused unchanged.
use crate::compile::{compile_bytes, snug_version, Compiled, SchemaError};
use std::cell::UnsafeCell;

struct State {
    text: Vec<u8>,
    opt: [i32; 19],
    result: Option<Result<Compiled, SchemaError>>,
    info: [i32; 8],
}
struct Cell(UnsafeCell<Option<State>>);
// wasm32-unknown-unknown is single-threaded and the host never re-enters.
unsafe impl Sync for Cell {}
static STATE: Cell = Cell(UnsafeCell::new(None));

fn st() -> &'static mut State {
    // SAFETY: single-threaded; each export holds it only for its own duration.
    let s = unsafe { &mut *STATE.0.get() };
    s.get_or_insert_with(|| State { text: Vec::new(), opt: [-1; 19], result: None, info: [0; 8] })
}

/// The schema text buffer, at least n bytes.
#[no_mangle]
pub extern "C" fn cc_text(n: usize) -> *mut u8 {
    let s = st();
    if s.text.len() < n { s.text.resize(n, 0); }
    s.text.as_mut_ptr()
}
/// The option words: [profile, then the 18 limits in COMPILE_OPTIONS order, -1 = default].
#[no_mangle]
pub extern "C" fn cc_opt() -> *mut i32 {
    st().opt.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn cc_info() -> *mut i32 {
    st().info.as_mut_ptr()
}
/// Compile text[0..n): 0, or 1 for a SchemaError. Then cc_program/cc_pool
/// (lengths in INFO[0], INFO[1]) or cc_error (INFO: name length, line,
/// column, rule start, rule length; the rule name follows the code name).
#[no_mangle]
pub extern "C" fn cc_compile(n: usize) -> i32 {
    let s = st();
    let r = compile_bytes(&s.text[..n], s.opt[0], &s.opt[1..]);
    let code = if r.is_ok() { 0 } else { 1 };
    s.result = Some(r);
    code
}
#[no_mangle]
pub extern "C" fn cc_program() -> *const i32 {
    let s = st();
    match &s.result {
        Some(Ok(c)) => { s.info[0] = c.program.len() as i32; s.info[1] = c.pool.len() as i32; c.program.as_ptr() }
        _ => std::ptr::null(),
    }
}
#[no_mangle]
pub extern "C" fn cc_pool() -> *const u8 {
    match &st().result { Some(Ok(c)) => c.pool.as_ptr(), _ => std::ptr::null() }
}
/// The error: a buffer holding the code name then the rule name.
#[no_mangle]
pub extern "C" fn cc_error() -> *const u8 {
    let s = st();
    let mut buf = Vec::new();
    if let Some(Err(e)) = &s.result {
        buf.extend_from_slice(e.code.as_bytes());
        s.info[0] = e.code.len() as i32;
        s.info[1] = e.line;
        s.info[2] = e.column;
        match &e.rule {
            Some(r) => { buf.extend_from_slice(r.as_bytes()); s.info[3] = r.len() as i32; }
            None => s.info[3] = -1,
        }
    }
    s.text.clear();
    s.text.extend_from_slice(&buf);
    s.text.as_ptr()
}
/// Drop the last result and the text buffer.
#[no_mangle]
pub extern "C" fn cc_release() {
    let s = st();
    s.result = None;
    s.text = Vec::new();
}
/// kin's snug version string; its length in INFO[0].
#[no_mangle]
pub extern "C" fn cc_version() -> *const u8 {
    let v = snug_version();
    st().info[0] = v.len() as i32;
    v.as_ptr()
}
