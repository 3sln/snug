//! Safe diagnostics: codes and structural metadata, never payloads.
//!
//! ```
//! use snug::{decode, DecodeOptions};
//! let error = decode(&[0xff], &DecodeOptions::any()).unwrap_err();
//! assert_eq!(error.code(), "malformed");  // a lone break is not well-formed
//! let error = decode(&[0xbf, 0xff], &DecodeOptions::deterministic()).unwrap_err();
//! assert_eq!(error.code(), "indefinite");  // valid, but not deterministic
//! ```
use crate::{compile::SchemaError, schema::Failure};
use std::fmt;
use std::io;
/// Defined beside `SourceError` (the test hosts build `schema` without this module).
pub use crate::schema::IoError;

/// All public API error families. Validation itself returns [`Failure`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Error {
    /// A generated scanner/writer refusal, using JS's unprefixed code.
    Cbor {
        /// Stable code, for example `truncated`.
        code: &'static str,
        /// Byte offset, when the operation has one.
        offset: Option<usize>,
        /// Why, when the code alone does not say: `normalized` on an
        /// encoder's `duplicate_key` when two keys are one key once a bignum
        /// outside preferred serialization is written as its integer.
        subcode: Option<&'static str>,
    },
    /// Schema validation refusal (`code()` uses JS's `schema/` prefix).
    Validation(Failure),
    /// CDDL compilation refusal, including schema-only location metadata.
    Compile(SchemaError),
    /// Program container or verifier refusal, using JS ProgramError codes.
    Program(&'static str),
    /// API misuse; fixed codes never contain caller-provided strings.
    Usage(&'static str),
    /// Source protocol failure, using JS SourceError codes (`short_read`,
    /// `too_large`).
    Source(&'static str),
    /// The source's transport failed: its own error, whole. `code()` is
    /// `read`; [`std::error::Error::source`] answers the [`io::Error`].
    Io(IoError),
    /// A Program uses extension controls the registry lacks; their
    /// names, from the Program (schema text, never payload).
    MissingControls(Vec<String>),
    /// A message of a CBOR sequence was refused: its index, absolute
    /// offsets and verdict (`code()` as for [`Error::Validation`]).
    Sequence(crate::sequence::MessageFailure),
    /// [`crate::sessions::SessionLimits::max_live`] sessions are live; drop (or
    /// finish) one to release its slot. `code()` is `sessions/limit`.
    SessionLimit,
    /// A host/generated invariant failed, never a fabricated CBOR verdict.
    Internal,
}
impl Error {
    /// Stable JS-compatible error code. Misuse uses Rust-specific fixed codes
    /// because JavaScript exposes TypeError rather than a code for that family.
    pub fn code(&self) -> &str {
        match self {
            Self::Cbor { code, .. }
            | Self::Program(code)
            | Self::Usage(code)
            | Self::Source(code) => code,
            Self::Compile(e) => e.code,
            Self::MissingControls(_) => "missing_control",
            Self::Validation(e) | Self::Sequence(crate::sequence::MessageFailure { failure: e, .. }) => match e.reason {
                "type" => "schema/type",
                "missing" => "schema/missing",
                "unexpected" => "schema/unexpected",
                "value" => "schema/value",
                "size" => "schema/size",
                "range" => "schema/range",
                "pattern" => "schema/pattern",
                "tag" => "schema/tag",
                "bits" => "schema/bits",
                "embedded" => "schema/embedded",
                "control" => "schema/control",
                "control_size" => "schema/control_size",
                "group_limit" => "schema/group_limit",
                "budget" => "schema/budget",
                r => r.strip_prefix("cbor/").unwrap_or(r),
            },
            Self::Io(_) => "read",
            Self::SessionLimit => "sessions/limit",
            Self::Internal => "internal",
        }
    }
    /// The refusal's subcode, when it has one: `Error::Cbor`'s (`normalized`)
    /// or a validation failure's (`cut`, an embedded item's reason).
    pub fn subcode(&self) -> Option<&'static str> {
        match self {
            Self::Cbor { subcode, .. } => *subcode,
            Self::Validation(e) | Self::Sequence(crate::sequence::MessageFailure { failure: e, .. }) => e.subcode,
            _ => None,
        }
    }
    pub(crate) fn cbor(code: &'static str) -> Self {
        Self::Cbor { code, offset: None, subcode: None }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage("owned_view") => f.write_str(
                "snug: this input is valid but not its own deterministic form, so it is read through its \
                 canonical copy and cannot be viewed borrowed; use Schema::document (owned_view)",
            ),
            Self::Usage("poisoned") => f.write_str(
                "snug: an extension predicate panicked inside an earlier call; this sequence cannot go on (poisoned)",
            ),
            _ => write!(f, "snug: operation refused ({})", self.code()),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Validation(e) => Some(e),
            Self::Sequence(e) => Some(&e.failure),
            Self::Compile(e) => Some(e),
            Self::Io(e) => Some(e.get_ref()),
            _ => None,
        }
    }
}
/// A verdict as an error. The one API failure a [`Failure`] can carry, an unknown
/// rule (`code` −1), becomes `Error::Usage("unknown_rule")`, as every
/// `Result<_, Error>` API reports it.
impl From<Failure> for Error {
    fn from(e: Failure) -> Self {
        if e.code == -1 {
            return Self::Usage("unknown_rule");
        }
        Self::Validation(e)
    }
}
impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Self::Io(e.into())
    }
}
impl From<crate::schema::SourceError> for Error {
    fn from(e: crate::schema::SourceError) -> Self {
        use crate::schema::SourceError as S;
        match e {
            S::ShortRead { .. } => Self::Source("short_read"),
            S::Read => Self::Source("read"),
            S::TooLarge => Self::Source("too_large"),
            S::SessionLimit => Self::SessionLimit,
            S::Io(e) => Self::Io(e),
        }
    }
}
impl From<SchemaError> for Error {
    fn from(e: SchemaError) -> Self {
        Self::Compile(e)
    }
}
impl From<crate::sessions::SessionError> for Error {
    fn from(e: crate::sessions::SessionError) -> Self {
        match e {
            crate::sessions::SessionError::Limit => Self::SessionLimit,
            crate::sessions::SessionError::BadLimits => Self::Usage("session_limits"),
        }
    }
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "snug: validation refused ({})", self.reason)
    }
}
impl std::error::Error for Failure {}
impl fmt::Display for SchemaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "snug: schema refused ({}) at {}:{}",
            self.code, self.line, self.column
        )?;
        match &self.detail {
            Some(d) => write!(f, " (.{})", d),
            None => Ok(()),
        }
    }
}
impl std::error::Error for SchemaError {}
