//! Async sources (P9.6, D027): the async counterparts of [`Schema::validate_blob`],
//! [`Schema::validate_reader`] and [`read_sequence`](crate::read_sequence), over the
//! same resumable session (NEED / YIELD, D030) and sequence reader. The VM never does
//! I/O and never awaits: each driver asks the session what it needs, awaits that read,
//! and steps again — so verdicts, codes, offsets, paths and budget are the sync
//! driver's for every chunking (gated by `tests/async_sources.rs`).
//!
//! Runtime-agnostic and dependency-free: [`AsyncSource`] has the signature of
//! `futures_io::AsyncRead::poll_read`, [`AsyncBlob`] returns any `Future`, and a
//! positive quantum yields to the executor by waking itself and answering `Pending`
//! once. Any executor drives them (tokio, async-std, smol, a hand-written one).
//!
//! ```
//! use snug::{CompileOptions, Schema, ValidationOptions};
//! # fn block_on<F: std::future::Future>(f: F) -> F::Output {
//! #     struct W; impl std::task::Wake for W { fn wake(self: std::sync::Arc<Self>) {} }
//! #     let waker = std::task::Waker::from(std::sync::Arc::new(W));
//! #     let mut cx = std::task::Context::from_waker(&waker);
//! #     let mut f = std::pin::pin!(f);
//! #     loop { if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) { return v; } }
//! # }
//! let schema = Schema::compile("r = [* uint]", &CompileOptions::default())?;
//! let mut body: &[u8] = &[0x83, 1, 2, 3];          // any AsyncSource
//! let verdict = block_on(schema.validate_reader_async(
//!     &mut body, "r", &ValidationOptions::default(), 4096, 0, false))?;
//! assert!(verdict.is_ok());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
use crate::schema::{self, Failure, Session, SourceError, Step};
use crate::sequence::{Message, Sequence, SequenceOptions};
use crate::{BytesBlob, Error, Schema, ValidationOptions};
use std::collections::VecDeque;
use std::future::{poll_fn, Future};
use std::io;
use std::ops::DerefMut;
use std::pin::Pin;
use std::task::{Context, Poll};

/// A forward-only byte source read asynchronously: a stream of unknown length.
///
/// The signature is `futures_io::AsyncRead::poll_read`'s, so an adapter is a newtype
/// (docs/rust.md "Async sources"). `Ready(Ok(0))` is the end of the input (for a
/// non-empty `buf`); `ErrorKind::Interrupted` is retried; any other error is
/// [`Error::Source("read")`](Error::Source). A `Pending` read must not have consumed
/// bytes and must arrange a wake-up, as usual.
pub trait AsyncSource {
    /// Read up to `buf.len()` bytes into `buf`.
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>>;
}

impl<'a> AsyncSource for &'a [u8] {
    fn poll_read(mut self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let src: &'a [u8] = *self;
        let n = buf.len().min(src.len());
        buf[..n].copy_from_slice(&src[..n]);
        *self = &src[n..];
        Poll::Ready(Ok(n))
    }
}
impl<S: AsyncSource + Unpin + ?Sized> AsyncSource for &mut S {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut **self).poll_read(cx, buf)
    }
}
impl<S: AsyncSource + Unpin + ?Sized> AsyncSource for Box<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut **self).poll_read(cx, buf)
    }
}
impl<P> AsyncSource for Pin<P>
where
    P: DerefMut + Unpin,
    P::Target: AsyncSource,
{
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        self.get_mut().as_mut().poll_read(cx, buf)
    }
}

/// A random-access source of a known size read asynchronously: the async
/// [`Blob`](crate::Blob) (a remote object read by range requests, a file). Its
/// contents must not change while it is read (an immutable snapshot: pin the
/// object's version, architecture §17.3, W12). Implementors may write `async fn read`.
pub trait AsyncBlob {
    /// The size in bytes.
    fn size(&self) -> usize;
    /// Exactly the `len` bytes at `offset` (fewer is `short_read`).
    fn read(&self, offset: usize, len: usize) -> impl Future<Output = Result<Vec<u8>, SourceError>>;
}

impl AsyncBlob for BytesBlob<'_> {
    fn size(&self) -> usize {
        self.0.len()
    }
    fn read(&self, offset: usize, len: usize) -> impl Future<Output = Result<Vec<u8>, SourceError>> {
        std::future::ready(<BytesBlob<'_> as crate::Blob>::read(self, offset, len))
    }
}

/// Wake ourselves and answer `Pending` once: a runtime-agnostic yield to the executor
/// (JS's `nextTurn`), taken when a positive quantum makes the session YIELD.
fn yield_now() -> impl Future<Output = ()> {
    let mut yielded = false;
    poll_fn(move |cx| {
        if yielded {
            return Poll::Ready(());
        }
        yielded = true;
        cx.waker().wake_by_ref();
        Poll::Pending
    })
}

/// One read from `src`, retrying `Interrupted` (as the sync `Read` drivers do).
async fn read_some<S: AsyncSource + Unpin + ?Sized>(src: &mut S, buf: &mut [u8]) -> Result<usize, SourceError> {
    loop {
        match poll_fn(|cx| Pin::new(&mut *src).poll_read(cx, buf)).await {
            Ok(n) => return Ok(n),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(SourceError::Read),
        }
    }
}

fn source_error(e: SourceError) -> Error {
    match e {
        SourceError::ShortRead { .. } => Error::Source("short_read"),
        SourceError::Read => Error::Source("read"),
        SourceError::TooLarge => Error::Source("too_large"),
        SourceError::SessionLimit => Error::SessionLimit,
    }
}

/// The async [`schema::validate_blob`] (the low-level host API, as that one): the same
/// window policy — a read of `max(need, chunk)` bytes at the asked offset, only when
/// the window lacks them. [`Schema::validate_blob_async`] is the public form.
pub async fn validate_blob<B: AsyncBlob + ?Sized>(prog: &schema::Program, rule: i32, blob: &B, opts: &schema::Options,
                                                  chunk: usize, quantum: i32) -> Result<Result<(), Failure>, SourceError> {
    let size = blob.size();
    if size > 0x7fff_ffff {
        return Err(SourceError::TooLarge);
    }
    let mut session = Session::new(prog, rule, size as i32, opts, quantum).map_err(|_| SourceError::SessionLimit)?;
    let (mut base, mut window): (usize, Vec<u8>) = (0, Vec::new());
    let (mut at, mut need) = (0usize, chunk.min(size));
    loop {
        let end = base + window.len();
        if !(at >= base && at + need.min(size - at) <= end && (at < end || at == size)) {
            let len = need.max(chunk).min(size - at);
            let got = blob.read(at, len).await?;
            if got.len() != len {
                return Err(SourceError::ShortRead { offset: at, wanted: len, got: got.len() });
            }
            base = at;
            window = got;
        }
        match session.step(&window, base as i32) {
            Step::Done(d) | Step::Held(d) => return Ok(d),
            Step::Need { offset, len, .. } => {
                at = offset as usize;
                need = len as usize;
            }
            Step::Yield { position, .. } => {
                yield_now().await;
                at = position as usize;
                need = 1;
            }
        }
    }
}

/// The async [`schema::validate_reader`] (D085 drain mode, D145 fail-fast, D147; the
/// low-level host API, as that one): the same bookkeeping as its reader, with the read
/// awaited. [`Schema::validate_reader_async`] is the public form.
pub async fn validate_reader<S: AsyncSource + Unpin + ?Sized>(prog: &schema::Program, rule: i32, src: &mut S,
                                                              opts: &schema::Options, chunk: usize, quantum: i32,
                                                              fail_fast: bool) -> Result<Result<(), Failure>, SourceError> {
    let mut session = Session::new_unknown(prog, rule, opts, quantum).map_err(|_| SourceError::SessionLimit)?;
    let limit = session.limit();
    let mut st = Held { tmp: vec![0u8; chunk.max(1)], buf: Vec::new(), base: 0, delivered: 0, eof: false };
    let mut step = session.step(&st.buf, 0);
    // the session was given the end and resumed: it goes on over what is held, never
    // asking past the end (a yield at the end needs no byte); vms-eof is called once
    let mut ended = false;
    loop {
        // what the session wants: [at, at + len)
        let (at, len) = match step {
            Step::Done(d) => return Ok(d),
            Step::Held(d) => {
                if fail_fast && d.is_err() {
                    return Ok(d);
                }
                // drain: the verdict waits for the end (or the input limit)
                while !st.eof && st.delivered <= limit {
                    let d = st.delivered;
                    st.drop_to(d);
                    st.read(src).await?;
                }
                step = session.end(st.delivered);
                ended = true;
                continue;
            }
            Step::Need { offset, len, keep } => {
                st.drop_to(keep as usize);
                (offset as usize, len as usize)
            }
            Step::Yield { position, keep } => {
                st.drop_to(keep as usize);
                if quantum > 0 {
                    yield_now().await;
                }
                (position as usize, if ended { 0 } else { 1 })
            }
        };
        while !st.eof && st.delivered <= limit && st.base + st.buf.len() < at + len {
            st.read(src).await?;
        }
        if ended {
            assert!(st.base + st.buf.len() >= at + len, "snug: the session asked past the end");
            step = session.step(&st.buf, st.base as i32);
        } else if st.delivered > limit || st.base + st.buf.len() < at + len {
            ended = true;
            // past the input limit (too_large), or the message ended before what is asked
            step = session.end(st.delivered);
            if let Step::Yield { .. } = step {
                step = session.step(&st.buf, st.base as i32);
            }
        } else {
            step = session.step(&st.buf, st.base as i32);
        }
    }
}

/// The bytes of a forward-only source from `base` on (what the session keeps).
struct Held {
    tmp: Vec<u8>,
    buf: Vec<u8>,
    base: usize,
    delivered: usize,
    eof: bool,
}
impl Held {
    /// Drop what precedes `keep` (it may lie ahead of what arrived: a skipped byte string).
    fn drop_to(&mut self, keep: usize) {
        let keep = keep.max(self.base);
        let k = (keep - self.base).min(self.buf.len());
        self.buf.drain(..k);
        self.base += k;
        if keep > self.base {
            self.base = keep;
        }
    }
    async fn read<S: AsyncSource + Unpin + ?Sized>(&mut self, src: &mut S) -> Result<(), SourceError> {
        let got = read_some(src, &mut self.tmp).await?;
        if got == 0 {
            self.eof = true;
            return Ok(());
        }
        let start = self.delivered;
        self.delivered += got;
        if self.delivered > self.base {
            let from = self.base.saturating_sub(start);
            self.buf.extend_from_slice(&self.tmp[from..got]);
        }
        Ok(())
    }
}

impl Schema {
    /// [`Schema::validate_blob`] over an [`AsyncBlob`]: the same session, window
    /// policy, verdicts and errors; one read in flight, issued only when the session
    /// asks for bytes its window lacks. `chunk` must be positive; a positive
    /// `quantum` yields to the executor once per session YIELD.
    pub async fn validate_blob_async<B: AsyncBlob + ?Sized>(
        &self,
        blob: &B,
        rule: &str,
        options: &ValidationOptions,
        chunk: usize,
        quantum: u32,
    ) -> Result<Result<(), Failure>, Error> {
        let r = self.rule(rule).map_err(Error::Validation)?;
        if chunk == 0 || quantum > i32::MAX as u32 {
            return Err(Error::Usage("options"));
        }
        validate_blob(self.program().host(), r, blob, &options.host(), chunk, quantum as i32)
            .await
            .map_err(source_error)
    }

    /// [`Schema::validate_reader`] over an [`AsyncSource`]: a message of UNKNOWN length
    /// read until EOF in drain mode (D085) — the verdict equals the buffer's of the same
    /// bytes. `fail_fast` answers a certain refusal at once and stops reading (its code
    /// may then differ: `cbor/truncated` or `cbor/too_large`; accept/refuse never does).
    /// Holds what the session asks for plus one `chunk`; a positive `quantum` yields to
    /// the executor once per session YIELD. Read errors are `Error::Source("read")`.
    pub async fn validate_reader_async<S: AsyncSource + Unpin + ?Sized>(
        &self,
        source: &mut S,
        rule: &str,
        options: &ValidationOptions,
        chunk: usize,
        quantum: u32,
        fail_fast: bool,
    ) -> Result<Result<(), Failure>, Error> {
        let r = self.rule(rule).map_err(Error::Validation)?;
        if chunk == 0 || quantum > i32::MAX as u32 {
            return Err(Error::Usage("options"));
        }
        validate_reader(self.program().host(), r, source, &options.host(), chunk, quantum as i32, fail_fast)
            .await
            .map_err(|e| match e {
                SourceError::SessionLimit => Error::SessionLimit,
                _ => Error::Source("read"),
            })
    }

    /// [`Schema::read_sequence`] over an [`AsyncSource`]: each message validated
    /// against `rule` (D210).
    pub fn read_sequence_async<S: AsyncSource + Unpin>(
        &self,
        source: S,
        rule: &str,
        options: &SequenceOptions,
    ) -> Result<AsyncSequenceReader<'_, S>, Error> {
        if options.chunk == 0 {
            return Err(Error::Usage("options"));
        }
        Ok(AsyncSequenceReader::new(self.sequence(rule, options)?, source, options.chunk))
    }
}

/// [`read_sequence`](crate::read_sequence) over an [`AsyncSource`]: a profile-checked
/// CBOR sequence read until EOF.
/// `Err(Error::SessionLimit)` when the live-session bound is reached (P9.7, D327).
pub fn read_sequence_async<S: AsyncSource + Unpin>(source: S, options: &SequenceOptions) -> Result<AsyncSequenceReader<'static, S>, Error> {
    Ok(AsyncSequenceReader::new(Sequence::new(options)?, source, options.chunk.max(1)))
}

/// The async reader of [`read_sequence_async`] / [`Schema::read_sequence_async`]:
/// [`next`](AsyncSequenceReader::next) answers the items the sync
/// [`SequenceReader`](crate::SequenceReader) iterates — owned messages; a stopping
/// refusal is the last item; a read error is `Error::Source("read")` (also last).
///
/// Cancel-safe: dropping a `next()` future loses no message (a read that completes
/// is fed before `next` returns; a `Pending` read consumed nothing).
pub struct AsyncSequenceReader<'p, S> {
    seq: Sequence<'p>,
    source: S,
    buf: Vec<u8>,
    queue: VecDeque<Result<Message<'static>, Error>>,
    finished: bool,
}

impl<'p, S: AsyncSource + Unpin> AsyncSequenceReader<'p, S> {
    fn new(seq: Sequence<'p>, source: S, chunk: usize) -> Self {
        AsyncSequenceReader { seq, source, buf: vec![0u8; chunk], queue: VecDeque::new(), finished: false }
    }

    /// The next item, or `None` after the last.
    pub async fn next(&mut self) -> Option<Result<Message<'static>, Error>> {
        poll_fn(|cx| self.poll_next(cx)).await
    }

    /// The poll form of [`next`](AsyncSequenceReader::next) (for a `Stream` adapter).
    pub fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<Option<Result<Message<'static>, Error>>> {
        loop {
            if let Some(x) = self.queue.pop_front() {
                return Poll::Ready(Some(x));
            }
            if self.finished {
                return Poll::Ready(None);
            }
            match Pin::new(&mut self.source).poll_read(cx, &mut self.buf) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Ok(0)) => {
                    self.finished = true;
                    let items = self.seq.finish();
                    self.queue.extend(items);
                }
                Poll::Ready(Ok(n)) => {
                    let items = self.seq.feed(&self.buf[..n]);
                    self.queue.extend(items.into_iter().map(|x| x.map(Message::into_owned)));
                    if self.seq.is_done() {
                        self.finished = true;
                    }
                }
                Poll::Ready(Err(e)) if e.kind() == io::ErrorKind::Interrupted => {}
                Poll::Ready(Err(_)) => {
                    self.finished = true;
                    return Poll::Ready(Some(Err(Error::Source("read"))));
                }
            }
        }
    }

    /// Bytes held for the message in progress (the sequence's assembly; the read
    /// buffer of `chunk` bytes is extra).
    pub fn bytes_held(&self) -> usize {
        self.seq.bytes_held()
    }

    /// The source, returned once reading is over (or abandoned).
    pub fn into_inner(self) -> S {
        self.source
    }
}
