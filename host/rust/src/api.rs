//! Public Schema facade over the existing compiler, VM and session host.
//!
//! ```
//! use snug::{Schema, CompileOptions, Scratch};
//! let schema = Schema::compile("message = { id: uint }", &CompileOptions::default())?;
//! schema.validate(&[0xa1, 0x62, b'i', b'd', 7], "message", &mut Scratch::new())?;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
pub use crate::schema::{Blob, Failure, Scratch, Segment};
use crate::{schema, Error, Program, Top, Value};

/// CDDL restriction set, independent of the CBOR wire policy. Not exhaustive (D339).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompilerProfile {
    /// Complete supported CDDL subset.
    #[default]
    Full,
    /// Bindle compiler restrictions.
    Bindle,
    /// Bounded bus subset for untrusted schemas.
    Bus,
}
/// Named compiler limits; omitted values use kin defaults, zero means zero,
/// and requests above hard ceilings clamp in kin.
#[derive(Debug, Clone, Default)]
pub struct CompileLimits {
    /// UTF-8 schema bytes.
    pub schema_bytes: Option<u32>,
    /// Source nesting depth.
    pub nesting: Option<u32>,
    /// AST node count.
    pub ast_nodes: Option<u32>,
    /// Generic instantiations.
    pub instantiations: Option<u32>,
    /// Live alternatives.
    pub alternatives: Option<u32>,
    /// Array automaton positions.
    pub array_positions: Option<u32>,
    /// Regexp positions.
    pub regexp_positions: Option<u32>,
    /// Live type-set width.
    pub width: Option<u32>,
    /// Program pool bytes.
    pub pool_bytes: Option<u32>,
    /// Total Program bytes.
    pub total_bytes: Option<u32>,
    /// Compiler work budget.
    pub compile_budget: Option<u32>,
    /// Compiled validation depth cap.
    pub depth: Option<u32>,
    /// Compiled input bytes cap.
    pub input_bytes: Option<u32>,
    /// Compiled entries cap.
    pub entries: Option<u32>,
    /// Compiled item cap.
    pub items: Option<u32>,
    /// Requested bignum cap (currently fixed at 128 by kin).
    pub bignum_bytes: Option<u32>,
    /// Compiled validation work budget.
    pub budget: Option<u32>,
    /// Program leaves.
    pub leaves: Option<u32>,
}
fn limit(n: Option<u32>) -> i32 {
    n.map_or(-1, |n| n.min(i32::MAX as u32 - 1) as i32)
}
impl CompileLimits {
    fn words(&self) -> [i32; 18] {
        [
            self.schema_bytes,
            self.nesting,
            self.ast_nodes,
            self.instantiations,
            self.alternatives,
            self.array_positions,
            self.regexp_positions,
            self.width,
            self.pool_bytes,
            self.total_bytes,
            self.compile_budget,
            self.depth,
            self.input_bytes,
            self.entries,
            self.items,
            self.bignum_bytes,
            self.budget,
            self.leaves,
        ]
        .map(limit)
    }
}
/// Compiler configuration, including optional pinned Unicode category tables.
#[derive(Debug, Default)]
pub struct CompileOptions<'a> {
    /// CDDL restriction set (default full).
    pub profile: CompilerProfile,
    /// XSD Appendix F (default), or RFC 9485 I-Regexp.
    pub regexp: crate::compile::Regexp,
    /// Resource and compiled runtime limits.
    pub limits: CompileLimits,
    /// Canonical category triples from `unicode_tables::tables()`.
    pub unicode: Option<&'a [i32]>,
    /// Extension controls (D141): the `.name` operators the schema may use.
    pub controls: Option<&'a crate::controls::Controls>,
    /// Cut semantics (D301): the literal RFC 8610 cut (default) or rule A.
    pub cuts: crate::compile::Cuts,
    /// The PEG group arena's cap in words (program-2 §9.4; D276, D281): `None` is the
    /// default 4,194,304; a run that needs more refuses with `group_limit`.
    pub group_words: Option<i32>,
    /// How `.abnf` / `.abnfb` controllers parse (D340): strict RFC 5234 + RFC 7405 +
    /// RFC 9165 §3 by default, or `AbnfMode::Lenient`. Bound into the source key.
    pub abnf: crate::compile::AbnfMode,
}
/// Runtime overrides only lower the caps compiled into the Program.
#[derive(Debug, Clone)]
pub struct ValidationOptions {
    /// Required root shape (schema default: any).
    pub top: Top,
    /// Permit safe integer labels in the top-level map.
    pub cose: bool,
    /// Input byte cap.
    pub max_bytes: Option<u32>,
    /// Depth cap.
    pub max_depth: Option<u32>,
    /// Per-container entry cap.
    pub max_entries: Option<u32>,
    /// Total item cap.
    pub max_items: Option<u32>,
    /// Bignum byte cap.
    pub max_bignum_bytes: Option<u32>,
    /// VM work budget.
    pub budget: Option<u32>,
    /// The wire profile (default: the valid preset, D267).
    pub profile: crate::Profile,
}
impl Default for ValidationOptions {
    fn default() -> Self {
        Self {
            top: Top::Any,
            cose: false,
            profile: crate::Profile::VALID,
            max_bytes: None,
            max_depth: None,
            max_entries: None,
            max_items: None,
            max_bignum_bytes: None,
            budget: None,
        }
    }
}
impl ValidationOptions {
    pub(crate) fn host(&self) -> schema::Options {
        let opt = |n: Option<u32>| if n.is_some() { Some(limit(n)) } else { None };
        schema::Options {
            top_map: self.top == Top::Map,
            cose: self.cose,
            profile: self.profile.flags(),
            max_bytes: opt(self.max_bytes),
            max_depth: opt(self.max_depth),
            max_entries: opt(self.max_entries),
            max_items: opt(self.max_items),
            max_bignum_bytes: opt(self.max_bignum_bytes),
            budget: opt(self.budget),
        }
    }
}
/// The largest driver read size (`chunk`): 2³¹ − 1 bytes. A larger one, or 0, is
/// `Error::Usage("options")` (it used to panic or reserve that much).
pub(crate) const MAX_CHUNK: usize = i32::MAX as usize;
/// How a source driver reads (JS's `SourceOptions`): the
/// [`Schema::validate_blob`] and [`Schema::validate_reader`] families and their
/// async forms. [`SequenceOptions`](crate::SequenceOptions) carries its own
/// `chunk` and `fail_fast`.
///
/// ```
/// use snug::SourceOptions;
/// let network = SourceOptions { chunk: 4096, fail_fast: true, ..SourceOptions::default() };
/// assert_eq!((network.quantum, SourceOptions::default().chunk), (0, 65536));
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceOptions {
    /// Bytes per read: 1..=2³¹ − 1 (default 65,536). A blob read is
    /// `max(need, chunk)` bytes; a stream holds what the session keeps plus one
    /// chunk.
    pub chunk: usize,
    /// About this many work units between yields to the caller or executor;
    /// 0 (the default) never yields. At most 2³¹ − 1.
    pub quantum: u32,
    /// An unknown-length stream answers a certain refusal at once and stops
    /// reading; its code may then be `cbor/truncated` or `cbor/too_large` where
    /// the buffer's differs, its accept/refuse never does. Prefer it for
    /// untrusted peers: drain mode (the default, `false`) reads on to the end or
    /// to `max_bytes`. A blob is read whole either way.
    pub fail_fast: bool,
}
impl Default for SourceOptions {
    fn default() -> Self {
        Self { chunk: 65536, quantum: 0, fail_fast: false }
    }
}
impl SourceOptions {
    /// The checked chunk and quantum, or `Error::Usage("options")`.
    pub(crate) fn checked(&self) -> Result<(usize, i32), Error> {
        if self.chunk == 0 || self.chunk > MAX_CHUNK || self.quantum > i32::MAX as u32 {
            return Err(Error::Usage("options"));
        }
        Ok((self.chunk, self.quantum as i32))
    }
}
fn failure(code: i32, reason: &'static str) -> Failure {
    Failure {
        code,
        reason,
        subcode: None,
        offset: 0,
        path: Vec::new(),
        budget_used: 0,
    }
}
/// Reusable schema owning an immutable verified Program. Share schemas across
/// threads; each validation context supplies its own exclusive Scratch.
#[derive(Debug, Clone)]
pub struct Schema {
    program: Program,
    warnings: Vec<crate::compile::Warning>,
}
impl Schema {
    /// Compile CDDL synchronously and verify the resulting Program. The
    /// compiler's warnings (never refusals) are [`Schema::warnings`].
    pub fn compile(text: &str, options: &CompileOptions<'_>) -> Result<Self, Error> {
        if text.len() >= i32::MAX as usize {
            return Err(Error::Usage("schema_size"));
        }
        let limits = options.limits.words();
        let profile = match options.profile {
            CompilerProfile::Full => 0,
            CompilerProfile::Bindle => 1,
            CompilerProfile::Bus => 2,
        };
        let c = crate::compile::compile_with_options(
            text,
            &crate::compile::CompileOptions {
                profile,
                regexp: options.regexp,
                cuts: options.cuts,
                group_words: options.group_words,
                abnf: options.abnf,
                limits: &limits,
                unicode: options.unicode,
                controls: options.controls.map(|c| c as &dyn crate::compile::Registry),
            },
        )?;
        let none = crate::controls::Controls::default();
        let program = Program::from_parts_with(&c.program, &c.pool, options.controls.unwrap_or(&none))?;
        Ok(Self { program, warnings: c.warnings })
    }
    /// Create a schema without invoking the compiler (no warnings).
    pub fn from_program(program: Program) -> Self {
        Self { program, warnings: Vec::new() }
    }
    /// The compile warnings, in a deterministic order (empty for a schema not
    /// compiled here: a loaded Program carries none). W8, for example, flags a
    /// choice of map groups that the RFC 8610 cut makes fail; see the guide's
    /// "Discriminated unions under the RFC cut".
    ///
    /// ```
    /// use snug::{CompileOptions, Schema};
    /// let s = Schema::compile("r = { kind: \"a\", x: int // kind: \"b\", y: tstr }", &CompileOptions::default())?;
    /// assert_eq!(s.warnings()[0].code, "W8");
    /// # Ok::<(), snug::Error>(())
    /// ```
    pub fn warnings(&self) -> &[crate::compile::Warning] {
        &self.warnings
    }
    /// Load a trusted persisted Program without invoking the compiler.
    pub fn from_serialized(bytes: &[u8]) -> Result<Self, Error> {
        Ok(Self::from_program(Program::deserialize(bytes)?))
    }
    /// [`Schema::from_serialized`] for a Program using extension controls (D141):
    /// the registry it was compiled with, else `Error::MissingControls`.
    pub fn from_serialized_with(bytes: &[u8], controls: &crate::controls::Controls) -> Result<Self, Error> {
        Ok(Self::from_program(Program::deserialize_with(bytes, controls)?))
    }
    /// Immutable Program for caching or sharing.
    pub fn program(&self) -> &Program {
        &self.program
    }
    pub(crate) fn rule(&self, rule: &str) -> Result<i32, Failure> {
        self.program
            .rules()
            .iter()
            .position(|name| name == rule)
            .and_then(|i| i32::try_from(i).ok())
            .ok_or_else(|| failure(-1, "unknown_rule"))
    }
    /// The rule's index, or `Error::Usage("unknown_rule")` (every
    /// `Result<_, Error>` API reports an unknown rule this way).
    fn rule_id(&self, rule: &str) -> Result<i32, Error> {
        self.rule(rule).map_err(Error::from)
    }
    /// Validate without building values, using any root and compiled limits.
    /// Unknown rule is an API failure (`code: -1, reason: unknown_rule`), never
    /// a fabricated CDDL verdict; `?` into [`Error`] turns it into
    /// `Error::Usage("unknown_rule")`, as every other API reports it.
    /// JavaScript instead throws TypeError.
    pub fn validate(&self, bytes: &[u8], rule: &str, scratch: &mut Scratch) -> Result<(), Failure> {
        self.validate_with_options(bytes, rule, &ValidationOptions::default(), scratch)
    }
    /// Validate with explicit root policy and runtime caps. Input is borrowed
    /// for the call only; failures retain schema-named paths, never data keys.
    pub fn validate_with_options(
        &self,
        bytes: &[u8],
        rule: &str,
        options: &ValidationOptions,
        scratch: &mut Scratch,
    ) -> Result<(), Failure> {
        let r = self.rule(rule)?;
        if bytes.len() >= i32::MAX as usize {
            return Err(failure(20, "cbor/too_large"));
        }
        schema::validate(self.program.host(), r, bytes, &options.host(), scratch)
    }
    /// Validate first, then build owned values without rescanning the profile.
    pub fn decode(&self, bytes: &[u8], rule: &str, scratch: &mut Scratch) -> Result<Value, Error> {
        self.decode_with_options(bytes, rule, &ValidationOptions::default(), scratch)
    }
    /// Decode under exactly the validation options supplied to the first pass.
    pub fn decode_with_options(
        &self,
        bytes: &[u8],
        rule: &str,
        options: &ValidationOptions,
        scratch: &mut Scratch,
    ) -> Result<Value, Error> {
        let c = self.validate_checked(bytes, rule, options, scratch)?;
        crate::decode::build(c.copy.as_deref().unwrap_or(bytes))
    }
    fn validate_checked(
        &self,
        bytes: &[u8],
        rule: &str,
        options: &ValidationOptions,
        scratch: &mut Scratch,
    ) -> Result<schema::Checked, Failure> {
        let r = self.rule(rule)?;
        if bytes.len() >= i32::MAX as usize {
            return Err(failure(20, "cbor/too_large"));
        }
        schema::validate_checked(self.program.host(), r, bytes, &options.host(), scratch)
    }
    /// Validate the entire document before opening a zero-copy borrowed view.
    /// Valid input that is not its own deterministic form cannot be borrowed
    /// (`Error::Usage("owned_view")`): use [`Schema::document`].
    pub fn view<'a>(
        &self,
        bytes: &'a [u8],
        rule: &str,
        scratch: &mut Scratch,
    ) -> Result<crate::View<'a>, Error> {
        let c = self.validate_checked(bytes, rule, &ValidationOptions::default(), scratch)?;
        if c.copy.is_some() {
            return Err(Error::Usage("owned_view"));
        }
        Ok(crate::view::checked_keys(bytes, c.unsorted))
    }
    /// Validate, then keep the document (or its canonical copy, P8.4) for viewing.
    pub fn document(
        &self,
        bytes: &[u8],
        rule: &str,
        options: &ValidationOptions,
        scratch: &mut Scratch,
    ) -> Result<crate::view::Document, Error> {
        let c = self.validate_checked(bytes, rule, options, scratch)?;
        Ok(crate::view::Document::from_checked(c.copy.unwrap_or_else(|| bytes.to_vec()), c.unsorted))
    }
    /// Validate an immutable known-length [`Blob`] through the session driver,
    /// reading `source.chunk` bytes (or what the session needs) at a time.
    /// Source and API failures are the outer `Error` (an unknown rule is
    /// `Error::Usage("unknown_rule")`, bad options `Error::Usage("options")`, a
    /// backend's `io::Error` [`Error::Io`]); CBOR/CDDL verdicts are the inner
    /// `Result`, the buffer's for the same bytes.
    pub fn validate_blob(
        &self,
        blob: &dyn Blob,
        rule: &str,
        options: &ValidationOptions,
        source: &SourceOptions,
    ) -> Result<Result<(), Failure>, Error> {
        let r = self.rule_id(rule)?;
        let (chunk, quantum) = source.checked()?;
        schema::validate_blob(self.program.host(), r, blob, &options.host(), chunk, quantum).map_err(Error::from)
    }
    /// D085: validate a message of UNKNOWN length read from `reader` until EOF
    /// (drain mode: the verdict equals the buffer's of the same bytes, holding at
    /// most what the session asks for plus one `source.chunk`). With
    /// `source.fail_fast` a certain refusal is answered at once; its code may
    /// then differ from the buffer's (`cbor/truncated` or `cbor/too_large`), its
    /// accept/refuse never does. A sync reader never yields: `source.quantum`
    /// only bounds the work per step. A read error is [`Error::Io`], the reader's
    /// own error.
    pub fn validate_reader(
        &self,
        reader: &mut dyn std::io::Read,
        rule: &str,
        options: &ValidationOptions,
        source: &SourceOptions,
    ) -> Result<Result<(), Failure>, Error> {
        let r = self.rule_id(rule)?;
        let (chunk, quantum) = source.checked()?;
        schema::validate_reader(self.program.host(), r, reader, &options.host(), chunk, quantum, source.fail_fast)
            .map_err(Error::from)
    }
}
/// In-memory borrowed Blob. Range arithmetic is checked for every read.
pub struct BytesBlob<'a>(pub &'a [u8]);
impl Blob for BytesBlob<'_> {
    fn size(&self) -> usize {
        self.0.len()
    }
    fn read(&self, offset: usize, len: usize) -> Result<Vec<u8>, schema::SourceError> {
        let end = offset.checked_add(len).ok_or(schema::SourceError::Read)?;
        self.0
            .get(offset..end)
            .map(|b| b.to_vec())
            .ok_or(schema::SourceError::Read)
    }
}

/// The compiler sees a registry through `compile::Registry` (it builds without the VM).
impl crate::compile::Registry for crate::controls::Controls {
    fn words(&self) -> Vec<i32> {
        crate::controls::Controls::words(self)
    }
    fn argument_ok(&self, name: &str, argument: &[u8]) -> bool {
        self.get(name).is_none_or(|c| c.argument(argument))
    }
    fn argument_detail(&self, name: &str, argument: &[u8]) -> Option<String> {
        self.get(name).and_then(|c| c.argument_detail(argument))
    }
    fn argument_ok_in(&self, name: &str, argument: &[u8], abnf: crate::compile::AbnfMode) -> bool {
        let lenient = abnf == crate::compile::AbnfMode::Lenient;
        self.get(name).is_none_or(|c| c.argument_in(argument, lenient))
    }
    fn argument_detail_in(&self, name: &str, argument: &[u8], abnf: crate::compile::AbnfMode) -> Option<String> {
        let lenient = abnf == crate::compile::AbnfMode::Lenient;
        self.get(name).and_then(|c| c.argument_detail_in(argument, lenient))
    }
}
