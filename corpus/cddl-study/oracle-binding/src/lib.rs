// Study binding: compile CDDL text -> handle; validate CBOR (or JSON) against a named rule;
// return structured errors {path, reason-category} without echoing payload values.
use std::cell::RefCell;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

use cddl::ast::{Rule, CDDL};
use cddl::validator::cbor::{self, CBORValidator};
use cddl::validator::cbor_value::decode_cbor;
use cddl::validator::json::{self, JSONValidator};
use cddl::validator::Validator;

struct Compiled {
  // AST borrows from `src`; `src` is a leaked Box<str> freed after the ASTs in Drop.
  src: *mut str,
  base: CDDL<'static>,
  by_rule: HashMap<String, CDDL<'static>>,
  keys: std::collections::HashSet<String>,
}
impl Drop for Compiled {
  fn drop(&mut self) {
    self.by_rule.clear();
    self.base = CDDL::default();
    unsafe { drop(Box::from_raw(self.src)); }
  }
}

thread_local! {
  static HANDLES: RefCell<HashMap<u32, Compiled>> = RefCell::new(HashMap::new());
  static NEXT: RefCell<u32> = RefCell::new(1);
}

fn rule_name<'a>(r: &'a Rule<'a>) -> &'a str {
  match r { Rule::Type { rule, .. } => rule.name.ident, Rule::Group { rule, .. } => rule.name.ident }
}

/// Literal member names that appear in the schema; other path segments are masked.
fn schema_keys(src: &str) -> std::collections::HashSet<String> {
  let mut out = std::collections::HashSet::new();
  let b = src.as_bytes();
  let mut i = 0;
  while i < b.len() {
    let c = b[i];
    if c == b'"' {
      let start = i + 1; let mut j = start;
      while j < b.len() && b[j] != b'"' { j += 1; }
      if j - start <= 64 { out.insert(src[start..j.min(b.len())].to_string()); }
      i = j + 1; continue;
    }
    if c.is_ascii_alphabetic() || c == b'_' || c == b'$' || c == b'@' {
      let start = i; let mut j = i;
      while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b'-' || b[j] == b'.' || b[j] == b'$' || b[j] == b'@') { j += 1; }
      if j - start <= 64 { out.insert(src[start..j].to_string()); }
      i = j; continue;
    }
    i += 1;
  }
  out
}

fn json_escape(s: &str) -> String {
  let mut o = String::new();
  for ch in s.chars() { match ch { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) } }
  o
}

fn categorize(reason: &str) -> &'static str {
  let r = reason.to_ascii_lowercase();
  if r.contains("missing") || r.contains("required") { "missing" }
  else if r.contains("regex") || r.contains("pcre") { "pattern" }
  else if r.contains(".size") || r.contains("size") || r.contains("length") { "size" }
  else if r.contains("bits") { "bits" }
  else if r.contains("tag") { "tag" }
  else if r.contains("range") || r.contains(".lt") || r.contains(".le") || r.contains(".gt") || r.contains(".ge") { "range" }
  else if r.contains("expected type") || r.contains("expected uint") || r.contains("expected int") { "type" }
  else if r.contains("unexpected") || r.contains("unknown") || r.contains("not allowed") || r.contains("extra") { "unexpected" }
  else if r.contains("cbor") { "embedded" }
  else if r.contains("expected") { "value" }
  else { "invalid" }
}

fn mask_path(p: &str, keys: &std::collections::HashSet<String>) -> String {
  if p.is_empty() { return String::new(); }
  p.split('/').map(|seg| {
    let bare = seg.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(seg);
    if seg.is_empty() || seg.bytes().all(|c| c.is_ascii_digit()) || keys.contains(bare) { bare.to_string() } else { "*".to_string() }
  }).collect::<Vec<_>>().join("/")
}

fn errors_json(list: Vec<(String, String)>, keys: &std::collections::HashSet<String>) -> String {
  let mut o = String::from("{\"ok\":false,\"errors\":[");
  for (i, (path, reason)) in list.iter().take(8).enumerate() {
    if i > 0 { o.push(','); }
    o.push_str(&format!("{{\"path\":\"{}\",\"reason\":\"{}\"}}", json_escape(&mask_path(path, keys)), categorize(reason)));
  }
  o.push_str(&format!("],\"count\":{}}}", list.len()));
  o
}

/// Compile CDDL text. Returns a handle (>0) or 0 on failure (call `last_error`).
#[wasm_bindgen]
pub fn compile(text: &str) -> u32 {
  let src: *mut str = Box::into_raw(text.to_string().into_boxed_str());
  let s: &'static str = unsafe { &*src };
  match cddl::pest_bridge::cddl_from_pest_str_checked(s) {
    Ok(ast) => {
      let id = NEXT.with(|n| { let mut n = n.borrow_mut(); let id = *n; *n += 1; id });
      let keys = schema_keys(s);
      HANDLES.with(|h| h.borrow_mut().insert(id, Compiled { src, base: ast, by_rule: HashMap::new(), keys }));
      set_last(String::new());
      id
    }
    Err(e) => {
      // Parser errors refer to schema text only (no payload); keep a short message.
      let mut m = e.to_string(); m.truncate(400); set_last(m);
      unsafe { drop(Box::from_raw(src)); }
      0
    }
  }
}

thread_local! { static LAST: RefCell<String> = RefCell::new(String::new()); }
fn set_last(s: String) { LAST.with(|l| *l.borrow_mut() = s); }
#[wasm_bindgen]
pub fn last_error() -> String { LAST.with(|l| l.borrow().clone()) }

#[wasm_bindgen]
pub fn free(handle: u32) { HANDLES.with(|h| { h.borrow_mut().remove(&handle); }); }

#[wasm_bindgen]
pub fn rules(handle: u32) -> String {
  HANDLES.with(|h| h.borrow().get(&handle).map(|c| c.base.rules.iter().map(|r| rule_name(r).to_string()).collect::<Vec<_>>().join(",")).unwrap_or_default())
}

fn with_rule<R>(handle: u32, rule: &str, f: impl FnOnce(&CDDL<'static>, &std::collections::HashSet<String>) -> R) -> Result<R, String> {
  HANDLES.with(|h| {
    let mut h = h.borrow_mut();
    let c = h.get_mut(&handle).ok_or("no_handle")?;
    if !c.by_rule.contains_key(rule) {
      let idx = c.base.rules.iter().position(|r| matches!(r, Rule::Type{rule: tr, ..} if tr.name.ident == rule && tr.generic_params.is_none())).ok_or("no_rule")?;
      let mut cl = c.base.clone();
      let r = cl.rules.remove(idx);
      cl.rules.insert(0, r);
      c.by_rule.insert(rule.to_string(), cl);
    }
    let ast = c.by_rule.get(rule).unwrap();
    // Safety: the AST lives as long as the handle; validation does not outlive this call.
    let ast: &'static CDDL<'static> = unsafe { &*(ast as *const CDDL<'static>) };
    let keys: &'static std::collections::HashSet<String> = unsafe { &*(&c.keys as *const _) };
    drop(h);
    Ok(f(ast, keys))
  })
}

/// Validate CBOR bytes against `rule`. Returns JSON {ok} or {ok:false, errors:[{path, reason}], count}.
#[wasm_bindgen]
pub fn validate_cbor(handle: u32, rule: &str, bytes: &[u8]) -> String {
  match with_rule(handle, rule, |ast, keys| {
    let value = match decode_cbor(bytes) { Ok(v) => v, Err(_) => return "{\"ok\":false,\"errors\":[{\"path\":\"\",\"reason\":\"decode\"}],\"count\":1}".to_string() };
    let mut cv = CBORValidator::new(ast, value, None);
    match Validator::<cbor::Error<std::io::Error>>::validate(&mut cv) {
      Ok(()) => "{\"ok\":true}".to_string(),
      Err(cbor::Error::Validation(errs)) => errors_json(errs.into_iter().map(|e| (e.cbor_location, e.reason)).collect(), keys),
      Err(_) => "{\"ok\":false,\"errors\":[{\"path\":\"\",\"reason\":\"schema\"}],\"count\":1}".to_string(),
    }
  }) { Ok(s) => s, Err(e) => format!("{{\"ok\":false,\"errors\":[{{\"path\":\"\",\"reason\":\"{}\"}}],\"count\":1}}", e) }
}

/// Raw (unsanitized) reasons, for the study only: lets us see whether reasons echo payload values.
#[wasm_bindgen]
pub fn debug_validate_cbor_raw(handle: u32, rule: &str, bytes: &[u8]) -> String {
  match with_rule(handle, rule, |ast, _| {
    let value = match decode_cbor(bytes) { Ok(v) => v, Err(e) => return format!("decode: {}", e) };
    let mut cv = CBORValidator::new(ast, value, None);
    match Validator::<cbor::Error<std::io::Error>>::validate(&mut cv) { Ok(()) => "ok".to_string(), Err(e) => e.to_string() }
  }) { Ok(s) => s, Err(e) => e }
}

#[wasm_bindgen]
pub fn validate_json(handle: u32, rule: &str, text: &str) -> String {
  match with_rule(handle, rule, |ast, keys| {
    let value: serde_json::Value = match serde_json::from_str(text) { Ok(v) => v, Err(_) => return "{\"ok\":false,\"errors\":[{\"path\":\"\",\"reason\":\"decode\"}],\"count\":1}".to_string() };
    let mut jv = JSONValidator::new(ast, value, None);
    match Validator::<json::Error>::validate(&mut jv) {
      Ok(()) => "{\"ok\":true}".to_string(),
      Err(json::Error::Validation(errs)) => errors_json(errs.into_iter().map(|e| (e.json_location, e.reason)).collect(), keys),
      Err(_) => "{\"ok\":false,\"errors\":[{\"path\":\"\",\"reason\":\"schema\"}],\"count\":1}".to_string(),
    }
  }) { Ok(s) => s, Err(e) => format!("{{\"ok\":false,\"errors\":[{{\"path\":\"\",\"reason\":\"{}\"}}],\"count\":1}}", e) }
}

/// Deliberate panic, to observe containment.
#[wasm_bindgen]
pub fn debug_panic() -> u32 { let v: Vec<u32> = Vec::new(); v[std::hint::black_box(3)] }
