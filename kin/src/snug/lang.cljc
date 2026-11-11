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

(def BytesW
  "A WRITABLE run of bytes (the writer's output buffer and its scratch,
  P5.4): `Uint8Array` / `&mut [u8]`. `u8` and `blen` read it as they read
  `Bytes`; `bset` writes one byte and `bcopy` copies a range from ANOTHER
  buffer. Same borrow rules as `Ints`; a `BytesW` may be passed where a
  `Bytes` is taken (Rust reborrows `&mut [u8]` as `&[u8]`)."
  {:name 'BytesW :types {:js "Uint8Array" :rust "&mut [u8]"}})

(def Ext
  "An EXTENSION-CONTROL predicate port (D082, D140, D190): the host's verdict
  for an `EXT` leaf, `(ext id pool arg-off arg-len b item-start item-end room)
  -> verdict`, called by the VM only when such a leaf is queried and the item
  is whole in `b`, with `room` the budget units that remain. The verdict word:
  u >= 0 matched after u units of work, -2 - u refused after u units, -1 the
  work needs more than `room` (the VM stops with `budget`). A JS function / a
  Rust `&dyn Fn` trait object. A generic control meters its own work in kin; a
  host predicate reports its declared cost (by default one unit per item byte),
  checked against `room` BEFORE it runs. The VM charges u and never calls a
  predicate on a dead item."
  {:name 'Ext :types {:js "Function"
                      :rust "&dyn Fn(i32, &[u8], i32, i32, &[u8], i32, i32, i32) -> i32"}})

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

(defn- bset-form
  "`(bset b i v)` -- a statement: byte i of a `BytesW` becomes the LOW 8 BITS
  of v (a `Uint8Array` store truncates; Rust `as u8` truncates). Unchecked,
  like `iset`: the source checks i."
  [ctx form]
  (when-not (and (= 4 (count form)) (= :statement (kin/position ctx)))
    (throw (ex-info "snug: `(bset b i v)` is a statement of three arguments"
                    {:form form})))
  (let [[b i v] (map (fn [x] (kin/render ctx x)) (rest form))
        i (kl/strip-parens i)
        v (kl/strip-parens v)]
    (kin/emit! ctx (kin/indent-of ctx)
               (case (:target ctx)
                 :js (str b "[" i "] = " v ";\n")
                 :rust (str b "[(" i ") as usize] = (" v ") as u8;\n")))))

(defn- bcopy-form
  "`(bcopy dst at src s n)` -- a statement: dst[at..at+n) = src[s..s+n), for
  two DIFFERENT buffers (Rust cannot borrow one slice twice). Unchecked: the
  source checks both ranges (Rust would panic, JS would clamp silently)."
  [ctx form]
  (when-not (and (= 6 (count form)) (= :statement (kin/position ctx)))
    (throw (ex-info "snug: `(bcopy dst at src s n)` is a statement of five arguments"
                    {:form form})))
  (let [[d at src s n] (map (fn [x] (kl/strip-parens (kin/render ctx x))) (rest form))]
    (kin/emit! ctx (kin/indent-of ctx)
               (case (:target ctx)
                 :js (str d ".set(" src ".subarray(" s ", (" s ") + (" n ")), " at ");\n")
                 :rust (str d "[(" at ") as usize..((" at ") + (" n ")) as usize]"
                            ".copy_from_slice(&" src "[(" s ") as usize..((" s ") + (" n ")) as usize]);\n")))))

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
   'bset bset-form
   'bcopy bcopy-form
   'hex hex-form
   ;; extension controls (D140, D190): call a predicate (a verdict word); the one that never matches
   'ext-call (op "({0}({1}, {2}, {3}, {4}, {5}, {6}, {7}, {8}) | 0)"
                 "{0}({1}, {2}, {3}, {4}, {5}, {6}, {7}, {8})" I32)
   ;; P8.4 (D266): empty buffers, for an entry point that has none to give
   'ints-none (kl/call {:js "(new Int32Array(0))" :rust "&mut []"} {:tag Ints :arity 0})
   'bytes-none (kl/call {:js "(new Uint8Array(0))" :rust "&mut []"} {:tag BytesW :arity 0})
   'ext-none (kl/call {:js "((_i, _p, _ao, _al, _b, _s, _e, _r) => -2)"
                       :rust "&|_: i32, _: &[u8], _: i32, _: i32, _: &[u8], _: i32, _: i32, _: i32| -2"}
                      {:tag Ext :arity 0})})

(def vocabulary
  {:namespace 'snug.lang
   :targets #{:js :rust}
   :tags {'I32 I32 'Bool Bool 'Bytes Bytes 'BytesW BytesW 'Ints Ints 'IntsR IntsR 'Str Str 'Ext Ext}
   :names {}
   :forms forms
   ;; An unannotated integer literal is an I32 and `true`/`false` a Bool, so a
   ;; local initialised from one needs no annotation.
   :literal-tag (fn [v] (cond (integer? v) I32 (boolean? v) Bool))})
