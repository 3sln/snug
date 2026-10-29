//! The CDDL compiler's Rust entry point: a thin loop around the generated kin
//! compiler (`snug::compile::main`). Every decision -- syntax, semantics,
//! limits, the compile budget, the Program's bytes -- is kin's; this file owns
//! only the arena, the decimal float-literal port (D020: `str::parse::<f64>`,
//! at most 17 significant digits, checked by kin) and the result's shape.
use crate::snug::compile::arena::{ARENA_MAX_WORDS, ARENA_MIN_WORDS, ERR_ARENA, ERR_NEED_FLOATS};
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
}

/// A compiled schema: the Program words and pool (docs/program.md, format 1)
/// and the rule names in RULES order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Compiled {
    pub program: Vec<i32>,
    pub pool: Vec<u8>,
    pub rules: Vec<String>,
}

/// Option order: program.md §13.3's source key, then the leaf limit.
pub const COMPILE_OPTIONS: [&str; 18] = [
    "schemaBytes", "nesting", "astNodes", "instantiations", "alternatives", "arrayPositions",
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

pub fn compile_bytes(bytes: &[u8], profile: i32, limits: &[i32]) -> Result<Compiled, SchemaError> {
    let mut opt = vec![-1i32; kc::OPT_WORDS as usize];
    opt[0] = profile;
    for (i, v) in limits.iter().enumerate().take(opt.len() - 1) {
        opt[i + 1] = *v;
    }
    let mut fl: Vec<i32> = Vec::new();
    ARENA.with(|cell| {
        let mut h = cell.borrow_mut();
        loop {
            let code = kc::compile_schema(bytes, &opt, &fl, &mut h);
            if code == ERR_ARENA {
                if h.len() >= ARENA_MAX_WORDS as usize {
                    return Err(SchemaError { code: "limit_memory", line: 0, column: 0, rule: None });
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
                return Err(SchemaError {
                    code: kc::error_name(code),
                    line: kc::error_line(&h),
                    column: kc::error_column(&h),
                    rule,
                });
            }
            if kc::out_program_words(&h) < 64 {
                return Err(SchemaError { code: "internal", line: 0, column: 0, rule: None });
            }
            let p = kc::out_program_at(&h) as usize;
            let b = kc::out_pool_at(&h) as usize;
            let program = h[p..p + kc::out_program_words(&h) as usize].to_vec();
            let pool: Vec<u8> = h[b..b + kc::out_pool_bytes(&h) as usize].iter().map(|&x| x as u8).collect();
            let rules = rule_names(&program, &pool);
            return Ok(Compiled { program, pool, rules });
        }
    })
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
