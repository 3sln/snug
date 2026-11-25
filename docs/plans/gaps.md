# Plan: pluggable regex engines and the remaining CDDL gaps (D376)

Status: **plan only** (D376, 2026-11-25, over main `b56c4ff`, snug 0.2.0). Nothing here is
implemented. This is a maintainer document. It is not shipped (it is outside
`PACKAGE_FILES.docs` and the crate's `include`), so it may cite D-numbers and internal
names. Owner questions are marked **OWNER DECISION NEEDED**. Every other decision below is
an engineering decision, stated with its reasons, and open to the coordinator's review.

The gaps are the "Refused and planned features" rows of [cddl-support.md](../cddl-support.md):

| Gap | Today | Section |
| --- | --- | --- |
| `.pcre`, lookarounds, backreferences | `unsupported_control` / `regexp` (D013, D243) | §1 |
| composite `.ne` (and a composite `.default`) | `unsupported_control` / `control_value` | §2.1 |
| nonliteral `.plus`, `.cat`, `.det`; float `.plus` | `control_value` | §2.2 |
| `#4.n`, `#5.n` | `major` | §2.3 |
| XSD `\p{IsBlock}` / `\P{IsBlock}` | `regexp` (D243: no pinned block data) | §2.4 |

The rule throughout is D230: conformance to the specs is the default, and any other
behaviour is an option.

---

## 1. Pluggable regex engines

### 1.1 What the owner asked for, and what it means here

Users can plug in their own regex engine **alongside** the built-in bounded one. The built-in
engine stays the default and is unchanged: `.regexp` is XSD 1.0 Appendix F by default, or
RFC 9485 with `regexp: 'iregexp'`. Both compile to Glushkov range automata and are charged
per code point (architecture §4.7, D242, D243). A plugged engine is how `.pcre`,
lookarounds and backreferences become available. snug does not ship PCRE semantics itself.

**`.pcre`'s status.** No RFC defines `.pcre`.

- RFC 9165's Table 1 defines `.plus`, `.cat`, `.det`, `.abnf`, `.abnfb` and `.feature`, and
  nothing else.
- RFC 8610 §3.8.3.2 says there is "no normative reference for PCREs". It names controls as the
  extension point, and points to "a proposal for a `.pcre` control" in [CDDL-Freezer].
- The IANA "CDDL Control Operators" registry, read 2026-11-25 (last updated 2025-03-06),
  lists RFC 8610's, RFC 9090's, RFC 9165's and RFC 9741's operators. It has **no** `.pcre`.
- The proposal now lives in draft-bormann-cbor-cddl-freezer-18 §4.1 (2026-09-02), an
  individual draft with no formal standing. There `.pcre`'s target is a text string, the
  controller is a **PCRE2** pattern, and the match is **anchored on both sides**.

snug follows that draft's meaning: a text target, a PCRE2-dialect pattern, a whole-string
match. Because no standard backs it, `.pcre` stays an opt-in that is never on by default.

### 1.2 Shape: an engine is a special extension control

**Decision.** A plugged engine is bound like the ABNF module (D334). It becomes a registry
entry under a **built-in control name** that only an engine entry may bind. The EXT
machinery then carries it: D140 to D143 and D190 to D194 (the EXT leaf, the verdict word,
`room`, sessions taking the item whole, the wasm `snug_ext` import). This adds a format
2.1 leaf flag (§1.6) and a few compile-option words (§1.7).

- `.pcre` (control code 19, refused today in `lower-ctl`) lowers to `AND(t, EXT)` for each
  text leaf `t` of the target, with an EXT leaf flagged `ENGINE` (§1.6). Without an engine,
  `.pcre` stays `unsupported_control`. As `ERR_NEED_ABNF` does for ABNF, the message names
  how to register an engine.
- The target must be a text type: `tstr`, a text literal or literal set, or a text leaf
  with `.size` or `.regexp`. Any other target is `control_target`. The controller must be one
  text string literal, after `.cat`/`.det` folding. Anything else is `control_value`.
- `.regexp` keeps the built-in engine. Routing `.regexp` to a plugged engine is a separate
  opt-in (OWNER DECISION 3, §1.12).
- An engine entry counts as an extension control for the `bus` profile. It is refused
  (`profile`) unless `controlsInBus` admits it (D141). No new flag.

**Why this shape.** Everything that makes host code safe to call from the VM already
exists and is gated:

- the call happens once per item, lazily, after the profile walk (D140);
- the item is whole on every route, bounded by the entry's maximum (D143);
- the port takes the budget left and answers a verdict word (D190);
- the wasm import has a re-entrancy guard (D170, D371);
- Programs bind at load, and a missing name is `missing_control` (D141).

A separate engine port would duplicate all of that.

**Alternatives considered.**

- *An engine as a plain user control* (`.myre`): this works today with `cost`. It gives no
  `.pcre` name, no `pattern` reason, no engine binding in the Program, and a cost declared
  before the call instead of metered.
- *A new VM leaf kind with its own port*: this duplicates D140 to D143 in kin and in every
  host. It also needs a fourth host-call path in the wasm SDK.
- *Compiling PCRE into the built-in automata*: backreferences are not regular, and
  lookarounds blow up positions. This is the "unbounded engine" D013 refused.
- *Using the host's `RegExp` directly*: it cannot be metered, it differs from host to host,
  and it is the ReDoS path D013 and D242 refused.

### 1.3 Gas, end to end

**Units.** An engine reports gas in **snug budget units**, the same units as the call's
`budget`. The default budget of 2.25 M units is calibrated at about 20 ns of CPU a unit
(architecture §7, D253). Converting the engine's own counter is the adapter's job. For
example, PCRE2's `match_limit` counts internal match calls, and an adapter divides that
count by a measured rate. The adapter's documentation must state its rate. snug's docs will
give the 20 ns calibration and a bench recipe.

**What snug charges.** The charges run in this order, for one engine leaf on one item.
They are kin's `ext-eval` with the `ENGINE` flag.

1. 1 unit when the leaf is decided (unchanged).
2. If the item's content is longer than the entry's `maxBytes`, the leaf fails with
   `control_size`, without asking (unchanged, D140).
3. Otherwise, `EXT_CALL` (16) plus a **handoff charge of ⌈n/8⌉**, where n is the content
   length. This prices the copy across the port at the same rate as a byte comparison
   (D253), so a trivial engine cannot make long items free.
4. `room`, the units left after steps 1 to 3, becomes the engine's **quota**:
   `quota = min(room, 2³¹ − 3)`.
5. The engine answers. snug charges its units u, or stops.

**Decision: quota = the budget that remains. There is no per-match quota.** This is what the
built-in regexp does (charged per code point against the call's budget) and what `.abnf`
does ("metered against the budget left"). A per-match cap below `room` would need its own
reason: hitting it is not budget exhaustion, and reporting `budget` while budget remains
would be false. It would also need its own source-key element. A caller who wants a tighter
bound lowers `budget`.

**Answers and how snug maps them.** These are kin's verdict word (D190), produced by the
host binding from the engine's typed answer:

| Engine answer | Verdict word | snug's result |
| --- | --- | --- |
| matched after u units, u ≤ quota | u | leaf MATCHED; u charged |
| no match after u units, u ≤ quota | −2 − u | reason **`pattern`** (§1.6), at the item's offset and path; u charged |
| exhausted (would need more than its quota) | −1 | **`budget`** at the item's offset, path as for any budget stop; nothing more charged |
| matched / no match with u > quota | treated as −1 | **`budget`** (an overspend is the engine's, but the call's budget is gone either way) |
| anything else (throws, a malformed answer) | fault | the call **throws** (§1.4), never a verdict |

**Identical accounting across routes.** `room` at an EXT call is the same on the buffer,
span, session, push and stream routes, and under every window split and quantum. The gates
already prove this (D143, architecture §17.4). Given a deterministic engine, the quota is
the same, so u is the same, and the budget used (out[3], Rust `Failure::budget_used`) is
identical across routes. Under the `valid` preset a non-deterministic input runs a second
walk over its canonical copy (D262). That walk asks the engine again with its own `room`.
This is deterministic too, and the docs' "about twice the budget's work" already covers it.

### 1.4 When an engine misbehaves

snug **never accepts on a fault**, and never turns an engine fault into a data verdict.

- **Overspends, and reports it** (u > quota): `budget`, as in the table above. This is
  deterministic. Kin's `ext-eval` already does this (`(> u room)` returns budget).
- **Claims exhaustion early** (−1 while it could have finished): `budget`. This is the
  engine's own deterministic answer, so routes still agree.
- **Under-reports** (burns more CPU than it reports): snug cannot detect this. It is inside
  the adapter's trust boundary, as a host predicate's `cost` is today (D193). §1.10 says what
  this costs.
- **Throws** (JS) or **answers garbage**: a non-object, `matched` not a boolean, `units` not
  a non-negative safe integer, or both `exhausted` and `matched`. The binding records the
  failure and answers kin with −2, so the walk ends without matching. After the VM call it
  throws. This is today's predicate path (`bound.failure`, `rethrow`). The error is an
  `Error` with **`code: 'regex_engine'`**, `engine` (the id) and `cause`. The message is
  "snug: regex engine `<id>` threw" or "… answered `<what>`", and it never contains the
  subject. A session or push validator that hits a fault is finished: every later call
  repeats the error. A `readSequence` iterator throws and stops, and does not skip the
  message.
- **Panics** (Rust): the panic propagates, as a predicate's does today. A `Sequence` is
  poisoned (`Usage`, the existing D371 mechanism). The Rust trait's answer is a typed enum,
  so a malformed answer can only be u > quota, which is `budget`.
- **Hangs**: synchronous JS, Rust and wasm-to-JS calls cannot be pre-empted, and snug does
  not pretend otherwise. What snug guarantees:
  1. **A verdict-level hard cap.** No answer can charge more than the call's budget, and the
     sum of all engine calls in one validation is bounded by it.
  2. **No acceptance on a fault.**
  3. **Calls are still bounded without an engine-level cap.** An engine call is the only
     unbounded host code on the call path, and only when its adapter fails to stop at its
     quota.

  A deployment that needs wall-clock protection against a broken adapter runs validation in
  a worker or a child process with a deadline. That is outside snug, and the guide says so.
  A wall-clock check inside snug is refused: it is non-deterministic, so hosts and routes
  would disagree (D193's reasoning).

**Why throw instead of a fail-closed reason such as `pattern` or `budget`.** A fault says
nothing about the data. As a validation reason it would look like invalid input. Under
`onInvalid: 'skip'` it would also make a sequence silently drop messages. Throwing is
fail-closed, because nothing is accepted, and it is visible. **Alternative considered:** a
new validation reason `engine`. It was refused because it would put host-code faults into
the data-reason enum, which recovery tables and logs treat as properties of input.

### 1.5 Sessions, quanta and yields

- **A match never spans a yield.** An engine call is atomic inside one session step, as
  every EXT call is. The session asks for the item whole up to `maxBytes` before routing it
  (D143). So the engine always gets a contiguous subject and is called once per (leaf,
  item), whatever the windows are.
- **Quanta.** A quantum counts charged units (architecture §17.4). An engine call's units
  count toward the step's quantum after the call returns. So a step can overrun its quantum
  by at most one engine call: at most `room`, and in practice the engine's work on that one
  item. The quota **never** depends on the quantum, the window or the route. If it did,
  verdicts would depend on scheduling, which §17.4 forbids. **Not done in v1:** a yield
  point just before an engine call. It would bound the overrun better, but `finish-comb`
  would have to become resumable mid-item, and yields are unobservable anyway. If
  responsiveness needs it, it can be a later, separate change.
- **Synchronous engines only in v1.** The buffer route (`validate`) is synchronous. The
  resumable session could suspend only at item and window boundaries, not inside
  `finish-comb`. D140 refused the two-round "ask the host, restart" design for this reason.
  **OWNER DECISION 1** (§1.12) asks whether async engines are wanted later.

### 1.6 Program format 2.1: the `ENGINE` flag on EXT

**Decision.** Format **2.1**, an additive minor under D084 and D279's rule. EXT leaf flag
**bit 0 `ENGINE`**. Under 2.0, EXT flags must be 0. An `ENGINE` EXT leaf means three things:

- the reason on refusal is **`pattern`** (R_PATTERN 38), not `control` (42), so `.pcre` and
  `.regexp` refusals read the same;
- the subject is the item's **content** (the head is stripped in kin with `take-len`): the
  UTF-8 text, never the encoding;
- the handoff charge ⌈n/8⌉ applies (§1.3).

The compiler writes 2.1 only when a Program has an `ENGINE` leaf or a composite `.ne`
(§2.1). Every other Program stays byte-identical 2.0. A 2.0 loader refuses a 2.1 Program
with `format_version`, which is the right failure: it would not know the flag.

**Engine binding inside the Program.** The EXT argument of an engine leaf is the CBOR
`[engine-id: tstr, dialect: uint, pattern: tstr]` (dialect 0 = `pcre`, 1 = `regexp`). The
verifier does not read arguments (they are pool spans). At bind (`bindControls` /
`prepare_all`), the host checks that every engine leaf's id equals the registered engine's
id, bytewise. Otherwise it raises **`ProgramError('regex_engine')`** / Rust
`Error::RegexEngine`, naming both ids. No engine registered is the existing
`missing_control` (name `pcre`). **Alternatives:** a header word pair pointing at the id
(needs a header change for one string), or the id only in the source key (the key cannot be
checked at load: it hashes the schema text, which a loader does not have).

### 1.7 The source key

**Decision.** By analogy with D141, the registry element of the preimage (element 8)
carries engine entries as `[name, maxBytes, engine-id]`, where ordinary controls have
`[name, maxBytes]`. Registry flags gain **bit 2: `.regexp` is routed to the engine**. That
bit exists only if OWNER DECISION 3 says yes. The compile-option registry words gain, per
entry, a kind word (0 predicate, 1 engine) and, for an engine, its id bytes. Kin refuses a
malformed one with `control_registry`, as today. So:

- a cached Program is never reused under another engine id, another `maxBytes` or another
  routing;
- the preimage changes only for compiles that register an engine, so every existing key
  stays valid;
- the Program itself also carries the id (§1.6), so a stored Program cannot be loaded under
  another engine either.

The **id is a promise made by the adapter**: equal ids mean equal compile refusals, equal
verdicts and equal units for every (dialect, pattern, subject, quota). It should name the
engine, its version, its options (UTF mode, JIT off) and its gas schedule version, for
example `pcre2-10.44+utf+ucp/gas-1`. Rules: 1 to 128 bytes of printable ASCII (no
whitespace), so it is safe in messages.

### 1.8 Compile-time pattern validation

**Decision.** Patterns are compiled by the engine **when the schema compiles**. Errors are
compile errors, never match-time surprises.

- After kin's compile, the host asks `engine.compile(pattern, dialect, quota)` once for each
  distinct (dialect, pattern). The same point already asks `Control.argument` (D142).
- A refusal is **SchemaError `regexp`**, the built-in engine's code for a bad pattern, with
  the engine's detail appended. The detail is capped at 200 characters, one line, and is
  caller-controlled metadata, as ABNF details are. The refusal carries the line and column of
  the first use of that pattern. Today's argument refusals carry 0:0, because the Program
  has no positions. Kin therefore exports a compile-output side table (first source offset
  per EXT leaf, not part of the Program) that both hosts read.
- **Compile gas.** The quota is the compile budget kin left unspent
  (`compileBudget − budgetUsed`). The units every engine compile reports are summed against
  it. Past it, the result is `limit_compile_budget`. This is deterministic given the
  engine, and it bounds a hostile schema's pattern-compile CPU with the same option that
  bounds the rest of its compile. An engine that throws during compile makes `compile`
  reject, with `code: 'regex_engine'` and the cause.
- At **load** (`fromSerialized`, `from_serialized_with`), each pattern is compiled again
  when the Program binds. As with D192's bind-time preparation, this is not charged. A
  refusal there (same id, but the engine now refuses) is `ProgramError('regex_engine')`.
  The compiled patterns are kept per (control id, argument offset), like `preps`, and are
  released with the Schema (`dispose`). The engine's `dispose()` hook, if it has one, frees
  engine-side memory, for example a wasm PCRE2 heap.

### 1.9 Interfaces

**JS** (`@3sln/snug/regex`, a new optional entry; the wasm SDK re-exports the same objects
as `@3sln/snug-wasm/regex`):

```ts
export type RegexDialect = 'pcre' | 'regexp';

/** One answer to one match. units: snug budget units spent (~20 ns each by default). */
export type MatchAnswer =
  | { readonly matched: boolean; readonly units: number }   // units <= quota
  | { readonly exhausted: true };                            // would need more than quota

export interface CompiledPattern {
  /** subject: the text's UTF-8 content, already validated by the profile walk; a fresh
   *  copy. Must be anchored at both ends, pure, synchronous, and stop by `quota`. */
  match(subject: Uint8Array, quota: number): MatchAnswer;
  dispose?(): void;
}

export interface RegexEngine {
  /** Bound into the source key and into every Program that uses the engine (§1.7). */
  readonly id: string;
  /** The controls this engine serves; 'regexp' only with { routeRegexp: true }. */
  readonly dialects: readonly RegexDialect[];
  /** Largest subject in bytes it is asked about (default 65,536, at most 2^31-1). */
  readonly maxBytes?: number;
  compile(pattern: string, dialect: RegexDialect, quota: number):
    | { readonly ok: true; readonly pattern: CompiledPattern; readonly units: number }
    | { readonly ok: false; readonly detail: string; readonly units: number };
}

/** Registry entries binding `pcre` (and `regexp` when routed) to the engine:
 *  compile(text, { controls: { ...controls, ...regexEngine(engine) } });
 *  fromSerialized(bytes, { controls: { ...regexEngine(engine) } }). */
export function regexEngine(engine: RegexEngine, options?: { routeRegexp?: boolean }): Controls;
```

The subject is passed as bytes, not a string. Engines worth plugging (PCRE2, RE2, Onig)
are byte-oriented and often run in wasm, and snug should not decode text that the adapter
may never need as a string. An adapter over a string engine decodes it itself, and that
CPU is its cost.

**Rust** (`snug::regex`):

```rust
pub enum Dialect { Pcre, Regexp }

pub enum MatchAnswer { Matched { units: u32 }, NoMatch { units: u32 }, Exhausted }

pub struct PatternError { pub detail: String, pub units: u32 }

pub trait RegexEngine: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn dialects(&self) -> &[Dialect];
    fn max_bytes(&self) -> u32 { 65_536 }
    fn compile(&self, dialect: Dialect, pattern: &str, quota: u32)
        -> Result<(Box<dyn CompiledPattern>, u32), PatternError>;
}

pub trait CompiledPattern: Send + Sync {
    /// `subject` is the validated text; anchored, pure, stops by `quota`.
    fn matches(&self, subject: &str, quota: u32) -> MatchAnswer;
}

impl Controls {
    pub fn with_regex_engine(self, engine: Arc<dyn RegexEngine>) -> Self;
    pub fn with_regex_engine_routing(self, engine: Arc<dyn RegexEngine>) -> Self; // OWNER DECISION 3
}
```

The binding turns the trait into the `Control` trait's hidden metered `prepare`/`run` pair
(§1.2), so `port` and `prepare_all` need only the id check. `CompileOptions` does not
change: the engine rides in `controls`.

**wasm SDK.** No new import and no ABI change:

- The VM in wasm reaches the engine leaf through the one import, `env.snug_ext(id, ap, al,
  ip, il, room, ao)` (D170). With `ENGINE`, kin passes the content span, so `[ip, ip+il)` is
  the text.
- `room` crosses as an i32 and is the quota. The JS side (`snugExt` → `bound.call`) runs
  the engine, checks its answer, and returns the verdict word as an i32.
- **Gas accounting across the boundary:**
  - all charging is kin's inside wasm (1, `EXT_CALL`, the handoff, then u);
  - the JS side only validates the answer and enforces u ≤ quota before returning;
  - a malformed answer never reaches wasm: JS records the fault, returns −2, and
    `withExt`'s caller rethrows.
- The re-entrancy `GUARD` stops an engine from calling back into the snug instance. An
  engine with its own wasm instance (PCRE2 in wasm) is unaffected.
- The subject is `u8.slice(ip, ip+il)`, a copy, because linear memory may grow under the
  engine's own allocations.

Unchanged: compiled patterns live on the JS side, keyed like `preps`; Rust-native engines
for the wasm SDK are out of scope; the SDK's instance-loss rules hold (a trap inside the
engine's own instance is the engine's exception, so it is a fault, §1.4).

### 1.10 Security posture

Gas bounds ReDoS. snug does not trust pattern safety, and the built-in engine's guarantee
does not change. With a plugged engine, the guarantee holds **only as far as the adapter
meters inside its matching loop**. PCRE2's `match_limit` and `depth_limit`, fancy-regex's
backtrack limit and a linear engine's declared m·n bound all qualify. An adapter that does
not meter is the integrator's bug, like a host predicate with a false `cost` (D193).

- **Malicious data sender** (trusted schema, trusted adapter, hostile bytes). The sender
  chooses the subject, not the pattern. A vulnerable pattern with an exponential subject
  makes the engine hit its quota, and the call answers `budget` within roughly
  budget × 20 ns of engine CPU. Buffering is bounded by `maxBytes` (D143). Gas turns ReDoS
  from a hang into a bounded refusal. This is the case the design fully covers.
- **Malicious schema author** (untrusted schema, for example a multi-tenant registry under
  `bus`). The author chooses the patterns. Gas still bounds every match, because the
  validator, not the schema, sets `budget`, and it bounds pattern compiles through
  `compileBudget` (§1.8). The worst the author gets from gas alone is a schema that always
  answers `budget`, and they control that schema anyway. But the author also reaches the
  engine's **compiler and memory**. A pattern can make a native engine allocate, and gas
  does not meter memory. It can also exercise engine bugs (memory safety, JIT). So:
  1. engines are refused under `bus` unless `controlsInBus` (§1.2);
  2. the docs advise running untrusted-schema engines with the JIT off and inside wasm,
     which gives memory isolation, with the engine's own compiled-size cap set;
  3. snug's compile-time `schemaBytes` limit bounds pattern length.
- **Malicious adapter**: out of scope. It is host code, at the same trust as a predicate.

### 1.11 Identity and parity: what is guaranteed

- **The built-in engine keeps full identity.** `.regexp` without routing is unchanged:
  JS == Rust == wasm, buffer == session, the same verdict, code, offset, path, items and
  budget used. Every existing gate stays as it is.
- **A plugged engine guarantees the determinism of snug's own accounting around it.** Given
  the same engine answers, snug gives the same verdict, code, offset, path, items and
  budget used on every host and route. Because the charges and the quota are kin's, this
  holds by construction, and the gates check it with scripted engines (below).
- **snug does not guarantee cross-host parity for a user's engine.** A JS adapter and a
  Rust adapter with the same id agree only if their authors keep the id promise (§1.7).
  The docs say this plainly.
- **Gates** (engine-level tests, plus seeded chaos tests, per the owner's testing style):
  - a scripted mock engine (answers from a seeded table keyed by pattern and subject hash)
    run on buffer == session == push == stream, every split and quantum, JS == Rust ==
    wasm;
  - a chaos engine (seeded throws, malformed answers, u > quota, −1 with quota left)
    asserting that a fault never gives `ok: true`, that faults throw `regex_engine`, and
    that over-quota gives `budget` at the same offset and with the same budget used on
    every route;
  - a reference engine that wraps a small metered backtracker in the test tree (not
    shipped) for end-to-end `.pcre` tests: anchoring, UTF-8 subjects, quota exhaustion on a
    classic `(a+)+$` subject.

### 1.12 Owner decisions

**OWNER DECISION NEEDED 1: may an engine be asynchronous?**
- (a) Synchronous only. **Recommended for v1.** It works on every route, including
  `validate`, needs no new session state, and keeps D140's design.
- (b) Also async, on async drivers only. The session would gain a suspend state before an
  engine call (`{ state: 'engine', … }`) and resume with the verdict word. `validate` and
  the other synchronous APIs would refuse an async engine. This makes `finish-comb`
  resumable mid-item: large work, and every session gate grows a new suspension.

**OWNER DECISION NEEDED 2: ship a recommended adapter?**
- (a) None. Docs, the interface, and the test-tree reference engine.
- (b) A separately versioned package, for example `@3sln/snug-pcre` and a `snug-pcre`
  crate: PCRE2 built to wasm (JS) and pcre2-sys (Rust). It would use PCRE2's match limit as
  the gas source, with a measured units rate. It would be an adapter snug maintains, with
  its own release and licence notices (BSD).
- (c) (b) with **enforced** gas: snug instruments the engine's wasm with a fuel counter, so
  metering no longer depends on the adapter. The Rust side would need a wasm runtime with
  fuel. This is the strongest ReDoS story and much the largest work.
- **Recommended:** (a) now and (b) once the interface has settled, with (c) noted as
  future work.

**OWNER DECISION NEEDED 3: may `.regexp` be routed to a plugged engine?** This is for users
with schemas written for tools whose `.regexp` is a host regex (the Ruby cddl tool's Ruby
regexps). It changes `.regexp`'s meaning away from RFC 8610's XSD reference. Under D230 it
can only be an explicit option: `regexEngine(e, { routeRegexp: true })`, registry flag
bit 2 in the source key, dialect 1 in the argument.
- **Recommended:** yes, as an option, if there is demand. Otherwise leave it out, since it
  costs nothing to add later.

---

## 2. The other gaps

The size figures are estimates from reading the code, with no builds run (D376's
constraint). They are minified-JS bytes unless stated. Two caps are thin: `snug/schema`
brotli and `snug/compile` gzip after D374.

### 2.1 Composite `.ne` (and a composite `.default`)

**Today.** `ctl-eq` lowers a composite **`.eq`** controller (an array, a map or a tag) to
`AND(t, controller)`. A composite **`.ne`** is `unsupported_control`, because the NOT leaf's
second operand must be a `LIT` (program.md §4 row 17, checked by the verifier). A `.default`
whose implied `.ne` is composite is refused the same way (D359).

**Spec.** RFC 8610 §3.8.6: `.ne` and `.eq` compare with "a value given as a right-hand-side
type (containing just that single value)". For non-numbers, arrays are equal element by
element, maps pair by pair, and tags by number and content. Nested numbers are equal "if
their numeric value is equal and they are both integers or both floating-point values".

**Options.**
1. **NOT with any operand leaf.** Lower `t .ne C` to `NOT(t, C)`, with C the controller's
   ARRAY, MAP or TAG leaf. Under the default, require C to be a **ground value**: every
   member a literal with occurrence exactly 1, map keys literal, no choices, recursively.
   Then C's match set is exactly the values equal to that one value under snug's literal
   rules. Those rules already agree with §3.8.6: a float literal matches by numeric value
   at any width, 0.0 matches both zeros, an integer never matches a float, text and bytes
   compare bytewise.
2. Same, but also accept a non-ground controller, read as "not any of these". §3.8.6
   defines no meaning for it.
3. A new EQ leaf that compares canonical encodings. This needs a new leaf kind and the
   canonical machinery at runtime.

**Recommendation: 1.**
- A non-ground controller stays `control_value`. The message says it must be a single
  value.
- The composite `.eq` gets the same ground check. Today it silently accepts `.eq [uint]`
  as a constraint, so this is a fix under D230, recorded as Breaking in the CHANGELOG.
- `.default` with a ground composite default then works under the default
  `defaultControl: 'ne'`.

**Complexity.** Medium. Parts:
- the ground check over the controller typeset (compiler);
- `mk-not` with a container operand;
- the emitter: put the operand's leaf in the query closure, as AND operands already are;
- `leaves-overlap` and `lit-member` stay conservative for a NOT with a container operand;
- the verifier allows any leaf kind but EXT as NOT's operand under format 2.1 (§1.6);
- the witness: a matched operand gives `value`, as now.

The VM's `finish-comb` needs no change: it already decides NOT from the operand's
epoch-stamped MATCHED bit, whatever the operand's kind.

**Size and perf.** Compiler +0.5 to 1 KB. Verifier +~50 B in every runtime entry. VM 0.
At run time a NOT walks its operand container alongside the target, as `.eq`'s AND already
does, so the cost is proportional to the controller's size. Programs without composite
`.ne` are unchanged (2.0).

**Tests.** Regression suites for arrays, maps and tags, nested floats (−0.0, 1.5 at three
widths), an integer versus a float inside an array, a bignum inside an array (D363: a
literal never matches a bignum), a non-ground refusal, `.default` composite under both
`defaultControl` values, and the PEG oracle extended to `.ne`.

### 2.2 Nonliteral `.plus`, `.cat`, `.det`, and float `.plus`

**Today.** `ctl-plus` takes two integer literals (exact, any size). `ctl-cat` and `ctl-det`
take two single string literals (`single-lit`). Anything else is `control_value`, and a
float operand of `.plus` is too (D372 F11, documented only).

**Spec.** RFC 9165 §2: "targets and controllers are types. The resulting type is therefore
formally a function of the elements of the cross-product of the two types. Not all tools
may be able to work with non-unique targets or controllers." §2.1: if one operand is a
float and the other an integer, "the sum is converted into the type of the target"; float
to integer "selects its floor". §2.2: the result has the target's type, and text must be
valid UTF-8.

**Options and recommendation.**
- **Finite literal sets: support.** A choice of literals on either side (`(1 / 2) .plus 10`,
  `("a" / "b") .cat ("x" / "y")`) becomes the cross-product, a LITSET or an INT interval
  list. It is capped at **256 results**, charged to the compile budget; past the cap it is
  `control_value`. With `.cat`/`.det` on a text target, a product that is not valid UTF-8
  refuses the whole control (`control_value`), as a single literal does.
- **Integer intervals in `.plus`: support exactly.** `[a,b] + [c,d] = [a+c, b+d]`. An INT
  leaf's interval list plus a literal shifts every interval. Two interval lists give their
  Minkowski sum, merged, with the result capped like the cross-product. The bignum flags
  follow D363: a range keeps `BIGOK`.
- **Unbounded strings (`tstr .cat "x"`): refuse** (`control_value`), as the RFC allows. The
  alternative was to lower text forms to a built-in automaton (`tstr .cat "x"` as "any text
  ending in x"). That is possible within the position limits, but no use case is known, and
  `bstr` has no automaton. It is deferred.
- **Float `.plus` on single literals: support, exactly, in kin.** Kin has no f64
  arithmetic. Decimal float literals are converted by the host (`Number()` /
  `str::parse`, D372 F11). But both operands are dyadic rationals, so the exact sum is
  computable with the compiler's magnitude arithmetic (`mag-add`, `mag-sub`). Rounding can
  reuse the lexer's exact hex-float rounding (round half to even) and `int-fkey`'s
  integer-to-binary64 rounding. The cases:
  - float + float, or float target + integer controller: round the exact sum to the
    nearest binary64, ties to even. The RFC's "converted into the type of the target" names
    no rounding, so this is IEEE 754's default and also what JS and Rust `+` give for
    float + float.
  - integer target + float controller: the **floor** of the exact sum, as the RFC says,
    giving an integer of any size.
  - A non-finite result, or a non-finite operand (`#7.25` and the like cannot be literal
    operands), is `control_value`. Following IEEE 754, `x + (−x)` is +0.0 and
    `−0.0 + −0.0` is −0.0.
  - **Alternative refused:** asking the host to add, as `ERR_NEED_FLOATS` asks for decimal
    conversion. It needs a compile restart round, and mixed integer + float operands beyond
    2⁵³ are not exact in f64.
- **Float ranges in `.plus`: refuse.** The rounded image of a float interval is not
  obviously an interval of every binary64 in between, so it may not be exact.

**Complexity.** Small to medium for literal sets and intervals (`ctl-plus`, `ctl-cat` and
`ctl-det` iterate the leaves; an interval helper). Medium for float `.plus`: unpack two
binary64 bit patterns into (magnitude, exponent), align, add, then round through the shared
routine. Most of it already exists in `lex.kin` and `ctl.kin`.

**Size and perf.** Compiler +1 to 2 KB for sets and intervals and +1 to 1.5 KB for float
`.plus`, all in `snug/compile` (the gzip margin is thin, so attribute it per D303). Runtime
0, since everything folds at compile time.

**Tests.** Cross-product caps; the UTF-8 refusal in a product; intervals with bignum ends;
float `.plus` halfway cases (1 + 2⁻⁵³ … as D372's decimal vectors), mixed operands at 2⁵³ ± 1,
floor of negatives, signed zeros, overflow refused, checked against Python's
`fractions.Fraction` offline (to be generated when implemented); JS == Rust Programs byte
for byte (compile2-test).

### 2.3 `#4.n` and `#5.n`

**Today.** `#0.n` to `#3.n` read n as the head's additional information **by value**:
- below 24, the argument itself;
- 24 to 27, an argument of 1, 2, 4 or 8 bytes;
- 31, an indefinite length (which, by value, means any length);
- 28 to 30, nothing.

`#4.n` and `#5.n` are `major` ("counting entries by head is not lowered").

**Spec.** RFC 8610 §2.2.3 and Appendix B: `"#" DIGIT ["." uint]` is "a data item of a major
type …, optionally constrained to the additional information given by the uint". RFC 9682
§3.2 note 2 confirms that the number after the dot is the additional information for every
major type except 6 and 7.

**Options.**
1. **Rewrite to groups at compile time, by value (consistent with `#0` to `#3`):**
   - `#4.n` becomes `[lo*hi any]`;
   - `#5.n` becomes `{ lo*hi any => any }`;
   - (lo, hi) is (n, n) below 24, then (0, 255), (0, 65 535), (0, 2³² − 1) and
     (0, 2⁶⁴ − 1) for 24 to 27, and (0, ∞) for 31;
   - 28 to 30 match nothing (the empty typeset, with W9's style of warning).
   - Counts above the entries ceiling are effectively unbounded.
2. **A new leaf kind** that checks the head count directly. It is cheaper at run time,
   especially for maps, but changes the Program format and the VM.
3. **By encoding**: AI 24 means 24 to 255 entries, as a strict reading of "serialized with
   that additional information" gives. This contradicts `#0` to `#3`'s by-value rule.

**Recommendation: 1.** It needs no format or VM change and keeps one by-value rule for every
major type. Under the `valid` preset an indefinite array reaches the schema through its
canonical copy (D262) with a definite count, so `#4.31` = any array is the consistent
reading.

**Complexity.** Small. The `N_MAJOR` lowering builds a REP group over one `any` entry: arrays
reuse `[n*m]`, maps a REP member over `any => any`.

**Size and perf.** Compiler +300 to 600 B. Runtime 0. A `#5.n` map is a T map: about 27 to
34 units a pair in order, about 6·n·log₂n unsorted (D323), within the default budget for
any map the entries limit admits. Fine for a rarely used form. If it ever matters, option 2
is a later optimisation.

**Tests.** Every n in 0 to 31 for majors 4 and 5 (values, counts at the edges 23, 24, 255,
256), indefinite inputs under `valid`, and the PEG oracle taught the same rewrite.

### 2.4 `\p{IsBlock}` / `\P{IsBlock}` with pinned block data

**Today.** D243: refused with `regexp`, because the pinned Node v24.6.0 / ICU 77.1 generator
cannot query the Block property and no authoritative block input is pinned. Category tables
(`@3sln/snug/unicode`, Unicode 16.0) do not contain blocks.

**Spec.** XSD 1.0 Part 2 Appendix F.1.1: a block escape is `Is` followed by a block name
from the Unicode database's Blocks.txt with spaces removed. The 1.0 recommendation gives a
table of names from Unicode 3.1. The implementer must confirm the exact name rule (hyphens
kept, as in `IsLatin-1Supplement`) and that table against the XSD 1.0 Second Edition text
before coding. snug follows XSD 1.0, not 1.1 (D242), so an **unknown block name is an
error**, not 1.1's "matches anything". RFC 8610 §3.8.3 says a specification using Unicode
classes "SHOULD identify which Unicode versions are addressed". The module therefore states
its version, as the category module does. I-Regexp (RFC 9485) has no block escapes, so they
stay refused under `regexp: 'iregexp'`.

**Options.**
1. **Pin Blocks.txt itself.** Check in Unicode 16.0.0's `Blocks.txt` (UCD) under the
   generator's input directory, with its SHA-256 and the Unicode-3.0 licence in
   THIRD_PARTY_NOTICES. It is offline and authoritative, the same version as the
   categories, and needs no ICU Block property.
2. Derive blocks from ICU or a host engine. This is impossible on the pinned Node (D243),
   and other runtimes would make the data depend on the machine.
3. Infer blocks from scripts or category runs. Refused by D243 as incorrect.

**Recommendation: 1, as a separate optional table module.**
- **JS:** `@3sln/snug/unicode-blocks` exports `blocks: Int32Array` (sorted
  `[lo, hi, name-offset, name-length]` records plus the UTF-8 names packed into words),
  `unicodeVersion` and the input's SHA-256. The compile option is `unicodeBlocks`.
- **Rust:** `unicode_tables::BLOCKS`, behind an off-by-default cargo feature if its source
  size matters, with `CompileOptions::unicode_blocks`.

Further details:
- **Aliases.** The XSD 1.0 names that Unicode later renamed (for example `IsGreek` for
  "Greek and Coptic") are added as a short pinned alias list in the generator, taken from
  XSD 1.0's table. That makes schemas written to XSD 1.0's list work.
- **Lowering.** A block resolves to one range, one regexp position, as categories do
  (charged lookup). There is no runtime or Program change.
- **Source key.** A new preimage element carries the block words, for opted-in compiles
  only (as D110 did for categories).
- **Without the module:** the error names `@3sln/snug/unicode-blocks`.
- **Why separate from `@3sln/snug/unicode`:** the category module (9,287 B gzip) does not
  grow for users who never write blocks. **Alternative:** one module with both tables
  (fewer entries; every category user pays about 3 KB gzip more).

**Complexity.** Small to medium. Most of the work is the generator (parse Blocks.txt,
normalise names, aliases), a lookup in `regexp.kin` (binary search over names), and the
host options and types.

**Size and perf.** The new module is about 8 to 10 KB min and about 3 to 4 KB gzip (about
340 blocks: 2 range words each plus about 6 KB of names). Compiler +~400 B. Runtime 0.

**Tests.** Every block name resolves to its Blocks.txt range. `\P{Is…}` is the complement
on scalars (surrogate ranges excluded, as `Cs`). The source key changes with the table.
Unknown names and I-Regexp are refused. An optional differential against Ruby's
`\p{In_…}` block properties (Onigmo) when Ruby is present.

---

## 3. Sequencing

Each package is a separate D-entry and branch, with targeted tests per the 2026-11-18 policy
and the size attribution per D303. The order runs from small and independent to large.

| # | Package | Depends on | Size of work |
| --- | --- | --- | --- |
| WP1 | `#4.n` / `#5.n` by value (§2.3) | none | S |
| WP2 | `\p{IsBlock}`: pinned Blocks.txt, generator, `@3sln/snug/unicode-blocks`, Rust table (§2.4) | none (needs the XSD 1.0 name-rule check first) | S–M |
| WP3 | Literal-set and interval `.plus`/`.cat`/`.det`; float `.plus` in kin (§2.2) | none | M |
| WP4 | **Format 2.1**: verifier, program-2.md and program.md for both NOT-any-operand and the EXT `ENGINE` flag; loader version rule; compile2-test identity of 2.0 Programs | none | S |
| WP5 | Composite `.ne` and ground `.eq` (§2.1) | WP4 | M |
| WP6 | Engine core: `.pcre` lowering, registry kind and id words, source key, `ENGINE` in `ext-eval` (content span, handoff, `pattern`), bind-time id check, compile-time pattern validation and compile gas, the position side table, JS `@3sln/snug/regex` and Rust `snug::regex`; scripted, chaos and reference engines (§1) | WP4 | L |
| WP7 | wasm SDK: `@3sln/snug-wasm/regex`, gates across JS == Rust == wasm with scripted engines | WP6 | S–M |
| WP8 | Owner decisions 1 to 3: async engines, a recommended adapter, `.regexp` routing | WP6, owner | depends on the decisions |

WP1, WP2 and WP3 can run in parallel. They touch disjoint parts of the compiler
(`lower.kin`'s `N_MAJOR`, `regexp.kin`, `ctl.kin`), so they need only ordinary merge care.
WP4 is split out so that both format-2.1 consumers land against one reviewed verifier
change, not two minors. WP6 is the only package that touches the VM. It needs a size
attribution in `snug/schema`, about +150 to 250 B in `ext-eval`, plus the verifier from WP4.
The optional `@3sln/snug/regex` entry carries the rest (about 1.5 to 2.5 KB).
