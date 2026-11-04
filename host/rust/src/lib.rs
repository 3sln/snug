//! snug's Rust host: the generated modules (`snug::*`, from kin) and nothing
//! that decides accept or refuse (D003).
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
pub use value::{Value, Integer, TypedArray};
pub use error::Error;
pub use decode::{decode, DecodeOptions, Limits, Top};
pub use encode::{encode, EncodeOptions};
pub use writer::Writer;
pub use program::Program;
pub use view::{View, Cursor, TypedView, TypedElement};
pub use api::{Schema, CompileOptions, CompileLimits, CompilerProfile, ValidationOptions,
    Scratch, Failure, Segment, Blob, BytesBlob, validate_blob};
