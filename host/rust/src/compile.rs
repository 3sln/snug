//! The CDDL compiler's Rust entry point: a thin loop around the generated kin
//! compiler (`snug::compile::main`). Every decision -- syntax, semantics,
//! limits, the compile budget, the Program's bytes -- is kin's; this file owns
//! only the arena, the decimal float-literal port (D020: `str::parse::<f64>`,
//! at most 17 significant digits, checked by kin) and the result's shape.
use crate::snug::compile::arena::{ARENA_MAX_WORDS, ARENA_MIN_WORDS, ERR_ARENA, ERR_NEED_FLOATS, ERR_NEED_UNICODE, ERR_REGEXP_BLOCK};
use crate::snug::compile::main as kc;
use std::cell::RefCell;

/// A schema the compiler refuses: a stable code name, 1-based line and column
/// (column in code points; 0 when not about a place in the text), and the rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError {
    pub code: &'static str,
    pub line: i32,
    pub column: i32,
    pub rule: Option<String>,
    pub message: &'static str,
    /// Schema-text detail (never payload): at `unknown_control` the control's name,
    /// at a refused control argument the control's name (D141, D142).
    pub detail: Option<String>,
}

/// A compiled schema: the Program words and pool (docs/program.md with the
/// format 2.0 delta of docs/program-2.md), the rule names in RULES order and
/// the compile warnings (architecture §20.11; they never refuse).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Compiled {
    pub program: Vec<i32>,
    pub pool: Vec<u8>,
    pub rules: Vec<String>,
    pub warnings: Vec<Warning>,
}

/// A compile warning: its stable code (`W1`..`W8`), the rule it is in (None for
/// a schema-wide warning), its 1-based line and column (0 when about no place)
/// and a fixed message. Identical on every host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
    pub code: &'static str,
    pub rule: Option<String>,
    pub line: i32,
    pub column: i32,
    pub message: &'static str,
}

/// The snug version (kin's, so both hosts agree).
pub fn snug_version() -> &'static str {
    kc::snug_version()
}

/// Option order: program.md §13.3's source key, then the leaf limit.
pub const COMPILE_OPTIONS: [&str; 18] = [
    "schemaBytes", "nesting", "astNodes", "instantiations", "pegNodes", "arrayPositions",
    "regexpPositions", "width", "poolBytes", "totalBytes", "compileBudget", "depth", "inputBytes",
    "entries", "items", "bignumBytes", "budget", "leaves",
];

thread_local! {
    static ARENA: RefCell<Vec<i32>> = RefCell::new(vec![0; ARENA_MIN_WORDS as usize]);
}

/// Compile CDDL text. `profile`: 0 full, 1 bindle, 2 bus. `limits`: values in
/// COMPILE_OPTIONS order, -1 for the default (shorter slices mean defaults).
pub fn compile(text: &str, profile: i32, limits: &[i32]) -> Result<Compiled, SchemaError> {
    compile_bytes(text.as_bytes(), profile, limits)
}

/// Compile-time regexp dialect (D242); both lower to the existing portable automaton.
/// Not exhaustive (D339).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Regexp {
    #[default]
    Xsd,
    IRegexp,
}

/// Cut semantics (D301): the literal RFC 8610 cut (`Rfc`, the default; commitment
/// epochs, D273) or rule A (`Branch`: a failed cut fails only its choice branch).
/// Not exhaustive (D339).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Cuts {
    #[default]
    Rfc,
    Branch,
}

/// Optional explicit compile-time Unicode ranges (the default loads no tables)
/// and extension controls (D141; none by default).
#[derive(Default)]
pub struct CompileOptions<'a> {
    pub profile: i32,
    pub regexp: Regexp,
    /// Format 2.0: the cut mode (D301: `Rfc` by default, `Branch` = rule A, D273).
    pub cuts: Cuts,
    /// Format 2.0: the PEG group arena cap in words (D276, D281); None = the default.
    pub group_words: Option<i32>,
    pub limits: &'a [i32],
    pub unicode: Option<&'a [i32]>,
    pub controls: Option<&'a dyn Registry>,
}

/// What the compiler needs of an extension-control registry (D141):
/// `snug::controls::Controls` is one. A trait here, so the compiler builds
/// without the VM's modules.
pub trait Registry {
    /// The registry words after the compile options (snug.compile.ext).
    fn words(&self) -> Vec<i32>;
    /// Whether control `name` accepts `argument` (an encoding), at compile time.
    fn argument_ok(&self, name: &str, argument: &[u8]) -> bool;
}

pub fn compile_with_options(text: &str, options: &CompileOptions<'_>) -> Result<Compiled, SchemaError> {
    compile_bytes_with_options(text.as_bytes(), options)
}

pub fn compile_bytes(bytes: &[u8], profile: i32, limits: &[i32]) -> Result<Compiled, SchemaError> {
    compile_bytes_with_options(bytes, &CompileOptions { profile, limits, ..Default::default() })
}

pub fn compile_bytes_with_options(bytes: &[u8], options: &CompileOptions<'_>) -> Result<Compiled, SchemaError> {
    let CompileOptions { profile, limits, unicode, controls, regexp, cuts, group_words } = options;
    let mut opt = vec![-1i32; kc::OPT_WORDS as usize];
    opt[0] = *profile;
    for (i, v) in limits.iter().enumerate().take(COMPILE_OPTIONS.len()) {
        opt[i + 1] = *v;
    }
    opt[kc::OPT_REGEXP as usize] = if *regexp == Regexp::IRegexp { 1 } else { 0 };
    opt[kc::OPT_CUTS as usize] = if *cuts == Cuts::Branch { 1 } else { 0 };
    opt[kc::OPT_GROUP_WORDS as usize] = group_words.unwrap_or(-1);
    // D141: the extension-control registry rides after the OPT_WORDS options
    if let Some(c) = controls {
        opt.extend(c.words());
    }
    let mut fl: Vec<i32> = Vec::new();
    let r = ARENA.with(|cell| {
        let mut h = cell.borrow_mut();
        loop {
            let code = kc::compile_schema(bytes, &opt, &fl, unicode.unwrap_or(&[]), &mut h);
            if code == ERR_ARENA {
                if h.len() >= ARENA_MAX_WORDS as usize {
                    return Err(SchemaError { code: "limit_memory", line: 0, column: 0, rule: None, message: "CDDL schema refused", detail: None });
                }
                let n = (h.len() * 2).min(ARENA_MAX_WORDS as usize);
                *h = vec![0; n];
                continue;
            }
            if code == ERR_NEED_FLOATS {
                fl = floats(&h, bytes);
                continue;
            }
            if code != 0 {
                let rs = kc::error_rule_start(&h);
                let rule = if rs >= 0 {
                    let s = rs as usize;
                    let e = s + kc::error_rule_len(&h) as usize;
                    bytes.get(s..e).map(|b| String::from_utf8_lossy(b).into_owned())
                } else {
                    None
                };
                let detail = if kc::error_name(code) == "unknown_control" { control_named(bytes, kc::error_offset(&h)) } else { None };
                return Err(SchemaError {
                    code: kc::error_name(code),
                    line: kc::error_line(&h),
                    column: kc::error_column(&h),
                    rule,
                    message: if code == ERR_NEED_UNICODE {
                        "Unicode categories require snug::unicode_tables (snug/unicode)"
                    } else if code == ERR_REGEXP_BLOCK {
                        "XSD block escapes require unavailable pinned Unicode block data"
                    } else { "CDDL schema refused" },
                    detail,
                });
            }
            if kc::out_program_words(&h) < 64 {
                return Err(SchemaError { code: "internal", line: 0, column: 0, rule: None, message: "CDDL schema refused", detail: None });
            }
            let p = kc::out_program_at(&h) as usize;
            let b = kc::out_pool_at(&h) as usize;
            let program = h[p..p + kc::out_program_words(&h) as usize].to_vec();
            let pool: Vec<u8> = h[b..b + kc::out_pool_bytes(&h) as usize].iter().map(|&x| x as u8).collect();
            // SOURCE_KEY (header words 7..14): SHA-256 of kin's deterministic preimage.
            let k = kc::key_preimage_at(&h) as usize;
            let pre: Vec<u8> = h[k..k + kc::key_preimage_len(&h) as usize].iter().map(|&x| x as u8).collect();
            let key = crate::sha256::sha256(&pre);
            let mut program = program;
            for i in 0..8 {
                program[7 + i] = i32::from_be_bytes([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
            }
            if let Some(c) = controls {
                check_arguments(&program, &pool, *c)?;
            }
            let rules = rule_names(&program, &pool);
            let warnings = (0..kc::warning_count(&h))
                .map(|i| {
                    let code = kc::warning_code(&h, i);
                    let rs = kc::warning_rule_start(&h, i);
                    let rule = if rs >= 0 {
                        let s = rs as usize;
                        bytes.get(s..s + kc::warning_rule_len(&h, i) as usize).map(|b| String::from_utf8_lossy(b).into_owned())
                    } else {
                        None
                    };
                    Warning { code: kc::warning_name(code), rule, line: kc::warning_line(&h, i), column: kc::warning_column(&h, i),
                        message: kc::warning_message(code) }
                })
                .collect();
            return Ok(Compiled { program, pool, rules, warnings });
        }
    });
    // A hostile schema may have grown the arena to tens of megabytes: do not keep that for the thread's life.
    ARENA.with(|cell| {
        let mut h = cell.borrow_mut();
        if h.len() > RETAIN_WORDS {
            *h = vec![0; ARENA_MIN_WORDS as usize];
        }
    });
    r
}

const RETAIN_WORDS: usize = 1 << 22;

/// D141: the name of a control the schema uses but the registry lacks (schema text).
fn control_named(bytes: &[u8], at: i32) -> Option<String> {
    let at = usize::try_from(at).ok()?;
    if bytes.get(at) != Some(&b'.') {
        return None;
    }
    let rest = &bytes[at + 1..];
    let n = rest.iter().take_while(|&&c| c.is_ascii_alphanumeric() || b"_-@$.".contains(&c)).count();
    Some(String::from_utf8_lossy(&rest[..n]).into_owned())
}

/// D142: a registered control may check its argument once, at compile time.
fn check_arguments(program: &[i32], pool: &[u8], controls: &dyn Registry) -> Result<(), SchemaError> {
    if program[30] == 0 {
        return Ok(());
    }
    let names = ext_names(program, pool);
    let (at, n) = (program[43] as usize, program[16] as usize);
    for l in 0..n {
        let o = at + 8 * l;
        if program[o] & 255 != 18 {
            continue;
        }
        let name = &names[program[o + 2] as usize];
        let (ao, al) = (program[o + 3] as usize, program[o + 4] as usize);
        if !controls.argument_ok(name, &pool[ao..ao + al]) {
            return Err(SchemaError { code: "control_value", line: 0, column: 0, rule: None,
                message: "CDDL schema refused", detail: Some(name.clone()) });
        }
    }
    Ok(())
}

/// The names of a compiled Program's extension controls (format 1.1's table, D141).
fn ext_names(p: &[i32], b: &[u8]) -> Vec<String> {
    let (n, mut i) = (p[30].max(0) as usize, p[31].max(0) as usize);
    let end = i + p[39].max(0) as usize;
    let mut names = Vec::new();
    while names.len() < n && i < end {
        let (mut len, mut c) = ((b[i] & 31) as usize, i + 1);
        if len == 24 {
            len = b[c] as usize;
            c += 1;
        }
        names.push(String::from_utf8_lossy(&b[c..c + len]).into_owned());
        i = c + len;
    }
    names
}

fn floats(h: &[i32], bytes: &[u8]) -> Vec<i32> {
    // D020/D032: kin found decimal float literals it cannot round itself.
    let n = kc::float_requests(h) as usize;
    let mut out = vec![0i32; 1 + 2 * n];
    out[0] = n as i32;
    for i in 0..n {
        let s = kc::float_request_start(h, i as i32) as usize;
        let e = kc::float_request_end(h, i as i32) as usize;
        let lit = std::str::from_utf8(&bytes[s..e]).unwrap_or("");
        let bits = lit.parse::<f64>().map(f64::to_bits).unwrap_or(0x7ff8_0000_0000_0000);
        out[1 + 2 * i] = (bits >> 32) as u32 as i32;
        out[2 + 2 * i] = bits as u32 as i32;
    }
    out
}

/// The rule names of a Program, in RULES order.
pub fn rule_names(program: &[i32], pool: &[u8]) -> Vec<String> {
    let at = program[42] as usize;
    let n = program[15] as usize;
    (0..n)
        .map(|i| {
            let off = program[at + 5 * i] as usize;
            let len = program[at + 5 * i + 1] as usize;
            String::from_utf8_lossy(&pool[off..off + len]).into_owned()
        })
        .collect()
}

#[cfg(test)]
mod unicode_tests {
    use super::*;

    #[test]
    fn optional_tables_and_missing_module_diagnostic() {
        let text = r#"r = tstr .regexp "\\p{L}""#;
        let error = compile(text, 0, &[]).unwrap_err();
        assert_eq!(error.code, "regexp");
        assert!(error.message.contains("snug::unicode_tables"));
        let tables = crate::unicode_tables::tables();
        let options = CompileOptions { unicode: Some(&tables), ..Default::default() };
        let result = compile_with_options(text, &options).unwrap();
        assert_eq!(result, compile_bytes_with_options(text.as_bytes(), &options).unwrap());
        assert_eq!(result.rules, vec!["r"]);
        assert_eq!(crate::unicode_tables::UNICODE_VERSION, "16.0");
    }
}
