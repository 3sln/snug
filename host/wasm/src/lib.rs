//! snug's wasm exports for the P1.4 comparison: the generated scanner behind a
//! plain integer ABI (no wasm-bindgen, no imports, no allocator). The host
//! copies the input into the static buffer at `snug_buf()` (capacity
//! `snug_cap()`, 2 MiB: above the profile's 1,500,000-byte default bound) and
//! calls `snug_scan(len, ...)`.
#![allow(dead_code)]
pub mod snug;

// P7.9 (D005 re-take): the SDK runtime exports (sdk.rs, growable memory) and
// the compiler module (cc.rs over host/rust/src/compile.rs), each its own
// build (`kin/scripts/wasm-build sdk|sdk-size|cc`, cargo features). The
// default build is the P1.4/P3.4 module below, unchanged.
#[cfg(feature = "sdk")]
mod sdk;
#[cfg(feature = "compiler")]
pub mod compile;
#[cfg(feature = "compiler")]
pub mod sha256;
#[cfg(feature = "compiler")]
mod cc;

#[cfg(not(any(feature = "sdk", feature = "compiler")))]
pub use legacy::*;
#[cfg(not(any(feature = "sdk", feature = "compiler")))]
mod legacy {
use crate::snug;

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

// P3.4: the validator VM behind the same plain integer ABI. The host writes a
// verified Program into `snug_prog_buf()` (words) and its pool into
// `snug_pool_buf()`, calls `snug_vm_load(words, bytes)`, then per call writes
// the input into `snug_buf()` and the 8 limit words into `snug_lim_buf()` and
// calls `snug_vm_validate(len, rule)`; the out words (program.md §13.2) are at
// `snug_out_buf()`. One static scratch, shared by every Program, its mark
// capacity only ever growing (program.md §13.1).
const PCAP: usize = 1 << 20;
const BCAP: usize = 1 << 20;
const SCAP: usize = 1 << 21;
const OUTW: usize = 8 + 2 * 257;
struct Words<const N: usize>(UnsafeCell<[i32; N]>);
unsafe impl<const N: usize> Sync for Words<N> {}
struct Bytes<const N: usize>(UnsafeCell<[u8; N]>);
unsafe impl<const N: usize> Sync for Bytes<N> {}
static PROG: Words<PCAP> = Words(UnsafeCell::new([0; PCAP]));
static POOL: Bytes<BCAP> = Bytes(UnsafeCell::new([0; BCAP]));
static VMS: Words<SCAP> = Words(UnsafeCell::new([0; SCAP]));
static LIMB: Words<10> = Words(UnsafeCell::new([0; 10]));
static OUTB: Words<OUTW> = Words(UnsafeCell::new([0; OUTW]));
static PLEN: AtomicI32 = AtomicI32::new(0);
static BLEN: AtomicI32 = AtomicI32::new(0);
static MCAP: AtomicI32 = AtomicI32::new(0);

#[no_mangle]
pub extern "C" fn snug_prog_buf() -> *mut i32 { PROG.0.get() as *mut i32 }
#[no_mangle]
pub extern "C" fn snug_pool_buf() -> *mut u8 { POOL.0.get() as *mut u8 }
#[no_mangle]
pub extern "C" fn snug_lim_buf() -> *mut i32 { LIMB.0.get() as *mut i32 }
#[no_mangle]
pub extern "C" fn snug_out_buf() -> *mut i32 { OUTB.0.get() as *mut i32 }

/// Use the first `words` / `bytes` of the Program and pool buffers (the host
/// verified them). 0, or -2 when they exceed the static capacities.
#[no_mangle]
pub extern "C" fn snug_vm_load(words: usize, bytes: usize) -> i32 {
    if words > PCAP || bytes > BCAP || words < 64 { return -2; }
    // SAFETY: single-threaded; no other reference exists during the call.
    let p: &[i32] = unsafe { std::slice::from_raw_parts(PROG.0.get() as *const i32, words) };
    let s: &mut [i32] = unsafe { &mut *VMS.0.get() };
    let nl = p[16];
    if nl > MCAP.load(Ordering::Relaxed) {
        // a larger mark capacity: a fresh scratch (zeroed marks, epoch 1)
        if 48 + 2 * nl as usize > SCAP { return -2; }
        for w in s[..48 + 2 * nl as usize].iter_mut() { *w = 0; }
        snug::vm::api::vm_scratch_init(s, nl);
        MCAP.store(nl, Ordering::Relaxed);
    }
    PLEN.store(words as i32, Ordering::Relaxed);
    BLEN.store(bytes as i32, Ordering::Relaxed);
    0
}

/// Validate the first `len` bytes of the input buffer against `rule` of the
/// loaded Program: vm-validate's answer (out words at `snug_out_buf()`).
#[no_mangle]
pub extern "C" fn snug_vm_validate(len: usize, rule: i32) -> i32 {
    if len > CAP { return -1; }
    // SAFETY: single-threaded; the host only writes the buffers between calls.
    let input: &[u8] = unsafe { std::slice::from_raw_parts(BUF.0.get() as *const u8, len) };
    let p: &[i32] = unsafe { std::slice::from_raw_parts(PROG.0.get() as *const i32, PLEN.load(Ordering::Relaxed) as usize) };
    let b: &[u8] = unsafe { std::slice::from_raw_parts(POOL.0.get() as *const u8, BLEN.load(Ordering::Relaxed) as usize) };
    let s: &mut [i32] = unsafe { &mut *VMS.0.get() };
    let lim: &[i32] = unsafe { &*LIMB.0.get() };
    let out: &mut [i32] = unsafe { &mut *OUTB.0.get() };
    snug::vm::api::vm_validate(p, b, rule, input, lim, s, out)
}
} // mod legacy
