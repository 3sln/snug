(ns snug.js
  "JavaScript, ADDED to `kin.lang` (D005) -- a second map under
  `:namespace 'kin.lang` with `:targets #{:js}`, the way `kin.lang` ships Go.
  A source that says `(:require [kin.lang :refer [defn let while]])` gets
  Rust's arms from `kin.lang` and JavaScript's from here; `kin.lang` is not
  edited, forked or required under another name.

  ## What is reused, and what is new

  Where `kin.lang`'s own function already writes valid JavaScript on its
  non-Rust path it is REUSED, not copied: `if`, `while`, `forever`, `case`
  (a `switch` whose arms each `return`), `break`, `continue`, `comment`,
  `do`, the `declare*` family, and `defdata` (whose binding this target's
  emitter supplies as a helper line, see `table`).

  New here, because the shape differs or the base form throws on an unknown
  target: `defn` (`export function f(a, b) {`), `let` (`const`, or `let` for a
  `^:mut` binding -- Rust refuses a reassigned non-`mut` binding, so `const`
  is safe), `local`, `return`, `set` (with JS's compound operators), `for`,
  `defconst` (`export const`), `doc` (a JSDoc block), `panic` (`throw`), and
  the generic operators (`==` is `===`; `quot` and `rem` coerce with `| 0`).

  ## Cross-module references

  A call from one generated module to a function another defines is a NAMED
  IMPORT -- `import { readArg } from './head.mjs';` -- computed from what the
  body referenced, through kin's own unit machinery: the target's `:unit`
  says what a namespace compiles to, the `:kin/unit` frame says where the
  reference is, and `:cross-unit` (in `snug.targets`) records the name. The
  call machinery (`declared-call` and `qualifier` in kin.lang) is private, so
  the twenty lines it takes are restated here (DEVLOG \"Found in kin\").

  LIMITATION: a `defdata` accessor called from ANOTHER module cannot be
  imported by name (kin hands `:cross-unit` an empty name for a table's
  `{unit}` prefix). Read a table through a `defn` in its own module when
  another module needs it."
  (:require [kin]
            [kin.lang :as kl]
            [kin.target :as kt]
            [clojure.string :as str]))

(defn- t [ctx] (:target ctx))

;; ------------------------------------------------------------- the call

(defn- home-unit
  "The unit the namespace being emitted compiles to: the open frame, else the
  target's `:unit` (asked during link, before any frame exists)."
  [ctx]
  (or (kin/get ctx :kin/unit) (kt/unit-of ctx (:kin/ns ctx))))

(defn- qualify
  "`(fn [name] -> spelling)` for a reference emitted in `c` to something
  `home` declares: bare within the unit; from another unit, the target's
  `:cross-unit` spelling with the import registered."
  [c home]
  (let [here (kin/get c :kin/unit)
        elsewhere? (and home here (not= home here))]
    (fn [nm]
      (if elsewhere?
        (do (kl/need! c home)
            ((get-in c [:targets (t c) :cross-unit] (fn [_ _ s] s)) c home nm))
        nm))))

(defn- js-call
  "The callable a `defn` registers: render the arguments, spell the (maybe
  imported) name, emit as a statement or an expression."
  [ret home nm]
  (fn [c f]
    (kin/tagged! c (kin/tag c ret))
    (let [as (mapv (fn [x] (kl/strip-parens (kin/render c x))) (rest f))
          code (str ((qualify c home) (kl/target-name c nm))
                    "(" (str/join ", " as) ")")]
      (if (= :statement (kin/position c))
        (kin/emit! c (kin/indent-of c) code ";\n")
        (kin/emit! c code)))))

(def ^:private js-defn
  {:declare
   (fn [ctx form]
     (let [nm (second form)]
       (kin/define-form! ctx {:scope (if (:pub (meta nm)) :public :private)} nm {})))
   :generate
   (fn [ctx form]
     (let [[_ nm params & body] form
           ret (:tag (meta nm))
           pub? (:pub (meta nm))]
       (when (or (:method (meta nm)) (:instance (meta nm)) (:throws (meta nm)))
         (throw (ex-info (str "snug.js: `" nm "` uses ^:method, ^:instance or"
                              " ^:throws, which the JS target does not speak")
                         {:fn nm})))
       ;; EVERY FUNCTION IS EXPORTED, as every Rust function here is at least
       ;; `pub(crate)`: a sibling module may call it, and an ES module can only
       ;; reach what is exported. `^:pub` (the public API) changes nothing in
       ;; the spelling.
       (kin/define-form! ctx {:scope (if pub? :public :private)} nm
                         (js-call ret (home-unit ctx) nm))
       (kin/emit! ctx (kin/indent-of ctx) "export function " (kl/target-name ctx nm) "("
                  (str/join ", " (map (fn [p] (kin/local-name ctx p)) params)) ") {\n")
       (let [ctx (assoc ctx :local-tags
                        (atom (into {} (for [p params
                                             :let [tv (kin/tag ctx (:tag (meta p)))]
                                             :when tv]
                                         [p tv]))))]
         (kin/scoped ctx {:key :fn :value nm :indent 1}
                     (fn [inner]
                       (kin/scoped inner {:key :js-names
                                          :value (atom (set (map (fn [p] (kin/local-name inner p)) params)))}
                                   (fn [in2] (doseq [f body] (kin/statement! in2 f)))))))
       (kin/emit! ctx (kin/indent-of ctx) "}\n")))})

;; ------------------------------------------------------------- forward declarations

(def ^:private base-declarefn (get (kl/forms {:default-tag nil}) 'declarefn))

(def ^:private js-declarefn
  "`(declarefn f g)` for JavaScript: kin.lang's reservation, then -- for a name
  this namespace defines later (an unqualified symbol) -- the callable a `defn`
  registers, filled in at once: bare name, this unit, no return tag yet (a
  declared call carries none on Rust either, DEVLOG \"Found in kin\").

  WHY: kin defers a call to a declared-but-undefined function into a promise
  settled when the module is joined -- after its header has been formatted --
  so a function named only inside that call's ARGUMENTS, from another unit,
  registered its import too late and the module threw ReferenceError at run
  time (`(item b o (std-inner b p) ...)`; DEVLOG Findings, P7.12, D187).
  JavaScript hoists function declarations, so the call needs nothing the
  definition will add: rendering it at once registers every import in time.
  The later `defn` fills the same placeholder with its own callable."
  {:declare (:declare base-declarefn)
   :generate
   (fn [ctx form]
     ((:generate base-declarefn) ctx form)
     (doseq [nm (rest form) :when (nil? (namespace nm))]
       (kin/define-form! ctx {:scope (if (:pub (meta nm)) :public :private)} nm
                         (js-call nil (home-unit ctx) nm))))})

;; ------------------------------------------------------------- bindings

(defn- declare-local!
  "Refuse a second declaration of one name in one function, at generation time.

  Rust lets a `let` shadow a parameter or an earlier `let`; JavaScript makes
  `const x` after a parameter `x` (or a second `const x` in one block) a
  SyntaxError, and that is found only when the module is loaded. kin's `let`
  opens no block of its own, so the rule here is the simple, slightly
  stricter one: a name is declared once per function (as nome's Go rule)."
  [ctx nm]
  (when-let [names (kin/get ctx :js-names)]
    (let [n (kin/local-name ctx nm)]
      (when (contains? @names n)
        (throw (ex-info (str "snug.js: `" nm "` is declared twice in `" (kin/get ctx :fn)
                             "` -- legal shadowing in Rust, a SyntaxError in JavaScript."
                             " Give the second binding its own name.")
                        {:symbol nm :fn (kin/get ctx :fn)})))
      (swap! names conj n))))

(defn- js-let [ctx form]
  (let [[_ bindings & body] form]
    (doseq [[nm init] (partition 2 bindings)]
      (let [{code :text produced :tag} (kin/render-tagged ctx init)
            declared (kin/tag ctx (:tag (meta nm)))]
        (declare-local! ctx nm)
        (kin/define-tag! ctx {:scope :private} nm (or declared produced))
        (kin/emit! ctx (kin/indent-of ctx) (if (:mut (meta nm)) "let " "const ")
                   (kin/local-name ctx nm) " = " (kl/strip-parens code) ";\n")))
    (doseq [f body] (kin/statement! ctx f))))

(defn- js-local [ctx form]
  (let [nm (second form)]
    (declare-local! ctx nm)
    (kin/define-tag! ctx {:scope :private} nm (kin/tag ctx (:tag (meta nm))))
    (kin/emit! ctx (kin/indent-of ctx) "let " (kin/local-name ctx nm) ";\n")))

(defn- js-return [ctx form]
  (if (= 1 (count form))
    (kin/emit! ctx (kin/indent-of ctx) "return;\n")
    (kin/emit! ctx (kin/indent-of ctx) "return "
               (kl/strip-parens (kin/render ctx (second form))) ";\n")))

(def ^:private compound
  "JS's compound assignments, keyed by the operator's vocabulary symbol. Only
  where `x op= y` means exactly `x = x op y` for the template behind `op`:
  never `quot`, `rem`, the wrapping forms or the shifts (whose templates
  coerce)."
  {'+ "+=" '- "-=" '* "*=" 'bit-and "&=" 'bit-or "|=" 'bit-xor "^="})

(defn- js-set [ctx form]
  (let [[_ place value] form
        p (kin/render ctx place)
        head (when (and (seq? value) (symbol? (first value)))
               (let [h (first value)]
                 (if-let [scope (:scope-syms ctx)] (second (get scope h)) h)))
        cmp (get compound head)]
    (if (and cmp (= 3 (count value)) (= p (kin/render ctx (second value))))
      (kin/emit! ctx (kin/indent-of ctx) p " " cmp " "
                 (kl/strip-parens (kin/render ctx (nth value 2))) ";\n")
      (kin/emit! ctx (kin/indent-of ctx) p " = "
                 (kl/strip-parens (kin/render ctx value)) ";\n"))))

(defn- js-for
  "`(for [^I32 i a b] ...)` -- `for (let i = a; i < b; i++) {`, half-open."
  [ctx form]
  (let [[_ [nm start end] & body] form
        _ (declare-local! ctx nm)
        _ (kin/define-tag! ctx {:scope :private} nm (kin/tag ctx (:tag (meta nm))))
        n (kin/local-name ctx nm)
        a (kl/strip-parens (kin/render ctx start))
        b (kl/strip-parens (kin/render ctx end))]
    (kin/emit! ctx (kin/indent-of ctx) "for (let " n " = " a "; " n " < " b "; " n "++) {\n")
    (kin/scoped ctx {:key :in-loop :value true :indent 1}
                (fn [inner] (doseq [f body] (kin/statement! inner f))))
    (kin/emit! ctx (kin/indent-of ctx) "}\n")))

;; ------------------------------------------------------------- constants

(defn- check-const-name! [nm]
  (when-not (re-matches #"[A-Z][A-Z0-9_]*" (str nm))
    (throw (ex-info (str "snug.js: `(defconst " nm " ...)` -- a constant is named"
                         " SCREAMING_SNAKE")
                    {:symbol nm}))))

(defn- const-ref
  "What a reference to a constant becomes: its name, bare in its own module
  and imported by name from another. ONE function for every target, as
  kin.lang's constants register: `snug.js` only answers for `:js`, and Rust
  keeps `kin.lang`'s own."
  [ns nm]
  (fn [c] ((qualify c (kt/unit-of c ns)) (str nm))))

(def ^:private js-defconst
  {:declare (fn [ctx form]
              (let [nm (second form)]
                (check-const-name! nm)
                (kin/define-name! ctx {:scope (if (:pub (meta nm)) :public :private)}
                                  nm (const-ref (:kin/ns ctx) nm))))
   :generate (fn [ctx form]
               (let [[_ nm v] form]
                 (check-const-name! nm)
                 (kin/define-tag! ctx {:scope :private} nm (kin/tag ctx (:tag (meta nm))))
                 (kin/emit! ctx (kin/indent-of ctx) "export const " (str nm) " = "
                            (if (seq? v) (kin/render ctx v) (str v)) ";\n")
                 (kin/define-name! ctx {:scope (if (:pub (meta nm)) :public :private)}
                                   nm (const-ref (:kin/ns ctx) nm))))})

;; ------------------------------------------------------------- the rest

(defn- js-doc
  "`(doc ...)` -- a JSDoc block, which is what a JS reader's tools pick up."
  [ctx form]
  (let [ind (kin/indent-of ctx)]
    (kin/emit! ctx ind "/**\n")
    (doseq [line (rest form)]
      (kin/emit! ctx ind (if (str/blank? (str line)) " *" (str " * " line)) "\n"))
    (kin/emit! ctx ind " */\n")))

(defn- js-panic [ctx form]
  (when-not (= :statement (kin/position ctx))
    (throw (ex-info "snug.js: panic is a statement, not a value" {:form form})))
  ((kl/call {:js "throw new Error({0})"}) ctx form))

(def ^:private generic-ops
  "`kin.lang`'s untyped operators, for a source that refers them rather than
  `snug.lang`'s: the same spellings, with JS's strict equality and the integer
  coercions `quot` and `rem` need."
  (merge
   (into {} (map (fn [s] [s (kl/op-form s)])
                 ['+ '- '* '< '> '>= '<= 'not 'and 'or 'bit-and 'bit-or 'bit-xor]))
   {'== (kl/call {:js "({0} === {1})"})
    '!= (kl/call {:js "({0} !== {1})"})
    'quot (kl/call {:js "(({0} / {1}) | 0)"})
    'rem (kl/call {:js "(({0} % {1}) | 0)"})}))

;; ------------------------------------------------------------- data tables

(defn table
  "The JS layout of a `defdata` of numbers: `export const NAME =
  Int32Array.of(...)`, emitted as a helper line (kin.lang's `defdata` has no
  JS binding spelling, and a helper is the binding an emitter may supply),
  with kin.lang/flat-array's accessor convention: first parameter a receiver,
  ignored; none more is the COUNT (a literal); one more an INDEX; two a record
  and a field with `:stride`. Values must be i32."
  [ctx {bound :binding :keys [data accessors options]}]
  (let [xs (vec (flatten data))
        stride (:stride options)
        n (count xs)]
    (doseq [x xs]
      (when-not (and (integer? x) (<= -2147483648 x 2147483647))
        (throw (ex-info (str "snug.js/table: `" bound "` holds " (pr-str x)
                             ", which is not an i32")
                        {:binding bound :value x}))))
    {:helpers [(str "export const " bound " = Int32Array.of("
                    (if (<= n 16)
                      (str/join ", " xs)
                      (str "\n" (str/join ",\n" (map (fn [row] (str "  " (str/join ", " row)))
                                                     (partition-all (or stride 16) xs)))
                           "\n"))
                    ");")]
     :accessors
     (into {}
           (for [{:keys [name arity]} accessors]
             [name (case arity
                     1 (str (if stride (quot n stride) n))
                     2 (str "{unit}" bound "[{1}]")
                     3 (str "{unit}" bound "[{1} * " stride " + {2}]"))]))}))

;; ------------------------------------------------------------- the map

(def ^:private base (kl/forms {:default-tag nil}))

(def vocabulary
  "ONE map, in a vector: it names `kin.lang`, not this file's namespace, and
  `load-vocabulary` only accepts a foreign `:namespace` from a vector."
  [{:namespace 'kin.lang
    :targets #{:js}
    :tags {}
    :names {}
    :forms (merge
            generic-ops
            {'defn js-defn
             'let js-let
             'local js-local
             'return js-return
             'set js-set
             'for js-for
             'defconst js-defconst
             'doc js-doc
             'panic js-panic
             'declarefn js-declarefn}
            (select-keys base ['if 'while 'forever 'break 'continue 'case
                               'comment 'do 'defdata '. 'declaretag
                               'declarename]))}])
