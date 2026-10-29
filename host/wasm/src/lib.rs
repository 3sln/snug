//! snug's wasm exports for the P1.4 comparison: the generated scanner behind a
//! plain integer ABI (no wasm-bindgen, no imports, no allocator). The host
//! copies the input into the static buffer at `snug_buf()` (capacity
//! `snug_cap()`, 2 MiB: above the profile's 1,500,000-byte default bound) and
//! calls `snug_scan(len, ...)`.
#![allow(dead_code)]
pub mod snug;

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicI32, Ordering};

const CAP: usize = 2 << 20;
struct Buf(UnsafeCell<[u8; CAP]>);
// wasm32-unknown-unknown is single-threaded; the host never re-enters.
unsafe impl Sync for Buf {}
static BUF: Buf = Buf(UnsafeCell::new([0; CAP]));
static ERR: AtomicI32 = AtomicI32::new(-1);

/// Where the host writes the input.
#[no_mangle]
pub extern "C" fn snug_buf() -> *mut u8 {
    BUF.0.get() as *mut u8
}

/// The input buffer's capacity in bytes.
#[no_mangle]
pub extern "C" fn snug_cap() -> usize {
    CAP
}

/// Scan the first `len` bytes of the buffer: 0 or a profile code
/// (docs/scanner.md). A `len` above the capacity is refused as `too_large`
/// (20) without reading.
#[no_mangle]
pub extern "C" fn snug_scan(len: usize, top_any: i32, cose: i32, max_bytes: i32, max_depth: i32,
                            max_entries: i32, max_items: i32) -> i32 {
    if len > CAP {
        ERR.store(0, Ordering::Relaxed);
        return 20;
    }
    // SAFETY: single-threaded; the host only writes the buffer between calls.
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(BUF.0.get() as *const u8, len) };
    let mut o = [0i32; 16];
    snug::cbor::scan::scan_options(&mut o, top_any, cose, max_bytes, max_depth, max_entries, max_items);
    let c = snug::cbor::scan::scan(bytes, &mut o);
    ERR.store(snug::cbor::scan::error_offset(&mut o), Ordering::Relaxed);
    c
}

/// The error offset of the last `snug_scan` (-1 when it accepted).
#[no_mangle]
pub extern "C" fn snug_err() -> i32 {
    ERR.load(Ordering::Relaxed)
}
