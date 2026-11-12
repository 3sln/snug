// P9.16: depending on host/rust directly (without kin/scripts/rust-crate) leaves the
// generated modules out; src/lib.rs then answers one compile_error! naming the fix.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(snug_unassembled)");
    println!("cargo::rerun-if-changed=src/snug.rs");
    let dir = std::env::var_os("CARGO_MANIFEST_DIR").map(std::path::PathBuf::from).unwrap_or_default();
    if !dir.join("src/snug.rs").exists() {
        println!("cargo::rustc-cfg=snug_unassembled");
    }
}
