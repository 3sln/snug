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
    },
    /// Schema validation refusal (`code()` uses JS's `schema/` prefix).
    Validation(Failure),
    /// CDDL compilation refusal, including schema-only location metadata.
    Compile(SchemaError),
    /// Program container or verifier refusal, using JS ProgramError codes.
    Program(&'static str),
    /// API misuse; fixed codes never contain caller-provided strings.
    Usage(&'static str),
    /// Source protocol failure, using JS SourceError codes.
    Source(&'static str),
    /// A Program uses extension controls the registry lacks (D141); their
    /// names, from the Program (schema text, never payload).
    MissingControls(Vec<String>),
    /// A message of a CBOR sequence was refused (D216): its index, absolute
    /// offsets and verdict (`code()` as for [`Error::Validation`]).
    Sequence(crate::sequence::MessageFailure),
    /// P9.7: [`crate::sessions::SessionLimits::max_live`] sessions are live; drop (or
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
            Self::SessionLimit => "sessions/limit",
            Self::Internal => "internal",
        }
    }
    pub(crate) fn cbor(code: &'static str) -> Self {
        Self::Cbor { code, offset: None }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "snug: operation refused ({})", self.code())
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Validation(e) => Some(e),
            Self::Sequence(e) => Some(&e.failure),
            Self::Compile(e) => Some(e),
            _ => None,
        }
    }
}
impl From<Failure> for Error {
    fn from(e: Failure) -> Self {
        Self::Validation(e)
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
