(ns snug.lang
  "snug's own vocabulary: the four tags, the integer operators with their
  per-target semantics written down, and the byte and int-arena forms.

  THE SHAPE FORMS ARE NOT HERE. `defn`, `let`, `if`, `while`, `case`, `for`,
  `return`, `set`, `defconst`, `defdata` come from `kin.lang` -- kin's own map
  for Rust, and `snug.js`'s map (more of `kin.lang`, for `:js`) for
  JavaScript.

  ## Integer semantics: one meaning, two spellings

  Everything snug decides is 32-bit integer logic over bytes (D009). JS and
  Rust agree on that only if the vocabulary says exactly which operation is
  meant; the traps are all JavaScript's:

  * `+`, `-`, `*` are PLAIN arithmetic, for operands the source guarantees do
    not overflow i32 (lengths and positions bounded by the input size, which
    is < 2^31). JS computes them exactly in doubles; Rust in i32 (a debug
    build panics on overflow, which is how the gates catch a broken
    guarantee). Where wrapping is MEANT, say `add32`/`sub32`/`mul32`.
  * `quot` is `(a / b) | 0` in JS (`/` is float division) and `a / b` in Rust:
    both truncate toward zero. `rem` is `(a % b) | 0` (the `| 0` turns JS's
    `-0` into `0`) and `a % b`: both take the dividend's sign. The divisor must
    be non-zero (Rust panics; JS would give 0).
  * `shl` is `<<` on both for a count 0..31 (bits shifted out are lost on
    both). `sar` is the ARITHMETIC right shift, `>>` on both. `ushr` is the
    LOGICAL right shift reinterpreted as i32: `(a >>> n) | 0` in JS (whose
    `>>>` yields an unsigned number) and `((a as u32) >> n) as i32` in Rust.
  * `bit-and`/`bit-or`/`bit-xor`/`bit-not` are the same on both: JS's bitwise
    operators already produce int32.
  * `ult` is the unsigned 32-bit comparison, for an i32 holding a u32 bit
    pattern (a CBOR head argument).
  * `==`/`!=` are `===`/`!==` in JS.

  ## Bytes and arenas

  `Bytes` is the input: `Uint8Array` / `&[u8]`. `(u8 b i)` reads one byte as
  an i32 in 0..255 (a `Uint8Array` read already is; Rust casts). `Ints` is a
  read-write run of i32: `Int32Array` / `&mut [i32]`; `(ia a i)` reads and
  `(iset a i v)` writes (a statement).

  NOTHING HERE CHECKS A BOUND, on purpose and on both targets alike: the
  SOURCE checks every index before it reads, explicitly. An out-of-bounds
  read would be a panic in Rust and a silent `undefined` (NaN, then 0) in JS,
  and the scanner gates run hostile inputs through a debug Rust build so a
  missed check is a failure there rather than a quiet wrong answer.

  RUST BORROWS: an `Ints` is `&mut`, so it cannot be passed twice to one call,
  and a read of it nested in a call that also takes it mutably does not
  compile -- bind the read with `let` first. Passing it on to a callee is an
  implicit reborrow and is fine."
  (:require [kin]
            [kin.lang :as kl]
            [clojure.string :as str]))

;; ---------------------------------------------------------------- the tags

(def I32
  "A 32-bit signed integer: a JS number holding an int32, a Rust `i32`."
  {:name 'I32 :types {:js "number" :rust "i32"}})

(def Bool
  {:name 'Bool :types {:js "boolean" :rust "bool"}})

(def Bytes
  "The input bytes, read only. Shared on both targets (a borrow / a view)."
  {:name 'Bytes :types {:js "Uint8Array" :rust "&[u8]"}})

(def IntsR
  "A READ-ONLY run of i32 (a compiled Program, docs/program.md): `Int32Array`
  / `&[i32]`. `ia` and `ilen` read it; `iset` on one does not compile in Rust,
  so read-only is enforced on the stricter target. Shared immutably, so one
  Program can serve several Rust threads (program.md Q9)."
  {:name 'IntsR :types {:js "Int32Array" :rust "&[i32]"}})

(def Str
  "A string LITERAL the source returns (a name for a code): a JS string, a
  Rust `&'static str`. Never built, never compared; kin decides nothing on
  text (D009)."
  {:name 'Str :types {:js "string" :rust "&'static str"}})

(def Ints
  "A read-write run of i32 (an out array or a scratch arena). Shared on both
  targets: a JS typed array is a reference, a Rust `&mut [i32]` a borrow, so a
  callee's writes are visible to the caller on both and no aliasing mark is
  needed."
  {:name 'Ints :types {:js "Int32Array" :rust "&mut [i32]"}})

;; ---------------------------------------------------------------- the forms

(defn- op
  "A two-target template form producing `tag`."
  [js rust tag]
  (kl/call {:js js :rust rust} {:tag tag}))

(defn- same [tmpl tag] (op tmpl tmpl tag))

(defn- hex-form
  "`(hex 255)` -- an integer literal written in hex, `0xff` on both targets.
  The source says hex where hex is what a reader recognises (masks, heads).
  Refused above i32's range: `0xffffffff` is not an i32 literal in Rust."
  [ctx form]
  (let [v (second form)]
    (when-not (and (integer? v) (<= 0 v 0x7fffffff) (= 2 (count form)))
      (throw (ex-info (str "snug: `(hex " (pr-str v) ")` takes one integer"
                           " literal in 0..0x7fffffff")
                      {:form form})))
    (kin/tagged! ctx I32)
    (kin/emit! ctx (str "0x" (str/lower-case (Integer/toHexString (int v)))))))

(defn- iset-form
  "`(iset a i v)` -- a statement. The value is the whole right-hand side of an
  assignment, so its outer parentheses are noise (rustc warns on them)."
  [ctx form]
  (when-not (and (= 4 (count form)) (= :statement (kin/position ctx)))
    (throw (ex-info "snug: `(iset a i v)` is a statement of three arguments"
                    {:form form})))
  (let [[a i v] (map (fn [x] (kin/render ctx x)) (rest form))
        i (kl/strip-parens i)
        v (kl/strip-parens v)]
    (kin/emit! ctx (kin/indent-of ctx)
               (case (:target ctx)
                 :js (str a "[" i "] = " v ";\n")
                 :rust (str a "[(" i ") as usize] = " v ";\n")))))

(def forms
  {;; arithmetic the source guarantees not to overflow (see the ns doc)
   '+ (same "({0} + {1})" I32)
   '- (same "({0} - {1})" I32)
   '* (same "({0} * {1})" I32)
   'neg (same "(-{0})" I32)
   'quot (op "(({0} / {1}) | 0)" "({0} / {1})" I32)
   'rem (op "(({0} % {1}) | 0)" "({0} % {1})" I32)
   ;; wrapping 32-bit arithmetic, where wrapping is the meaning
   'add32 (op "(({0} + {1}) | 0)" "i32::wrapping_add({0}, {1})" I32)
   'sub32 (op "(({0} - {1}) | 0)" "i32::wrapping_sub({0}, {1})" I32)
   'mul32 (op "Math.imul({0}, {1})" "i32::wrapping_mul({0}, {1})" I32)
   ;; bits
   'bit-and (same "({0} & {1})" I32)
   'bit-or (same "({0} | {1})" I32)
   'bit-xor (same "({0} ^ {1})" I32)
   'bit-not (op "(~{0})" "(!{0})" I32)
   'shl (same "({0} << {1})" I32)
   'sar (same "({0} >> {1})" I32)
   'ushr (op "(({0} >>> {1}) | 0)" "(i32::cast_unsigned({0}) >> {1}).cast_signed()" I32)
   ;; comparisons
   '< (same "({0} < {1})" Bool)
   '> (same "({0} > {1})" Bool)
   '<= (same "({0} <= {1})" Bool)
   '>= (same "({0} >= {1})" Bool)
   '== (op "({0} === {1})" "({0} == {1})" Bool)
   '!= (op "({0} !== {1})" "({0} != {1})" Bool)
   'ult (op "(({0} >>> 0) < ({1} >>> 0))" "(i32::cast_unsigned({0}) < i32::cast_unsigned({1}))" Bool)
   ;; logic (short-circuit on both)
   'and (same "({0} && {1})" Bool)
   'or (same "({0} || {1})" Bool)
   'not (same "(!{0})" Bool)
   ;; bytes and arenas
   'u8 (op "{0}[{1}]" "({0}[({1}) as usize] as i32)" I32)
   'blen (op "{0}.length" "({0}.len() as i32)" I32)
   'ia (op "{0}[{1}]" "{0}[({1}) as usize]" I32)
   'ilen (op "{0}.length" "({0}.len() as i32)" I32)
   'iset iset-form
   'hex hex-form})

(def vocabulary
  {:namespace 'snug.lang
   :targets #{:js :rust}
   :tags {'I32 I32 'Bool Bool 'Bytes Bytes 'Ints Ints 'IntsR IntsR 'Str Str}
   :names {}
   :forms forms
   ;; An unannotated integer literal is an I32 and `true`/`false` a Bool, so a
   ;; local initialised from one needs no annotation.
   :literal-tag (fn [v] (cond (integer? v) I32 (boolean? v) Bool))})
