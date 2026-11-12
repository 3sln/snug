# Stranger review (JS/TypeScript API-payload persona), 2026-11-12

**First impression.** Following the README recipe, I had a staged package and a working consumer in a couple of minutes, with no network. Every example and every runnable guide snippet worked. The runtime is careful with hostile input: bounded, typed options, no echoing of values. The documentation is the weak point, because it has fallen behind the implementation in places that matter for my use case. The docs describe a JS `warnings` result for the discriminated-union footgun, and it does not exist. They promise "no greedy array matching", and arrays are now greedy (PEG). They list compile options, limits and error codes that the runtime rejects or never produces. The TypeScript declarations lack the default `'valid'` wire preset. They tell a TypeScript user to install nothing, but nothing is there to check types with. For a browser Web Worker, the only recipe is a workerd `fetch` module.

**What I read and ran.** I read README.md, docs/guide.md, docs/api.md, docs/profiles.md, docs/cddl-support.md, docs/conformance.md (skimmed), docs/release-policy.md (skimmed), CHANGELOG.md, docs/profiles/bindle.md (header only), host/js/package.json, host/js/types/*.d.ts and examples/*. I did not read any src, tests, kin, gen, SPEC, DEVLOG, architecture or program docs. A few lines of program/architecture docs showed up in one grep result; I did not use them. **The worktree was being edited while I reviewed it.** README.md, docs/api.md, docs/guide.md, docs/cddl-support.md, docs/conformance.md and SPEC.md all had uncommitted changes that grew while I worked. Line numbers below refer to **committed HEAD `ac08ec2`** unless marked "WT" (working tree). Each finding says whether the working tree already addresses it. What I did, with all scratch under `.cache/p910-review-js/` and `TMPDIR` set there:

- Built the package with `(cd host/js && TMPDIR=$R npm run build -- $R/staged)`. The build came from the dirty tree.
- Created the README consumer (`main.mjs` printed `7`).
- Ran all 9 `examples/*.mjs`, both from the repository and from the staged copy, where imports are rewritten to `snug/...`.
- Ran the README quick start with `node --input-type=module` in `host/js`.
- Ran every runnable JS block of guide.md (about 25 snippets) in the consumer.
- Wrote probes for: the discriminated union, the Program cache, compile option names and error codes, hostile input, ArrayBuffer/SAB input, session limits, and PEG behaviour.
- Bundled three Worker variants with the already present `bench/compare/node_modules/.bin/esbuild` 0.28.2: the guide's workerd module, a browser dedicated worker, and a compile-in-worker split build. I executed the workerd-style bundle in Node.
- Could not type-check anything: no `tsc` exists anywhere reachable, the same as the docs record.

## Findings

1. **Major — the documented W8 warning does not exist in the JS API.**
   - **Location:** docs/guide.md:94-97; CHANGELOG.md:23,29; docs/cddl-support.md:21,319; WT README.md:125 adds the same claim.
   - **What happened:** The guide says the warning "is in the compile result's `warnings` (JS)". `compile()` returns a `Schema` whose only own key is `program`. `schema.warnings` and `schema.program.warnings` are `undefined`, `console.warn` is not called, and `types/compile.d.ts` declares no `warnings`. Reproduce in the consumer:

     ```js
     const s = await compile('shape = { kind: "a", x: int // kind: "b", y: tstr }');
     Reflect.ownKeys(s); // ['program']
     ```

     This was the safety net I relied on, and it is missing. My first, natural schema `msg = { type: "ping", seq: uint // type: "data", ... // type: "error", ... }` compiled silently. It then rejected every valid `data` and `error` message with `{reason:'value', path:['type'], offset:0}`.
   - **Expected:** A JS-visible warning list (e.g. `schema.warnings` or a `compile(..., { onWarning })` hook), declared in compile.d.ts. Alternatively, docs that say the warning is Rust-only.
   - **Suggested fix:** Expose the warnings on the compile result and declare them, or remove the JS claim from the guide, README and CHANGELOG.

2. **Major — README and cddl-support promise non-greedy array matching; arrays are now greedy (PEG).**
   - **Location:** README.md:14-16 ("There is no greedy array matching or backtracking. Map schemas that cannot be proved exact … fail at compile time"); docs/cddl-support.md:348-352 ("Arrays match Glushkov automata … no first-match or greedy occurrence shortcut. Ambiguous repetitions such as `[? uint, 2*3 uint, tstr]` unroll"); docs/cddl-support.md:298-304 (`{ 1*2 tstr => uint, 1*2 tstr => uint }` "refused with `map_overlap`").
   - **What happened:**
     - `compile('m = [* uint, uint]')` with `[1,2]` gives `{ok:false, reason:'missing', path:[2]}`.
     - `[? uint, 2*3 uint, tstr]` with `[1,2,"x"]` gives `{ok:false, reason:'type', path:[2], offset:3}`.
     - `{ 1*2 tstr => uint, 1*2 tstr => uint }` compiles and accepts `{a:1,b:2,c:3}`.
     - `{ 0*2 (2*2 tstr => uint) }`, which cddl-support:341 says is refused with `map_group_occurrence`, compiles.

     CHANGELOG.md:27 and conformance.md:356 say PEG/Appendix A semantics are now intended. The user-facing README and the cddl-support "Arrays" and "Map determinism" sections still describe the format-1 engine.
   - **Expected:** The README's "Why snug" list and cddl-support describe the current PEG semantics. A guide section, like the cut one, should warn that `[* T, T]` never matches and show how to write it instead.
   - **Suggested fix:** Rewrite README:14-16 and cddl-support:289-352 for format 2.0. Add a "greedy repetition" pitfall next to "Discriminated unions under the RFC cut".

3. **Major — the TypeScript declarations omit the default `'valid'` wire preset.**
   - **Location:** host/js/types/index.d.ts:22-27 (`/** Default 'deterministic'. */ wire?: 'deterministic' | 'bindle';`); index.d.ts:82-87 (`profiles` declares only `deterministic` and `bindle`).
   - **What happened:** At runtime `profiles` has keys `['valid','deterministic','bindle']`, and `schema.validate(b, 'm', { wire: 'valid' })` works. api.md:88 and profiles.md:119-121 document `'valid'` as the default. A TS user who writes `{ wire: 'valid' }` or `{ ...profiles.valid }` gets a compile error (TS2322/TS2339 by inspection; no tsc was available to run). The doc comment "Every value only removes acceptance relative to RFC 8949 §4.2.1" (index.d.ts:23) is also stale under `valid`. The per-field comments ("deterministic: 'any'") never mention `valid`.
   - **Expected:** `wire?: 'valid' | 'deterministic' | 'bindle'`, default `'valid'`, and a `profiles.valid` member.
   - **Suggested fix:** Update index.d.ts. Add a declaration-versus-runtime check that compares `Object.keys(profiles)` and the enum literal sets, not just export names.

4. **Major — compile options, limits and error codes differ between api.md, the .d.ts files and the runtime.**
   - **Location:** docs/api.md:46, 155, 158-163, 169, 679-684, 801-811; host/js/types/compile.d.ts:5-8, 25-31; docs/guide.md:841, 850.
   - **What happened:**
     - api.md:169 lists the `CompileLimits` name `alternatives`. The runtime rejects `compile('m = uint', { limits: { alternatives: 10 } })` with *TypeError "Unknown limits key; allowed options: … pegNodes …"*. compile.d.ts has `pegNodes`, which api.md and the guide never mention.
     - The guide's limits table (guide.md:850, "Map alternatives per sequence 64 / 1,024") has no `pegNodes` row.
     - The `CompileOptions` signature in api.md:155 and the admission table in api.md:46 (`profile`, `limits`, `unicode`) omit `regexp`, `cuts` and `groupWords`; the table also omits `controls` and `controlsInBus`. The runtime's own error message lists all eight: `profile, regexp, cuts, groupWords, limits, unicode, controls, controlsInBus`. guide.md:841 lists only four.
     - SchemaError codes: api.md lists `map_group_occurrence`, `map_cut`, `map_overlap` and `limit_alternatives`, with recovery advice. compile.d.ts:25-31 has none of them, but has `control_registry` and `limit_peg_nodes`, which api.md never mentions. The schema `{ 80 optional keys }` with `limits.pegNodes: 2` produced `limit_peg_nodes`. cddl-support.md:324 says `map_cut` "is withdrawn", while cddl-support.md:437 and profiles.md:307 still say `h'00': T` is refused with `map_cut`. It compiles.
   - **Expected:** One list of compile option names, limits and codes, shared by api.md, the guide, compile.d.ts and the runtime.
   - **Suggested fix:**
     - In api.md: replace `alternatives` with `pegNodes` and `limit_alternatives` with `limit_peg_nodes`, add `control_registry`, and drop or mark as retired the `map_*` codes that are no longer emitted.
     - Give the full `CompileOptions` in api.md:155 and api.md:46.
     - Update the guide's limits table.

5. **Major — no recipe for a browser dedicated Web Worker, and posting a Schema fails silently.**
   - **Location:** docs/guide.md:1080-1131 (the "module Worker" recipe is a workerd `export default { fetch }` module); docs/guide.md:938-940.
   - **What happened:**
     - The only Worker recipe targets workerd/Cloudflare. A browser `new Worker(url, { type: 'module' })` recipe is missing. Such a recipe would need `self.onmessage`, would load Program bytes with `fetch` or a bundled import, and needs a module worker so the compile chunk's dynamic import works. I bundled one; it builds, but nothing documents it.
     - `structuredClone(schema)` (what `postMessage(schema)` does) **succeeds**, but the clone is a plain object without `validate`, so `typeof clone.validate === 'undefined'`. No error tells the developer that Schemas cannot cross a thread boundary.
     - The guide's workerd bundle runs correctly when imported into Node: `{ok:true}`, and `{ok:false, reason:'type', path:['id'], offset:4}` for `id:-1`.
   - **Expected:** A short dedicated-worker recipe (main thread posts bytes, worker holds the Schema, Programs are sent as `serialize()` bytes), plus a statement that Schema and Program objects are not structured-cloneable and must be sent as `serialize()` bytes.
   - **Suggested fix:** Add the recipe and the clone note to "Browser and Worker recipes". Consider making Schema/Program non-cloneable, e.g. with a private field brand that makes `structuredClone` throw.

6. **Minor — caching by `sourceKey` requires compiling first.**
   - **Location:** docs/guide.md:898-951; docs/api.md:302.
   - **What happened:** The cache example keys on `schema.program.sourceKey`, which is only available after `compile()`, the step a cache is meant to skip. No API computes the key from text and options, and the docs do not say how to build a lookup key. I keyed on my own hash of the CDDL text, options and snug revision. Reload worked from a `Uint8Array` and from a Node `Buffer`. A flipped byte gave `ProgramError digest`. A forged format word 1 gave `format_version`. A Program that uses controls loaded without its registry gave `missing_control: .unique`.
   - **Expected:** A documented lookup key for a cold start, and IndexedDB/Cache API guidance for browsers.
   - **Suggested fix:** Document "key the cache on your own (text, options, snug revision) hash and store `sourceKey` beside it to check after load", or export a pure `sourceKeyOf(text, options)`.

7. **Minor — the guide says there is no session quota or pool; P9.7 added both.**
   - **Location:** docs/guide.md:599-600.
   - **What happened:** The guide says "There is no live-session quota or pool, so bound concurrency in the application." api.md:464-520, sources.d.ts and CHANGELOG.md:59-62 document `sessionLimits`, which defaults to `maxLive` 1024 and 2 MiB pooled, together with `releasePool` and `close()`. With `sessionLimits({maxLive:1})`, a second `openSession` throws `SnugFault` `sessions/limit`.
   - **Expected:** The guide matches api.md.
   - **Suggested fix:** Replace the sentence with a pointer to `sessionLimits`, and say that abandoned sessions hold slots until GC.

8. **Minor — the `sessions/limit` code is missing from the error tables and `FaultCode`.**
   - **Location:** docs/api.md:664-671; host/js/types/index.d.ts:68.
   - **What happened:** The runtime throws `SnugFault` with `code === 'sessions/limit'`. It is not in api.md's error-family table, its recovery tables, or the `FaultCode` union.
   - **Expected:** It is listed and declared.
   - **Suggested fix:** Add it to the "Other code / class" recovery table and to `FaultCode`.

9. **Minor — controls.d.ts lacks `cost` and states the wrong cost.**
   - **Location:** host/js/types/controls.d.ts:1-15; compare docs/api.md:195-197 and docs/guide.md:223-235.
   - **What happened:** api.md's `Control` type and the guide's example (`sig: { check: verifySignature, cost: n => 64 + 50 * n }`) use `cost?(itemBytes)`. The d.ts object variant has no `cost`, so `const c: Control = { check, cost }` would be an excess-property error. Its doc comment says a control "costs one budget unit per item byte", but api.md says 17 units plus `cost(itemBytes)`. The runtime accepted `cost`.
   - **Expected:** `cost?(itemBytes: number): number` is declared, and the comment matches api.md.
   - **Suggested fix:** Update controls.d.ts.

10. **Minor — stale "deterministic is the default" and "format 1.x" statements (partly fixed in WT).**
    - **Location:** HEAD README.md:194 ("format 1.0 (1.1 …)") and :198 ("Deterministic preset (default)"); docs/api.md:218, 304, 312, 325 (format 1.1); docs/guide.md:245, 919, 928 (format 1.0, "Current loader 1.0"); docs/guide.md:349 (column header "Deterministic preset (default)"); docs/api.md:733 (`not_map`: "Codec/view/profile scanner defaults to map root"); host/js/types/schema.d.ts:29 ("format 1.1").
    - **What happened:** The serialized header's format word is `2`, and a format word of 1 is refused with `format_version`, as CHANGELOG.md:83 says. The default preset is `valid`. Codec `decode(encode([1,2]))` works without `top`. release-policy.md:519-526 already lists some of these as known stale. **The WT fixes** README:194/198 and the api.md/guide.md format sentences. guide.md:349, api.md:733 and schema.d.ts:29 are still stale in WT.
    - **Expected:** Consistent statements of format 2.0 and the `valid` default.
    - **Suggested fix:** Finish the sweep: guide.md:349, api.md:733 and schema.d.ts:29.

11. **Minor — the README entry-point table omits `snug/sequence` and `Simple`; api.md miscounts the declaration files.**
    - **Location:** README.md:111-121; docs/api.md:4.
    - **What happened:** package.json exports `./sequence`, and the README's "exports only these supported entry points" table does not list it. Runtime `snug` exports `Simple`, which is in index.d.ts, but the table omits it, and api.md's `snug` export table has no `Simple` row. api.md:4 says "seven declaration files"; there are ten (`abnf`, `compile`, `controls`, `index`, `schema`, `sequence`, `sources`, `unicode`, `view`, `writer`).
    - **Expected:** The table lists every export, and the count is right or dropped.
    - **Suggested fix:** Add `snug/sequence` (`readSequence`, `sequenceReader`, `sessionLimits`, `releasePool`) and `Simple`. Drop the number "seven".

12. **Minor — the README examples list was incomplete at HEAD.**
    - **Location:** HEAD README.md:97-103.
    - **What happened:** It listed 7 of the 9 examples; `session.mjs` and `sequence-sse.mjs` were missing. All 9 pass both from the repository and staged. **WT fixed.**
    - **Expected:** All examples listed.
    - **Suggested fix:** None beyond the WT change.

13. **Minor — bundle-size claims do not match a compiler-free schema bundle.**
    - **Location:** README.md:203 ("codec + schema ≈ 41.9 KB gzip"); docs/guide.md:1154-1155 (56,226 B for codec/schema/view/writer/sources).
    - **What happened:** A minimal Worker that imports only `fromSerialized` from `snug/schema`, bundled with `esbuild --bundle --minify --format=esm --platform=browser`, is **53,694 B gzip -9**. A codec-only `decode` bundle is 14,926 B, which matches the claimed 14.6 KB. The compiler chunk in a `--splitting` build is 94,858 B gzip and stays out of the static graph, as promised. So schema-only is about 12 KB larger than the README figure, and close to the old "everything" figure.
    - **Expected:** Current sizes, or a dated caveat.
    - **Suggested fix:** Re-measure with `bb size` and update the README, or date the number.

14. **Minor — the build gives no warning about a dirty tree, and the recipe's revision file can mislabel the build.**
    - **Location:** README.md:155-180.
    - **What happened:** I built while another agent was editing docs. The build succeeded silently. `git rev-parse HEAD` recorded `ac08ec2`, but the staged README and docs contain uncommitted text. The README tells the user to "record uncommitted package changes separately", but neither the build nor the recipe helps.
    - **Expected:** The build reports or refuses a dirty tree, or the recipe captures `git status --porcelain`.
    - **Suggested fix:** Have `npm run build` print a dirty-tree warning and write a `PROVENANCE` file (revision plus dirty flag) into the staged directory.

15. **Minor — error offsets differ by spelling for the same failure.**
    - **Location:** behaviour; docs/api.md:280-296.
    - **What happened:** For `{type:'pong', seq:1}`, the type-choice and `=>` forms report `value` at `['type']`, offset 11 (the value). With the cut idiom, a *valid* `data` message reports `value` at `['type']`, offset 0 (the map head). Both are "one deterministic witness", but offset 0 for a key-path value error is unhelpful.
    - **Expected:** The offset points at the offending item whenever the path names a key.
    - **Suggested fix:** Document when offsets point at the container rather than the member, or make them consistent.

16. **Minor — the TypeScript onboarding cannot be checked as documented.**
    - **Location:** docs/guide.md:1001-1051; docs/api.md:4-11.
    - **What happened:** The docs say "Run an already available `tsc` … no compiler install is needed". On this machine no `tsc` exists, and `bench/compare/node_modules/.bin/tsc` is still absent, as the guide notes. The only semantic evidence is TS 5.8.3 on 2026-11-03, before the `valid` preset and format 2.0. Findings 3, 4 and 9 show the declarations have drifted since.
    - **Expected:** A gate that type-checks the declarations against the docs' examples.
    - **Suggested fix:** Vendor or pin an offline `tsc` for the gate, or state that the declarations have not been semantically checked since 2026-11-03.

17. **Nit — `top: 'any'` in codec examples is now redundant and misleading.**
    - **Location:** README.md:84 (`decode(encode([1, 2]), { top: 'any' }); // non-map codec round trip`); docs/guide.md:307.
    - **What happened:** Under the default `valid` preset, `decode(encode([1,2]))` works without `top`. The example suggests it is required.
    - **Expected:** Show that the default works, and keep `top` only for `bindle`.
    - **Suggested fix:** Drop the option or add "(needed only under `wire: 'bindle'`)".

18. **Nit — release-policy lists CHANGELOG packaging as missing, but it ships.**
    - **Location:** docs/release-policy.md:509.
    - **What happened:** It says "Add `CHANGELOG.md` to `package-build.mjs`'s copied files". The staged package contains CHANGELOG.md, and README.md:127 says so.
    - **Expected:** The item is removed.
    - **Suggested fix:** Delete the bullet.

19. **Nit — conformance.md ships in the package despite stale claims.**
    - **Location:** docs/conformance.md:1-30 (staged as `docs/conformance.md`).
    - **What happened:** Package users get an audit with banners and inline "superseded" notes. Its executive summary says, for example, that "Byte validation cannot validate valid non-deterministic CBOR at all", which is false under the current default.
    - **Expected:** Package docs describe current behaviour.
    - **Suggested fix:** Exclude conformance.md from `PACKAGE_FILES`, or put a current-status summary at the top.

**What worked (for calibration, not praise):**
- The README recipe built and ran offline.
- All 9 examples and all runnable guide/README snippets produced the documented results.
- The documented TypeErrors (`maxDepth: 1.5`, `top: 'banana'`, `maxByets`, top-level `compile({ maxBytes })`, `cuts: 'reference'`) match.
- Hostile inputs were refused quickly under the defaults:
  - 10,000-deep nesting: `cbor/depth`, about 2 ms.
  - A 4 GB byte-string length claim: `cbor/truncated`.
  - A map head claiming 2^32 entries: `cbor/truncated`.
  - About 140k items: `cbor/too_many_items`.
  - 1.6 MB: `cbor/too_large`.
- ArrayBuffer and DataView input give a clear TypeError, and SAB input gets "copy SharedArrayBuffer input first".
- The type-choice and `=>` discriminated-union forms give useful witnesses (`missing ['code']`, `type ['payload']`, `unexpected ['*']`).
