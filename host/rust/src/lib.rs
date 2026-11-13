//! snug: CDDL (RFC 8610) validation directly over CBOR (RFC 8949) bytes, in one
//! pass and without a decoded value tree; a strict CBOR codec; checked views; and
//! drivers for blobs, unknown-length streams and CBOR sequences (RFC 8742), sync
//! and async.
//!
//! ```
//! use snug::{CompileOptions, Schema, Scratch};
//! let schema = Schema::compile("message = { id: uint }", &CompileOptions::default())?;
//! schema.validate(&[0xa1, 0x62, b'i', b'd', 7], "message", &mut Scratch::new())?;
//! let refused = schema.validate(&[0xa1, 0x62, b'i', b'd', 0x20], "message", &mut Scratch::new());
//! assert_eq!(refused.unwrap_err().reason, "type");
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! Start at [`Schema`] (compile, validate, decode, views), [`decode()`] /
//! [`encode()`] / [`Writer`] / [`View`] for the codec, and
//! [`Schema::validate_reader`], [`read_sequence`] and their async forms for
//! sources. Everything a public signature names is re-exported here, at the
//! crate root; use these paths. The modules `compile`, `schema`, `sha256`,
//! `unicode_tables` and the generated `snug` are public for snug's own test
//! hosts and may change in any release.
//!
//! Refusals carry a code, an offset and a schema-named path, never payload
//! values. The README of the crate and the Rust guide (`docs/rust.md` in the
//! repository) cover the options, limits and error codes.

// The generated modules (src/snug/) exist only in the crate kin/scripts/rust-crate
// assembles (build.rs answers `snug_unassembled` without them): one clear error
// instead of a module-not-found error for every generated module.
#[cfg(snug_unassembled)]
compile_error!(
    "snug: the generated modules (src/snug/) are missing. Assemble the crate with \
     `kin/scripts/rust-crate <dir>` from the snug repository and depend on <dir>, \
     not on host/rust (see host/rust/README.md)."
);

macro_rules! assembled {
    ($($item:item)*) => { $( #[cfg(not(snug_unassembled))] $item )* };
}

assembled! {
pub mod snug;
pub mod compile;
pub mod schema;
pub mod sha256;
pub mod unicode_tables;
pub mod value;
pub mod error;
pub mod decode;
pub mod encode;
pub mod writer;
pub mod program;
pub mod view;
pub mod api;
pub mod controls;
pub mod abnf;
pub mod sequence;
pub mod async_source;
pub mod sessions;
pub use value::{Value, Integer, TypedArray};
pub use error::{Error, IoError};
pub use decode::{decode, DecodeOptions, Floats, Keys, Limits, Profile, Tags, Top};
pub use encode::{encode, EncodeOptions};
pub use writer::Writer;
pub use program::Program;
pub use view::{View, Cursor, TypedView, TypedElement, Document};
pub use api::{Schema, CompileOptions, CompileLimits, CompilerProfile, ValidationOptions, SourceOptions,
    Scratch, Failure, Segment, Blob, BytesBlob};
pub use compile::{AbnfMode, Cuts, Regexp, SchemaError, Warning};
pub use schema::SourceError;
pub use controls::{Control, Controls};
pub use sequence::{read_sequence, Message, MessageFailure, OnInvalid, Sequence, SequenceOptions, SequenceReader};
pub use async_source::{read_sequence_async, AsyncBlob, AsyncSequenceReader, AsyncSource};
}
