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

// P6.1: the resumable scanner over the whole buffer as one window (the §17.4
// comparison). A static per-module session: maxDepth up to 64, keys up to
// the 2 MiB buffer.
const RS_WORDS: usize = 24 + 64 * 28 + (CAP >> 2) + 2;
struct Scratch(UnsafeCell<[i32; RS_WORDS]>);
unsafe impl Sync for Scratch {}
static RS: Scratch = Scratch(UnsafeCell::new([0; RS_WORDS]));

/// Resumable scan of the first `len` buffer bytes as ONE window: 0, a code, or
/// -1/-2 (never, for a whole window without a quantum). maxDepth must be <= 64.
#[no_mangle]
pub extern "C" fn snug_rscan(len: usize, top_any: i32, cose: i32, max_bytes: i32, max_depth: i32,
                             max_entries: i32, max_items: i32) -> i32 {
    if len > CAP || !(0..=64).contains(&max_depth) {
        ERR.store(0, Ordering::Relaxed);
        return 20;
    }
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(BUF.0.get() as *const u8, len) };
    // SAFETY: single-threaded; no other reference to RS exists during the call.
    let s: &mut [i32] = unsafe { &mut *RS.0.get() };
    let mut o = [0i32; 16];
    snug::cbor::scan::scan_options(&mut o, top_any, cose, max_bytes, max_depth, max_entries, max_items);
    snug::cbor::rscan::rscan_init(&mut o, s, len as i32, 0);
    let c = snug::cbor::rscan::rscan_step(bytes, &mut o, s, 0, 0);
    ERR.store(snug::cbor::scan::error_offset(&mut o), Ordering::Relaxed);
    c
}

/// The error offset of the last `snug_scan` (-1 when it accepted).
#[no_mangle]
pub extern "C" fn snug_err() -> i32 {
    ERR.load(Ordering::Relaxed)
}
