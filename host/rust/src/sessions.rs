//! P9.7 (D327): sessions' arrays pooled per Program, and a bound on live sessions
//! per process.
//!
//! A session ([`crate::schema::Session`], a [`crate::Sequence`] reader) takes its VM
//! scratch, session array and key arena from its Program's pool and gives them back
//! when it is dropped. Every array is zero-filled before reuse: a pooled session starts
//! from exactly the bytes a fresh one does, so no byte crosses from one session to
//! another and units, events and verdicts are those of fresh arrays. Creating a session
//! while [`SessionLimits::max_live`] are live fails with [`SessionError::Limit`]
//! ([`crate::Error::SessionLimit`] through the public API, `code()` `sessions/limit`);
//! dropping a session releases its slot.
//!
//! ```
//! let before = snug::sessions::limits();
//! snug::sessions::set_limits(snug::sessions::SessionLimits { max_live: 64, ..before }).unwrap();
//! assert_eq!(snug::sessions::limits().max_live, 64);
//! snug::sessions::set_limits(before).unwrap();
//! ```
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::Mutex;

static MAX_LIVE: AtomicUsize = AtomicUsize::new(1024);
static MAX_POOLED: AtomicUsize = AtomicUsize::new(2 << 20);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static POOLED: AtomicUsize = AtomicUsize::new(0);
static SCRIBBLE: AtomicBool = AtomicBool::new(false);
/// One entry above this (or above a quarter of the pool) is dropped, not kept.
const ENTRY_MAX: usize = 1 << 20;

/// The process's session policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionLimits {
    /// Live sessions at most (default 1024): one more fails with `sessions/limit`.
    pub max_live: usize,
    /// Bytes of idle arrays kept for reuse at most (default 2 MiB).
    pub max_pooled_bytes: usize,
}

/// What the pools hold now, for monitoring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionCounts {
    /// Sessions created and not yet dropped.
    pub live: usize,
    /// Bytes of idle arrays in the pools.
    pub pooled_bytes: usize,
}

/// The current limits.
pub fn limits() -> SessionLimits {
    SessionLimits { max_live: MAX_LIVE.load(SeqCst), max_pooled_bytes: MAX_POOLED.load(SeqCst) }
}

/// Why a session could not start, or limits were refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionError {
    /// `max_live` sessions are live: drop (or finish) one to release its slot.
    Limit,
    /// [`set_limits`] with `max_live` 0.
    BadLimits,
}

impl SessionError {
    /// `sessions/limit`, or `session_limits` for a refused [`set_limits`].
    pub fn code(&self) -> &'static str {
        match self {
            Self::Limit => "sessions/limit",
            Self::BadLimits => "session_limits",
        }
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "snug: {}", match self {
            Self::Limit => "the process has its maximum of live sessions; finish or drop one to release its slot",
            Self::BadLimits => "max_live must be at least 1",
        })
    }
}

impl std::error::Error for SessionError {}

/// Set the limits (`max_live` at least 1). Lowering them affects only what comes next:
/// live sessions are not ended and idle arrays are dropped as they are next released.
pub fn set_limits(l: SessionLimits) -> Result<(), SessionError> {
    if l.max_live == 0 {
        return Err(SessionError::BadLimits);
    }
    MAX_LIVE.store(l.max_live, SeqCst);
    MAX_POOLED.store(l.max_pooled_bytes, SeqCst);
    Ok(())
}

/// The live sessions and pooled bytes now.
pub fn counts() -> SessionCounts {
    SessionCounts { live: LIVE.load(SeqCst), pooled_bytes: POOLED.load(SeqCst) }
}

/// Gates only: scribble released arrays, so a reuse that skipped the zero-fill shows.
#[doc(hidden)]
pub fn scribble_for_tests(on: bool) {
    SCRIBBLE.store(on, SeqCst);
}

/// A session's arrays.
#[derive(Debug, Default)]
pub(crate) struct Arrays {
    pub s: Vec<i32>,
    pub ss: Vec<i32>,
    pub ka: Vec<u8>,
}

impl Arrays {
    fn bytes(&self) -> usize {
        4 * (self.s.len() + self.ss.len()) + self.ka.len()
    }
}

/// A Program's idle arrays (dropped with the Program, its bytes uncounted then).
#[derive(Debug)]
pub(crate) struct Pool(Mutex<Vec<Arrays>>);

/// Every live Program's pool, for [`release_pool`].
static POOLS: Mutex<Vec<std::sync::Weak<Pool>>> = Mutex::new(Vec::new());

impl Pool {
    /// A new Program's pool, known to [`release_pool`].
    pub(crate) fn new() -> std::sync::Arc<Pool> {
        let p = std::sync::Arc::new(Pool(Mutex::new(Vec::new())));
        let mut all = POOLS.lock().unwrap_or_else(|e| e.into_inner());
        all.retain(|w| w.strong_count() > 0);
        all.push(std::sync::Arc::downgrade(&p));
        p
    }
    fn drain(&self) {
        let mut idle = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let n: usize = idle.iter().map(Arrays::bytes).sum();
        idle.clear();
        POOLED.fetch_sub(n, SeqCst);
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.drain();
    }
}

/// Drop every idle entry of every Program now (a long-lived process trimming memory);
/// later sessions allocate afresh.
pub fn release_pool() {
    let all: Vec<_> = POOLS.lock().unwrap_or_else(|e| e.into_inner()).iter().filter_map(std::sync::Weak::upgrade).collect();
    for p in all {
        p.drain();
    }
}

/// Arrays for a new session (S at least `sw` words, SS exactly `ssw`, the arena at least
/// `kab` bytes), all zero, and a live slot; or `sessions/limit`.
pub(crate) fn acquire(pool: &Pool, sw: usize, ssw: usize, kab: usize) -> Result<Arrays, SessionError> {
    let mut cur = LIVE.load(SeqCst);
    loop {
        if cur >= MAX_LIVE.load(SeqCst) {
            return Err(SessionError::Limit);
        }
        match LIVE.compare_exchange(cur, cur + 1, SeqCst, SeqCst) {
            Ok(_) => break,
            Err(v) => cur = v,
        }
    }
    let taken = {
        let mut idle = pool.0.lock().unwrap_or_else(|e| e.into_inner());
        idle.iter().rposition(|a| a.s.len() >= sw && a.ss.len() == ssw).map(|i| idle.swap_remove(i))
    };
    Ok(match taken {
        Some(mut a) => {
            POOLED.fetch_sub(a.bytes(), SeqCst);
            a.s.fill(0);
            a.ss.fill(0);
            if a.ka.len() >= kab { a.ka.fill(0) } else { a.ka = vec![0; kab] }
            a
        }
        None => Arrays { s: vec![0; sw], ss: vec![0; ssw], ka: vec![0; kab] },
    })
}

/// A session's arrays back (its slot freed): kept for reuse unless too large.
pub(crate) fn release(pool: &Pool, mut a: Arrays) {
    LIVE.fetch_sub(1, SeqCst);
    let n = a.bytes();
    let max = MAX_POOLED.load(SeqCst);
    if n > ENTRY_MAX || n > max / 4 {
        return;
    }
    if POOLED.fetch_add(n, SeqCst) + n > max {
        POOLED.fetch_sub(n, SeqCst);
        return;
    }
    if SCRIBBLE.load(SeqCst) {
        a.s.fill(0x5a5a_5a5a);
        a.ss.fill(0x5a5a_5a5a);
        a.ka.fill(0x5a);
    }
    pool.0.lock().unwrap_or_else(|e| e.into_inner()).push(a);
}
