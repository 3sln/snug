//! Async sources: the async counterparts of [`Schema::validate_blob`],
//! [`Schema::validate_reader`] and [`read_sequence`](crate::read_sequence), over the
//! same resumable session and sequence reader. Validation never does I/O and never
//! awaits: each driver, sync or async, is a thin I/O loop over one core that decides
//! every window, keep, end and verdict; the loop only does the read it is asked for
//! (awaited here) or yields. So verdicts, codes, offsets, paths and budget are the
//! sync driver's for every chunking.
//!
//! Runtime-agnostic and dependency-free: [`AsyncSource`] has the signature of
//! `futures_io::AsyncRead::poll_read`, [`AsyncBlob`] returns any `Future`, and a
//! positive [`SourceOptions::quantum`] yields to the executor by waking itself and
//! answering `Pending` once. Any executor drives them (tokio, async-std, smol, a
//! hand-written one).
//!
//! ```
//! use snug::{CompileOptions, Schema, SourceOptions, ValidationOptions};
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
//!     &mut body, "r", &ValidationOptions::default(), &SourceOptions::default()))?;
//! assert!(verdict.is_ok());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
use crate::schema::{self, BlobCore, Failure, Io, SourceError, StreamCore};
use crate::sequence::{Message, Pump, SeqPump, Sequence, SequenceOptions};
use crate::{BytesBlob, Error, Schema, SourceOptions, ValidationOptions};
use std::future::{poll_fn, Future};
use std::io;
use std::ops::DerefMut;
use std::pin::Pin;
use std::task::{Context, Poll};

/// A forward-only byte source read asynchronously: a stream of unknown length.
///
/// The signature is `futures_io::AsyncRead::poll_read`'s, so an adapter is a newtype
/// (the Rust guide's "Async sources"). `Ready(Ok(0))` is the end of the input (for a
/// non-empty `buf`); `ErrorKind::Interrupted` is retried; any other error ends the
/// validation with [`Error::Io`], which keeps it. A `Pending` read must not have
/// consumed bytes and must arrange a wake-up, as usual.
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
/// object's version). Implementors may write `async fn read`.
pub trait AsyncBlob {
    /// The size in bytes.
    fn size(&self) -> usize;
    /// Exactly the `len` bytes at `offset` (fewer is `short_read`). A backend
    /// failure is best returned as [`SourceError::Io`] (`err.into()` from an
    /// `io::Error`), which [`Error::Io`] keeps.
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
            Err(e) => return Err(e.into()),
        }
    }
}

/// The async [`schema::validate_blob`] (the test hosts' low-level API, as that one,
/// with its `i32` quantum): the same `BlobCore` — a read of `max(need, chunk)` bytes
/// at the asked offset, only when the window lacks them.
/// [`Schema::validate_blob_async`] is the public form.
#[doc(hidden)]
pub async fn validate_blob<B: AsyncBlob + ?Sized>(prog: &schema::Program, rule: i32, blob: &B, opts: &schema::Options,
                                                  chunk: usize, quantum: i32) -> Result<Result<(), Failure>, SourceError> {
    let mut core = BlobCore::new(prog, rule, blob.size(), opts, chunk, quantum)?;
    loop {
        match core.next() {
            Io::Read { offset, len } => core.fill(blob.read(offset, len).await?)?,
            Io::Yield => yield_now().await,
            Io::Done(d) => return Ok(d),
        }
    }
}

/// The async [`schema::validate_reader`] (drain mode or fail-fast; the test hosts'
/// low-level API, as that one, with its `i32` quantum): the same `StreamCore`, with
/// the read awaited. [`Schema::validate_reader_async`] is the public form.
#[doc(hidden)]
pub async fn validate_reader<S: AsyncSource + Unpin + ?Sized>(prog: &schema::Program, rule: i32, src: &mut S,
                                                              opts: &schema::Options, chunk: usize, quantum: i32,
                                                              fail_fast: bool) -> Result<Result<(), Failure>, SourceError> {
    let mut core = StreamCore::new(prog, rule, opts, chunk, quantum, fail_fast)?;
    loop {
        match core.next() {
            Io::Read { .. } => {
                let got = read_some(src, core.buf()).await?;
                core.filled(got);
            }
            Io::Yield => yield_now().await,
            Io::Done(d) => return Ok(d),
        }
    }
}

impl Schema {
    /// [`Schema::validate_blob`] over an [`AsyncBlob`]: the same session, window
    /// policy, verdicts and errors; one read in flight, issued only when the session
    /// asks for bytes its window lacks. A positive `source.quantum` yields to the
    /// executor once per session yield.
    pub async fn validate_blob_async<B: AsyncBlob + ?Sized>(
        &self,
        blob: &B,
        rule: &str,
        options: &ValidationOptions,
        source: &SourceOptions,
    ) -> Result<Result<(), Failure>, Error> {
        let r = self.rule(rule).map_err(Error::from)?;
        let (chunk, quantum) = source.checked()?;
        validate_blob(self.program().host(), r, blob, &options.host(), chunk, quantum).await.map_err(Error::from)
    }

    /// [`Schema::validate_reader`] over an [`AsyncSource`]: a message of UNKNOWN length
    /// read until EOF in drain mode — the verdict equals the buffer's of the same
    /// bytes. With `source.fail_fast` a certain refusal is answered at once and reading
    /// stops (its code may then differ: `cbor/truncated` or `cbor/too_large`;
    /// accept/refuse never does). Holds what the session asks for plus one
    /// `source.chunk`; a positive `source.quantum` yields to the executor once per
    /// session yield. A read error is [`Error::Io`], the source's own error.
    pub async fn validate_reader_async<S: AsyncSource + Unpin + ?Sized>(
        &self,
        source: &mut S,
        rule: &str,
        options: &ValidationOptions,
        reading: &SourceOptions,
    ) -> Result<Result<(), Failure>, Error> {
        let r = self.rule(rule).map_err(Error::from)?;
        let (chunk, quantum) = reading.checked()?;
        validate_reader(self.program().host(), r, source, &options.host(), chunk, quantum, reading.fail_fast)
            .await
            .map_err(Error::from)
    }

    /// [`Schema::read_sequence`] over an [`AsyncSource`]: each message validated
    /// against `rule`.
    pub fn read_sequence_async<S: AsyncSource + Unpin>(
        &self,
        source: S,
        rule: &str,
        options: &SequenceOptions,
    ) -> Result<AsyncSequenceReader<'_, S>, Error> {
        if options.chunk == 0 || options.chunk > crate::api::MAX_CHUNK {
            return Err(Error::Usage("options"));
        }
        Ok(AsyncSequenceReader::new(self.sequence(rule, options)?, source, options.chunk))
    }
}

/// [`read_sequence`](crate::read_sequence) over an [`AsyncSource`]: a profile-checked
/// CBOR sequence read until EOF.
/// `Err(Error::SessionLimit)` when the live-session bound is reached.
pub fn read_sequence_async<S: AsyncSource + Unpin>(source: S, options: &SequenceOptions) -> Result<AsyncSequenceReader<'static, S>, Error> {
    if options.chunk > crate::api::MAX_CHUNK {
        return Err(Error::Usage("options"));
    }
    Ok(AsyncSequenceReader::new(Sequence::new(options)?, source, options.chunk.max(1)))
}

/// The async reader of [`read_sequence_async`] / [`Schema::read_sequence_async`]:
/// [`next`](AsyncSequenceReader::next) answers the items the sync
/// [`SequenceReader`](crate::SequenceReader) iterates — owned messages; a stopping
/// refusal is the last item; a read error is [`Error::Io`] (also last).
///
/// Cancel-safe: dropping a `next()` future loses no message (a read that completes
/// is fed before `next` returns; a `Pending` read consumed nothing).
pub struct AsyncSequenceReader<'p, S> {
    pump: SeqPump<'p>,
    source: S,
}

impl<'p, S: AsyncSource + Unpin> AsyncSequenceReader<'p, S> {
    fn new(seq: Sequence<'p>, source: S, chunk: usize) -> Self {
        AsyncSequenceReader { pump: SeqPump::new(seq, chunk), source }
    }

    /// The next item, or `None` after the last.
    pub async fn next(&mut self) -> Option<Result<Message<'static>, Error>> {
        poll_fn(|cx| self.poll_next(cx)).await
    }

    /// The poll form of [`next`](AsyncSequenceReader::next) (for a `Stream` adapter).
    pub fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<Option<Result<Message<'static>, Error>>> {
        loop {
            match self.pump.next() {
                Pump::Item(x) => return Poll::Ready(x),
                Pump::Read => {
                    let Poll::Ready(r) = Pin::new(&mut self.source).poll_read(cx, self.pump.buf()) else {
                        return Poll::Pending;
                    };
                    if let Some(e) = self.pump.filled(r) {
                        return Poll::Ready(Some(e));
                    }
                }
            }
        }
    }

    /// Bytes held for the message in progress (the sequence's assembly; the read
    /// buffer of `chunk` bytes is extra).
    pub fn bytes_held(&self) -> usize {
        self.pump.bytes_held()
    }

    /// The source, returned once reading is over (or abandoned).
    pub fn into_inner(self) -> S {
        self.source
    }
}
