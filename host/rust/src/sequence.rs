//! CBOR sequences (RFC 8742; P7.13, architecture §18, D210–D217): a series of
//! messages, each one root, read from chunks as they arrive. Each message is
//! checked in ONE pass — the profile, and the schema rule when one is given — by
//! the session VM's sequence mode (`vms-init-seq`), which also finds where it
//! ends; its [`View`] borrows the message's bytes without a re-scan.
//!
//! ```
//! use snug::{read_sequence, SequenceOptions};
//! let body: &[u8] = &[0xa1, 0x61, b'a', 1, 0xa1, 0x61, b'a', 2];   // two messages
//! let mut sum = 0;
//! for message in read_sequence(body, &SequenceOptions::default())? {
//!     sum += message?.view().get("a").and_then(|v| v.uint()).unwrap_or(0);
//! }
//! assert_eq!(sum, 3);
//! # Ok::<(), snug::Error>(())
//! ```
//!
//! Push: [`Sequence::feed`] answers the messages a chunk completes, borrowing
//! it when a message lies wholly inside it (`Cow::Borrowed`) and owning an
//! assembly otherwise; [`Sequence::finish`] settles the end. A refusal that
//! stops the sequence is an `Err(Error::Sequence(..))` after every earlier
//! message; with [`OnInvalid::Skip`] a schema refusal of a complete message is
//! an `Err` item too, and reading goes on (D214).
use crate::schema::{self, Failure};
use crate::snug::vm::session::{vms_arena, vms_eof, vms_held_code, vms_init_seq, vms_message_length, vms_need_length,
                               vms_need_offset, vms_position, vms_unknown_total};
use crate::{DecodeOptions, Error, Limits, Profile, Schema, Top, View};
use std::cell::OnceCell;
use std::borrow::Cow;
use std::collections::VecDeque;
use std::io::Read;
use std::sync::OnceLock;

const VMS_NEED: i32 = -64;
const VMS_YIELD: i32 = -65;
const VMS_HELD: i32 = -67;
const VMS_RESUME: i32 = -68;

/// `r = any` compiled with the largest limits — host/js/src/any-program.mjs's words
/// (checked against the compiler by the Rust API tests): the VM against it gives
/// the scanner's code on every input, so profile-only sequences run it (D146, D210).
#[doc(hidden)]
pub const ANY_P: [i32; 90] = [
    1735749235, 2, 64, 90, 1, 0, 0, -1153793131, -1965254075, -798592316, 844469009, -714685243, 702268175,
    1552891410, 1286639795, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 0, 0, 0, 0, 256, 2147483647, 16777216, 16777216, 128, 2147483647, 8388608,
    0, 1078, 4194304, 64, 69, 77, 78, 81, 81, 81, 81, 81, 81,
    81, 81, 81, 81, 81, 81, 81, 82, 86, 87, 0, 0, 0,
    1, 0, 0, 1078, 1, 4095, 0, 0, 0, 0, 0, 0, 78,
    1, 0, 0, 82, 1, 2, 0, 0, 87, 1, 0, 0,
];
#[doc(hidden)]
pub const ANY_B: [u8; 1] = [114];

fn any_program() -> &'static schema::Program {
    static ANY: OnceLock<schema::Program> = OnceLock::new();
    ANY.get_or_init(|| schema::Program::new(&ANY_P, &ANY_B).expect("snug: the built-in any Program verifies"))
}

/// D214: what a refused message does to the sequence. Not exhaustive (D339).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum OnInvalid {
    /// End the sequence at the first refused message (the default).
    #[default]
    Stop,
    /// Skip a schema refusal of a complete message (its framing is intact);
    /// every other refusal still stops.
    Skip,
}

/// Options of a sequence reader. Every limit applies to each message from zero
/// (D213); `None` is the compiled limit with a schema, the decode default
/// ([`Limits::default`]) without one.
#[derive(Debug, Clone)]
pub struct SequenceOptions {
    /// Required root shape of every message.
    pub top: Top,
    /// Permit safe integer labels in each message's top-level map.
    pub cose: bool,
    /// The wire profile (default: the valid preset, D267).
    pub profile: Profile,
    /// The largest message, in bytes (P): a message that does not end within it is `too_large`.
    pub max_message_bytes: Option<u32>,
    /// Depth cap per message.
    pub max_depth: Option<u32>,
    /// Per-container entry cap.
    pub max_entries: Option<u32>,
    /// Item cap per message.
    pub max_items: Option<u32>,
    /// Bignum byte cap.
    pub max_bignum_bytes: Option<u32>,
    /// VM work budget per message.
    pub budget: Option<u32>,
    /// Stop (default) or skip schema refusals of complete messages.
    pub on_invalid: OnInvalid,
    /// Report a refusal as soon as it is certain (D145; its code may differ).
    pub fail_fast: bool,
    /// Read size of [`read_sequence`] (positive; default 65536).
    pub chunk: usize,
}
impl Default for SequenceOptions {
    fn default() -> Self {
        Self {
            top: Top::Any,
            cose: false,
            profile: Profile::VALID,
            max_message_bytes: None,
            max_depth: None,
            max_entries: None,
            max_items: None,
            max_bignum_bytes: None,
            budget: None,
            on_invalid: OnInvalid::Stop,
            fail_fast: false,
            chunk: 65536,
        }
    }
}
impl SequenceOptions {
    /// limits words 0..7, word 8 (0), word 9 the profile flags (as schema::Options::words).
    fn words(&self, profile_only: bool) -> [i32; 10] {
        let l = |v: Option<u32>| v.map_or(-1, |x| x.min(i32::MAX as u32) as i32);
        let d = Limits::default();
        let (mb, md, me, mi) = if profile_only {
            (Some(self.max_message_bytes.unwrap_or(d.max_bytes)), Some(self.max_depth.unwrap_or(u32::from(d.max_depth))),
             Some(self.max_entries.unwrap_or(d.max_entries)), Some(self.max_items.unwrap_or(d.max_items)))
        } else {
            (self.max_message_bytes, self.max_depth, self.max_entries, self.max_items)
        };
        [if self.top == Top::Map { 0 } else { 1 }, self.cose as i32, l(mb), l(md), l(me), l(mi),
         l(self.max_bignum_bytes), l(self.budget), 0, self.profile.flags()]
    }
}

/// One message of a sequence (D215): its index, absolute offset and bytes —
/// borrowed from the chunk it lay in, or an owned assembly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message<'c> {
    /// 0-based position in the sequence (skipped messages count).
    pub index: u64,
    /// Absolute offset of its first byte in the sequence.
    pub offset: u64,
    bytes: Cow<'c, [u8]>,
    // a valid-CBOR reader's profile and cose (P8.4): the View reads the message's
    // canonical copy when it is not its own deterministic form
    vprof: Option<(Profile, bool)>,
    canon: OnceCell<(Option<Vec<u8>>, bool)>,
}
impl<'c> Message<'c> {
    /// The message's bytes (exactly its encoding).
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    /// Its length in bytes.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
    /// Never true: a message is at least one byte.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
    /// Does it borrow the fed chunk (true) or own an assembly (false)?
    pub fn is_borrowed(&self) -> bool {
        matches!(self.bytes, Cow::Borrowed(_))
    }
    /// A View of the checked message (minted from the reader's verdict, no re-scan).
    /// Under a valid-CBOR profile a message that is not its own deterministic form is
    /// read through its canonical copy (P8.4, D262), made once, on the first call, by
    /// the profile scanner (the check's limits are not re-applied).
    pub fn view(&self) -> View<'_> {
        if let Some((profile, cose)) = self.vprof {
            let (copy, unsorted) = self.canon.get_or_init(|| {
                let big = (i32::MAX - 1) as u32;
                let o = DecodeOptions {
                    top: Top::Any,
                    cose,
                    profile,
                    limits: Limits { max_bytes: big, max_depth: 256, max_entries: big, max_items: big },
                };
                // the message was accepted under this profile: never refused here
                match crate::decode::check(&self.bytes, &o) {
                    Ok(c) => (c.copy, c.unsorted),
                    Err(_) => (None, true),
                }
            });
            return crate::view::checked_keys(copy.as_deref().unwrap_or(&self.bytes), *unsorted);
        }
        crate::view::checked(&self.bytes)
    }
    /// The same message owning its bytes.
    pub fn into_owned(self) -> Message<'static> {
        Message { index: self.index, offset: self.offset, bytes: Cow::Owned(self.bytes.into_owned()), vprof: self.vprof, canon: self.canon }
    }
}

/// A refused message (D216): its index, absolute offsets and the per-message
/// verdict (whose `offset` is relative to the message), never payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageFailure {
    /// 0-based position of the refused message.
    pub index: u64,
    /// Absolute offset of the message.
    pub message_offset: u64,
    /// Absolute offset of the failure.
    pub offset: u64,
    /// The verdict, as `Schema::validate` gives it for the message's window.
    pub failure: Failure,
    /// A schema refusal of a complete message: `OnInvalid::Skip` skips it.
    pub skippable: bool,
}

/// D214: schema reasons of a complete message are skippable; cbor/* and budget never.
fn skippable_code(code: i32) -> bool {
    (32..=43).contains(&code)
}

/// A push reader of a CBOR sequence: feed chunks in order, then finish.
pub struct Sequence<'p> {
    prog: &'p schema::Program,
    rule: i32,
    lim: [i32; 10],
    total: i64,
    s: Vec<i32>,
    ss: Vec<i32>,
    ka: Vec<u8>,
    out: Vec<i32>,
    skip: bool,
    fail_fast: bool,
    delivered: u64,
    next: u64,
    index: u64,
    done: bool,
    // bytes after a message that ended inside its assembly: the assembly and where they start
    left: Option<(Vec<u8>, usize)>,
    // the message in progress
    msg: Option<u64>,
    // the message's assembly is mb[mb_at..] (mb_at > 0 when it began inside an earlier one)
    mb: Vec<u8>,
    mb_at: usize,
    at: i32,
    end: i64,
    eofed: bool,
    dropping: bool,
    held: bool,
    r: i32,
    asserted: i64,
    vprof: Option<(Profile, bool)>,
}

/// Where the bytes a step reads come from.
#[derive(Clone, Copy)]
struct Chunk<'c> {
    bytes: &'c [u8],
    base: u64,
}

/// P9.7: a reader's arrays go back to its Program's pool, and its live slot is freed,
/// when it is dropped.
impl Drop for Sequence<'_> {
    fn drop(&mut self) {
        let a = crate::sessions::Arrays { s: std::mem::take(&mut self.s), ss: std::mem::take(&mut self.ss), ka: std::mem::take(&mut self.ka) };
        self.prog.session_release(a);
    }
}

impl Sequence<'static> {
    /// A profile-only sequence reader (the VM against `any`, D210).
    pub fn new(options: &SequenceOptions) -> Result<Self, Error> {
        Sequence::start(any_program(), 0, options.words(true), options)
    }
}

impl<'p> Sequence<'p> {
    fn start(prog: &'p schema::Program, rule: i32, lim: [i32; 10], options: &SequenceOptions) -> Result<Self, Error> {
        let p = prog.words();
        let total = vms_unknown_total(p, &lim);
        // P9.7 (D327): the reader's arrays from the Program's pool under the live bound, back on drop
        let a = prog.session_arrays(rule, vms_arena(p, &lim, total))?;
        Ok(Sequence {
            prog,
            rule,
            lim,
            total: i64::from(total),
            s: a.s,
            ss: a.ss,
            ka: a.ka,
            out: vec![0i32; 8 + 2 * 257],
            skip: options.on_invalid == OnInvalid::Skip,
            fail_fast: options.fail_fast,
            delivered: 0,
            next: 0,
            index: 0,
            done: false,
            left: None,
            msg: None,
            mb: Vec::new(),
            mb_at: 0,
            at: 0,
            end: 0,
            eofed: false,
            dropping: false,
            held: false,
            r: 0,
            asserted: 0,
            vprof: if options.profile.valid { Some((options.profile, options.cose)) } else { None },
        })
    }

    /// Has the sequence ended (a stopping refusal, or [`Sequence::finish`])?
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Bytes held for the message in progress (its assembly so far).
    pub fn bytes_held(&self) -> usize {
        self.mlen() + self.left.as_ref().map_or(0, |(v, at)| v.len() - at)
    }

    /// The messages this chunk completes (an empty chunk is not the end). After the
    /// sequence has ended it answers nothing.
    pub fn feed<'c>(&mut self, chunk: &'c [u8]) -> Vec<Result<Message<'c>, Error>> {
        let mut out = Vec::new();
        if self.done || chunk.is_empty() {
            return out;
        }
        let c = Chunk { bytes: chunk, base: self.delivered };
        self.delivered += chunk.len() as u64;
        self.run(Some(c), false, &mut out);
        out
    }

    /// The end of the input: settles the message in progress (EOF inside it is
    /// `cbor/truncated`); the sequence is then done.
    pub fn finish(&mut self) -> Vec<Result<Message<'static>, Error>> {
        let mut out = Vec::new();
        if !self.done {
            self.run(None, true, &mut out);
            self.done = true;
        }
        out
    }

    fn run<'c>(&mut self, c: Option<Chunk<'c>>, fin: bool, out: &mut Vec<Result<Message<'c>, Error>>) {
        loop {
            let o = match self.msg {
                Some(o) => o,
                None => {
                    if !self.begin(c) {
                        return self.drained(c);
                    }
                    self.r = self.step(c);
                    self.msg.unwrap_or(0)
                }
            };
            let r = self.r;
            let avail = (self.delivered - o) as i64;
            if r == VMS_HELD {
                let ml = vms_message_length(&self.ss);
                let hc = vms_held_code(&self.ss);
                let keeps = hc == 0 || (self.skip && ml >= 0 && skippable_code(hc));
                if !keeps {
                    if self.fail_fast {
                        return self.stop(out);
                    }
                    self.dropping = true;
                    self.mb = Vec::new();
                    self.mb_at = 0;
                }
                // from now on a step only asserts the frontier (an empty window there)
                self.held = true;
                // bytes beyond what the last step asserted first release the claims they cover
                if self.asserted < self.end.min(avail) {
                    self.r = self.step(c);
                    continue;
                }
                if avail > self.total || fin {
                    self.r = self.eof();
                    continue;
                }
                return self.drained(c);
            }
            if r >= 0 {
                if !self.verdict(c, out) {
                    return;
                }
                continue;
            }
            if r == VMS_NEED || r == VMS_YIELD {
                let need = r == VMS_NEED;
                let no = if need { vms_need_offset(&self.ss) } else { vms_position(&self.ss) };
                let want = i64::from(no) + if need { i64::from(vms_need_length(&self.ss)) } else { 0 };
                self.at = no;
                if want <= avail && want <= self.end {
                    self.r = self.step(c);
                    continue;
                }
                if avail > self.total || fin {
                    assert!(!self.eofed, "snug: the sequence session asked past the end");
                    self.r = self.eof();
                    if self.r == VMS_RESUME {
                        self.at = vms_position(&self.ss);
                        self.r = self.step(c);
                    }
                    continue;
                }
                return self.drained(c);
            }
            panic!("snug: vms-step answered {} for a verified Program", r);
        }
    }

    fn begin(&mut self, c: Option<Chunk<'_>>) -> bool {
        let o = self.next;
        if o >= self.delivered {
            return false;
        }
        let ci = vms_init_seq(self.prog.words(), self.prog.pool(), self.rule, &self.lim, &mut self.s, &mut self.ss,
                              &mut self.ka, 0);
        assert!(ci >= 0, "snug: vms-init-seq answered {} for a verified Program", ci);
        self.msg = Some(o);
        self.at = 0;
        self.end = self.total;
        self.eofed = false;
        self.dropping = false;
        self.held = false;
        self.asserted = 0;
        // bytes after the previous message that it had already assembled start this one,
        // unless the chunk being read holds them too (then the message may borrow it)
        let left = self.left.take();
        (self.mb, self.mb_at) = match c {
            Some(ch) if o >= ch.base => (Vec::new(), 0),
            _ => left.unwrap_or_default(),
        };
        true
    }

    /// Bytes of the message in its assembly so far.
    fn mlen(&self) -> usize {
        self.mb.len() - self.mb_at
    }

    /// Copy the message's bytes from the chunk into its assembly up to absolute `upto`.
    fn absorb(&mut self, c: Option<Chunk<'_>>, upto: u64) {
        let (Some(c), Some(o)) = (c, self.msg) else { return };
        let from = o + self.mlen() as u64;
        let to = upto.min(c.base + c.bytes.len() as u64);
        if to <= from {
            return;
        }
        self.mb.extend_from_slice(&c.bytes[(from - c.base) as usize..(to - c.base) as usize]);
    }

    fn step(&mut self, c: Option<Chunk<'_>>) -> i32 {
        let o = self.msg.unwrap_or(0);
        let end = self.end.min((self.delivered - o) as i64);
        if self.dropping || self.held {
            self.asserted = end;
            return self.prog.session_step(&[], &mut self.s, &mut self.ss, &mut self.ka, &mut self.out, end as i32);
        }
        let at = i64::from(self.at);
        if let Some(ch) = c {
            if o + at as u64 >= ch.base {
                let from = (o + at as u64 - ch.base) as usize;
                let to = ((o as i64 + end) as u64).saturating_sub(ch.base).min(ch.bytes.len() as u64) as usize;
                let w = &ch.bytes[from..to.max(from)];
                self.asserted = at + w.len() as i64;
                return self.prog.session_step(w, &mut self.s, &mut self.ss, &mut self.ka, &mut self.out, self.at);
            }
            if (self.mlen() as i64) < end {
                // a piece that starts in the assembly and continues in the chunk: extend it that far
                let want = end.min((at + i64::from(vms_need_length(&self.ss))).max(self.mlen() as i64 + 1));
                self.absorb(c, o + want as u64);
            }
        }
        let to = (self.mlen() as i64).min(end) as usize;
        let lo = (at as usize).min(to);
        let w = &self.mb[self.mb_at + lo..self.mb_at + to];
        self.asserted = to as i64;
        self.prog.session_step(w, &mut self.s, &mut self.ss, &mut self.ka, &mut self.out, self.at)
    }

    fn eof(&mut self) -> i32 {
        self.eofed = true;
        let n = (self.delivered - self.msg.unwrap_or(0)) as i64;
        if n <= self.total {
            self.end = n;
        }
        vms_eof(&mut self.ss, &mut self.out, n.min(i64::from(i32::MAX)) as i32)
    }

    /// Waiting for bytes: keep what the message in progress has of this chunk.
    fn drained(&mut self, c: Option<Chunk<'_>>) {
        if let Some(o) = self.msg {
            if !self.dropping {
                let upto = self.delivered.min(o + self.end as u64);
                self.absorb(c, upto);
            }
        }
    }

    /// The verdict for the message in progress: deliver, skip or stop (false).
    fn verdict<'c>(&mut self, c: Option<Chunk<'c>>, out: &mut Vec<Result<Message<'c>, Error>>) -> bool {
        let o = self.msg.unwrap_or(0);
        let code = self.out[0];
        let ml = vms_message_length(&self.ss);
        if code == 0 || (self.skip && ml >= 0 && skippable_code(code)) {
            let len = ml as u64;
            let whole = match c {
                Some(ch) if self.mlen() == 0 && o >= ch.base && o + len <= ch.base + ch.bytes.len() as u64 => Some(ch),
                _ => None,
            };
            let item = if let Some(ch) = whole {
                // wholly inside the chunk: borrowed (D215)
                let from = (o - ch.base) as usize;
                if code == 0 {
                    Ok(Message { index: self.index, offset: o, bytes: Cow::Borrowed(&ch.bytes[from..from + ml as usize]), vprof: self.vprof, canon: OnceCell::new() })
                } else {
                    Err(self.fault(o))
                }
            } else {
                // assembled across chunks; the bytes after it stay in the assembly (an offset, no
                // copy of the tail), the message gets exactly its own bytes, so splitting many
                // messages out of one assembly copies each byte once (review 2026-11-04 #5)
                self.absorb(c, o + len);
                let mb = std::mem::take(&mut self.mb);
                let at = std::mem::take(&mut self.mb_at);
                let ml = ml as usize;
                let bytes = if at == 0 && mb.len() == ml { mb } else {
                    let own = mb[at..at + ml].to_vec();
                    if mb.len() > at + ml {
                        self.left = Some((mb, at + ml));
                    }
                    own
                };
                if code == 0 {
                    Ok(Message { index: self.index, offset: o, bytes: Cow::Owned(bytes), vprof: self.vprof, canon: OnceCell::new() })
                } else {
                    Err(self.fault(o))
                }
            };
            out.push(item);
            self.index += 1;
            self.next = o + len;
            self.msg = None;
            self.mb = Vec::new();
            self.mb_at = 0;
            return true;
        }
        self.stop(out);
        false
    }

    fn stop<'c>(&mut self, out: &mut Vec<Result<Message<'c>, Error>>) {
        let o = self.msg.unwrap_or(0);
        out.push(Err(self.fault(o)));
        self.done = true;
        self.msg = None;
        self.mb = Vec::new();
        self.mb_at = 0;
    }

    fn fault(&self, o: u64) -> Error {
        let ml = vms_message_length(&self.ss);
        let n = 8 + 2 * self.out[6].max(0) as usize;
        let failure = match schema::result(self.prog, &self.out[..n]) {
            Err(f) => f,
            Ok(()) => unreachable!("snug: a refusal with code 0"),
        };
        Error::Sequence(MessageFailure {
            index: self.index,
            message_offset: o,
            offset: o + failure.offset.max(0) as u64,
            skippable: ml >= 0 && skippable_code(self.out[0]),
            failure,
        })
    }
}

impl Schema {
    /// A push reader of a CBOR sequence whose messages are validated against `rule` (D210).
    pub fn sequence(&self, rule: &str, options: &SequenceOptions) -> Result<Sequence<'_>, Error> {
        let host = self.program().host();
        let r = host.rule(rule).ok_or(Error::Usage("unknown_rule"))?;
        Sequence::start(host, r, options.words(false), options)
    }
    /// Read a CBOR sequence from `reader` until EOF, each message validated against `rule`.
    pub fn read_sequence<R: Read>(&self, reader: R, rule: &str, options: &SequenceOptions) -> Result<SequenceReader<'_, R>, Error> {
        if options.chunk == 0 || options.chunk > crate::api::MAX_CHUNK {
            return Err(Error::Usage("options"));
        }
        Ok(SequenceReader::new(self.sequence(rule, options)?, reader, options.chunk))
    }
}

/// Read a profile-checked CBOR sequence from `reader` until EOF: an iterator of
/// owned messages; a stopping refusal is the last item; a read error is
/// `Error::Source("read")` (also the last item). `Err(Error::SessionLimit)` when
/// the live-session bound is reached (P9.7, D327).
pub fn read_sequence<R: Read>(reader: R, options: &SequenceOptions) -> Result<SequenceReader<'static, R>, Error> {
    if options.chunk > crate::api::MAX_CHUNK {
        return Err(Error::Usage("options"));
    }
    Ok(SequenceReader::new(Sequence::new(options)?, reader, options.chunk.max(1)))
}

/// The iterator of [`read_sequence`] / [`Schema::read_sequence`].
pub struct SequenceReader<'p, R: Read> {
    pump: SeqPump<'p>,
    reader: R,
}
impl<'p, R: Read> SequenceReader<'p, R> {
    fn new(seq: Sequence<'p>, reader: R, chunk: usize) -> Self {
        SequenceReader { pump: SeqPump::new(seq, chunk), reader }
    }
}
impl<R: Read> Iterator for SequenceReader<'_, R> {
    type Item = Result<Message<'static>, Error>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match self.pump.next() {
                Pump::Item(x) => return x,
                Pump::Read => {
                    let r = self.reader.read(self.pump.buf());
                    if let Some(e) = self.pump.filled(r) {
                        return Some(e);
                    }
                }
            }
        }
    }
}

/// What the sequence readers' core asks of its I/O loop (P9.6b, D335).
pub(crate) enum Pump {
    /// The next item (`None`: the sequence is over).
    Item(Option<Result<Message<'static>, Error>>),
    /// Read into `SeqPump::buf` and give the outcome to `SeqPump::filled`.
    Read,
}

/// The sans-IO core of [`SequenceReader`] and the async reader
/// (`crate::async_source::AsyncSequenceReader`): the sequence, the read buffer and
/// the messages decided but not yet taken. A read that completes is fed at once, so a
/// caller that stops between items loses nothing.
pub(crate) struct SeqPump<'p> {
    seq: Sequence<'p>,
    buf: Vec<u8>,
    queue: VecDeque<Result<Message<'static>, Error>>,
    finished: bool,
}
impl<'p> SeqPump<'p> {
    pub(crate) fn new(seq: Sequence<'p>, chunk: usize) -> Self {
        SeqPump { seq, buf: vec![0u8; chunk], queue: VecDeque::new(), finished: false }
    }
    pub(crate) fn next(&mut self) -> Pump {
        if let Some(x) = self.queue.pop_front() {
            return Pump::Item(Some(x));
        }
        if self.finished { Pump::Item(None) } else { Pump::Read }
    }
    pub(crate) fn buf(&mut self) -> &mut [u8] {
        &mut self.buf
    }
    /// The outcome of the read `next` asked for: `Ok(0)` is the end; `Interrupted` is
    /// retried; any other error ends the sequence with `Error::Source("read")`, answered
    /// here as the last item.
    pub(crate) fn filled(&mut self, read: std::io::Result<usize>) -> Option<Result<Message<'static>, Error>> {
        match read {
            Ok(0) => {
                self.finished = true;
                let items = self.seq.finish();
                self.queue.extend(items);
            }
            Ok(n) => {
                let items = self.seq.feed(&self.buf[..n]);
                self.queue.extend(items.into_iter().map(|x| x.map(Message::into_owned)));
                if self.seq.is_done() {
                    self.finished = true;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => {
                self.finished = true;
                return Some(Err(Error::Source("read")));
            }
        }
        None
    }
    pub(crate) fn bytes_held(&self) -> usize {
        self.seq.bytes_held()
    }
}

#[cfg(test)]
mod scratch_tests {
    use super::*;

    // P8.5 (D324): a session's group arena starts at the lease, so a scratch reused for
    // every message keeps its size; before, each message's arena took all of S and the
    // canonical path's events grew S again (about 470 words per message, never reclaimed).
    #[test]
    fn scratch_stays_bounded_over_canonical_messages() {
        let mut msg = vec![0x98, 50];
        for i in 0..50u8 {
            msg.push(0xa8);
            for k in [b'h', b'g', b'f', b'e', b'd', b'c', b'b', b'a'] {
                msg.extend_from_slice(&[0x61, k, i % 24]);
            }
        }
        let mut seq = Sequence::new(&SequenceOptions::default()).unwrap();
        let mut early = 0;
        for n in 0..1000 {
            for m in seq.feed(&msg) {
                assert!(m.is_ok());
            }
            if n == 5 {
                early = seq.s.len();
            }
        }
        assert!(seq.finish().iter().all(|m| m.is_ok()));
        assert_eq!(seq.s.len(), early, "S grew after the first messages");
    }
}
