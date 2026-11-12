//! P7.9 (D005 re-take): the CDDL compiler as its own wasm module, loaded
//! lazily by host/wasm-sdk as the JS package loads its compiler chunk. Plain
//! integer ABI, no imports. host/rust/src/compile.rs (the Rust host's loop:
//! arena, D020 float port, SOURCE_KEY digest) is reused unchanged; the
//! extension-control registry (D141) arrives as kin's registry words after the
//! 22 option words (format 2.0 adds the cut mode and the arena cap), and the
//! optional Unicode tables (D110) as words too.
//! Control arguments are checked by the SDK in JS afterwards (D142), as the
//! native host does, so no import is needed here.
use crate::compile::{compile_bytes_with_options, snug_version, CompileOptions, Compiled, Registry, SchemaError};
use std::cell::UnsafeCell;

struct State {
    text: Vec<u8>,
    /// [profile, 18 limits in COMPILE_OPTIONS order (-1 = default), regexp dialect, registry words...]
    opt: Vec<i32>,
    unicode: Vec<i32>,
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
    s.get_or_insert_with(|| State { text: Vec::new(), opt: vec![-1; 20], unicode: Vec::new(), result: None, info: [0; 8] })
}

/// The registry words as compile.rs's Registry (arguments are the SDK's to check).
struct Words<'a>(&'a [i32]);
impl Registry for Words<'_> {
    fn words(&self) -> Vec<i32> { self.0.to_vec() }
    fn argument_ok(&self, _name: &str, _argument: &[u8]) -> bool { true }
}

/// The schema text buffer, at least n bytes.
#[no_mangle]
pub extern "C" fn cc_text(n: usize) -> *mut u8 {
    let s = st();
    if s.text.len() < n { s.text.resize(n, 0); }
    s.text.as_mut_ptr()
}
/// The option words, n >= 20 of them: [profile, then the 18 limits in
/// COMPILE_OPTIONS order, -1 = default, then the registry words (D141)].
#[no_mangle]
pub extern "C" fn cc_opt(n: usize) -> *mut i32 {
    let s = st();
    s.opt.clear();
    s.opt.resize(n.max(20), -1);
    s.opt.as_mut_ptr()
}
/// The Unicode table words (D110), n of them (0: none).
#[no_mangle]
pub extern "C" fn cc_unicode(n: usize) -> *mut i32 {
    let s = st();
    s.unicode.clear();
    s.unicode.resize(n, 0);
    s.unicode.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn cc_info() -> *mut i32 {
    st().info.as_mut_ptr()
}
/// Compile text[0..n): 0, or 1 for a SchemaError. Then cc_program/cc_pool
/// (lengths in INFO[0], INFO[1]) or cc_error.
#[no_mangle]
pub extern "C" fn cc_compile(n: usize) -> i32 {
    let s = st();
    let registry = Words(s.opt.get(22..).unwrap_or(&[]));
    let options = CompileOptions {
        profile: s.opt[0],
        regexp: if s.opt[19] == 1 { crate::compile::Regexp::IRegexp } else { crate::compile::Regexp::Xsd },
        // D301: option word 20 is 0 (or -1, absent) for the default literal RFC cut, 1 for rule A
        cuts: if s.opt.get(20) == Some(&1) { crate::compile::Cuts::Branch } else { crate::compile::Cuts::Rfc },
        group_words: s.opt.get(21).copied().filter(|&g| g >= 0),
        limits: &s.opt[1..19],
        unicode: if s.unicode.is_empty() { None } else { Some(&s.unicode) },
        controls: if s.opt.len() > 22 { Some(&registry) } else { None },
        // D340: the SDK's registry words already carry the ABNF parse mode (flags bit 1)
        abnf: if s.opt.get(23).map_or(false, |f| f & 2 != 0) { crate::compile::AbnfMode::Lenient } else { crate::compile::AbnfMode::Strict },
    };
    let r = compile_bytes_with_options(&s.text[..n], &options);
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
/// The error: a buffer holding the code name, the rule name, then the detail
/// (D141: an unknown control's name). INFO: code length, line, column, rule
/// length (-1 none), detail length (-1 none), 1 when Unicode tables were needed
/// (2 block data, 3 the ABNF controls, D334).
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
        match &e.detail {
            Some(d) => { buf.extend_from_slice(d.as_bytes()); s.info[4] = d.len() as i32; }
            None => s.info[4] = -1,
        }
        s.info[5] = if e.message.contains("block data") { 2 } else if e.message.contains("ABNF controls") { 3 }
            else { e.message.contains("unicode_tables") as i32 };
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
    s.unicode = Vec::new();
}
/// P9.16: the last successful compile's warnings as JSON text, `[{"code", "rule"
/// (null for none), "line", "column", "message"}]` in the native order; its length
/// in INFO[0]. Read before cc_release (it reuses the text buffer, as cc_error).
#[no_mangle]
pub extern "C" fn cc_warnings() -> *const u8 {
    fn js(out: &mut String, s: &str) {
        out.push('"');
        for ch in s.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
    }
    let s = st();
    let mut j = String::from("[");
    if let Some(Ok(c)) = &s.result {
        for (i, w) in c.warnings.iter().enumerate() {
            if i > 0 {
                j.push(',');
            }
            j.push_str("{\"code\":");
            js(&mut j, w.code);
            j.push_str(",\"rule\":");
            match &w.rule {
                Some(r) => js(&mut j, r),
                None => j.push_str("null"),
            }
            j.push_str(&format!(",\"line\":{},\"column\":{},\"message\":", w.line, w.column));
            js(&mut j, w.message);
            j.push('}');
        }
    }
    j.push(']');
    s.text.clear();
    s.text.extend_from_slice(j.as_bytes());
    s.info[0] = s.text.len() as i32;
    s.text.as_ptr()
}
/// kin's snug version string; its length in INFO[0].
#[no_mangle]
pub extern "C" fn cc_version() -> *const u8 {
    let v = snug_version();
    st().info[0] = v.len() as i32;
    v.as_ptr()
}
