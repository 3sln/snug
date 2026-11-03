Usability review — 2026-11-03

My first impression is that snug has a useful, unusually explicit safety model, but its consumer documentation has fallen behind several working features. I could evaluate it without learning kin. The literal README quick start worked: it printed `7 hello` and `7`. Compiling a small API schema, checking hostile bytes, reading selected fields, writing deterministic bytes, reloading a Program, and validating an asynchronous handle all worked. Those are substantial positives. The explanations of closed maps, UTF-8 sizes, null-prototype objects, trusted Program caches, immutable source snapshots, and finish-time encoding limits saved me from incorrect assumptions.

I would consider a Node pilot for a protocol that fits the current wire policy. I would not yet choose it as an interchangeable general CBOR library: ordinary CBOR features are deliberately unavailable, configuration mistakes are treated inconsistently, and some diagnostics require knowledge that the consumer docs do not supply. There was no blocker in the requested happy-path workflows. The major findings below concern adoption risks and real contract inconsistencies, rather than a claim that every surprise is a bug.

I read README, guide, API, CDDL support, profiles, examples, package exports and declarations before consulting internals. All exploratory code used exported package entry points. Scratch scripts and logs are in the gitignored `.cache/docreview/`; `probe.mjs` covers the main workflow and `edges.mjs` covers additional misuse. Tests ran on Node v24.6.0 / npm 11.5.1. No network was used. After the stranger pass, I consulted SPEC, architecture, relevant DEVLOG entries and the Program container text only to check claims; I did not read kin or implementation sources. Reading `bench/*.md` was the final evidence-gathering step. Findings that came from that later check are identified below.

What I actually ran:

- The README quick start from `host/js`, using package self-reference, and all seven files in `examples/`. All completed successfully.
- Independent round trips for large positive/negative bigints, safe bigints, decimals, bytes, Uint16/Float32 arrays, Float16Bytes and an NDArray; ordinary and COSE maps; scalar and array roots. Assertions checked representative values, native-array equality and null prototypes.
- A request schema with required and optional fields, a literal choice, bounded array and regexp; success/error response alternatives. Good requests and both response variants passed. Bad types, choices, patterns, missing/unknown members and excess array elements produced refusal results without echoing the test secrets.
- Views, a Cursor, detached field validation, typed Writer calls, deterministic byte equality, sticky Writer failures, Program serialization/reload through both loaders, and a corrupted-container refusal.
- Async handle validation of good/bad messages, short reads, Promise reads passed to the sync driver, propagated transport exceptions, and declared-length push validation with small chunks and quanta.
- Wrong argument types and rule names, invalid options, oversized buffers, tiny budgets, SharedArrayBuffer refusal, and intentional mutation of borrowed bytes and owned-view aliases.
- A staged package consumed by a separate scratch project using `npm install --offline --ignore-scripts --no-audit --no-fund`, with npm's cache also inside scratch. All seven installed entry points worked; an unsupported deep import was blocked. Staging required the workaround in finding 8.

I did not run the complete host test suite, semantic `tsc` checking, a browser/Worker suite, Rust/wasm gates or new performance measurements. No `tsc` command was available. TypeScript observations below come from the published declarations, not an invented successful compiler run. Existing benchmark numbers are cited as recorded evidence, not measurements from this review.

1. **Major — malformed schema options become data refusals or successes instead of API errors.**

   Location: `docs/guide.md`, “Errors and security”, especially line 395; `docs/api.md`, “Errors”, final paragraph; `Schema.validate`, `Schema.decode`, schema-backed `view`, `validateHandle`.

   What happened: codec `decode(bytes, { maxBytes: 'x' })` threw a clear `TypeError`. The schema APIs instead treated that option as a limit and reported `cbor/too_large` or threw `SnugFault('too_large')`. Negative limits and string budgets also became ordinary validation failures. Fractional `maxDepth: 1.5`, `maxBytes: Infinity`, and `top: 'banana'` were accepted on my valid map. I reproduced the inconsistency across validation, decode, checked view and async validation.

   Expected: the same malformed configuration should be rejected before inspecting data. The documented distinction between misuse and validation refusal matters when deciding whether a request is bad or the server is misconfigured.

   Fix: validate documented option types consistently at every public schema boundary: finite non-negative integers for limits/budget and explicit enum checks for `top`/`objects`. Throw safe `TypeError`s. Add cross-facade cases for the examples above. Keep ordinary resource exhaustion as a `ValidationResult`.

2. **Major — the in-memory snapshot helper has a Node Buffer ownership trap.**

   Location: `bufferHandle`; `docs/guide.md`, “Validating remote objects and streams”, paragraph ending with `Buffer.slice`; `docs/api.md`, Sources function table.

   What happened: after `const h = bufferHandle(Buffer.from(encode({ id: 7 })))`, mutating the original Buffer's last byte changed what `h.read(...)` returned. My concrete probe retained the Buffer in a variable and observed decoded `id` change to 9. The guide does disclose this caveat for the in-memory helpers, so this is a documented API weakness rather than a hidden contradiction. An ordinary Uint8Array is copied. An owned `view(Buffer)` also correctly survived mutation of its original Buffer.

   Expected: a helper advertised for snapshot construction should own its snapshot for the common Node byte type too. An experienced Node developer is especially likely to pass a Buffer.

   Fix: copy accepted input with a mechanism that does not dispatch to `Buffer.slice`, such as `new Uint8Array(bytes)`, in both in-memory helpers. Until fixed, put `asyncHandle(new Uint8Array(buffer))` in the API table and Node example, not just a paragraph farther down the guide.

3. **Major — the decimal factory and the demonstrated Writer method do not compose for integral prices.**

   Location: `docs/guide.md:126–133`; `examples/encode-writer.mjs`; `docs/api.md`, Decimal table and Writer table; `host/js/types/index.d.ts`, `Decimal.from`; `host/js/types/writer.d.ts:17`.

   What happened: the example uses `const price = Decimal.from('1.50')` and `writer.decimal(price)`. Changing the input to `'2.00'` or `'0.00'` makes the factory return a number; `decimal(price)` then throws `SnugFault` with code `unsupported` and message `decimal expects a Decimal.` The declarations expose the same mismatch: the factory returns `Decimal | number | bigint`, while the method requires `Decimal`. Normalization and scale loss are documented, but their effect on this example is not.

   Expected: replacing one valid money string with another should preserve the example's control flow.

   Fix: demonstrate `.value(price)` for factory output and explain that integral decimal values use integer CBOR. Keep `.decimal()` for a known non-integral Decimal, or broaden that method deliberately. Show `'1.50'`, `'2.00'` and `'0.00'` together. State explicitly that this is an exact numeric representation, not a fixed-scale money type.

4. **Major — Unicode support is simultaneously implemented, documented and described as unavailable.**

   Location: `README.md:78–88` and feature table line 119; `docs/api.md:3–4`, `:72–86`; `docs/guide.md`, “Optional Unicode regexp tables”; `host/js/package.json:14`; `host/js/types/compile.d.ts`, `CompileOptions`.

   What happened: the README's supposedly complete entry-point list omits `snug/unicode`; its status row calls the Unicode category module planned. The API reference omits `unicode` from CompileOptions and says no Unicode module option is exposed. In contrast, the guide and declarations show it. Importing `tables`, compiling `[\\p{L}\\p{Nd}_-]+` in a CDDL string with those tables, and validating `É2` worked, including through the staged package. Without tables I received the helpful documented `regexp` error naming `snug/unicode`.

   Expected: a newcomer should not have to choose which document to believe.

   Fix: list all seven entry points, add `unicode?: Int32Array` to the API option description, add a Unicode reference section, and split the status row into implemented Unicode versus planned profiles/extensions. Update “six declaration files” to seven. The post-pass check of DEVLOG P7.3 also confirms completion.

5. **Major — the README directs async users to an example that makes an obsolete capability claim.**

   Location: `README.md:66–74`; `examples/async-handle.mjs:6–7`; `examples/validate-handle.mjs`; `docs/guide.md`, “Validating remote objects and streams”.

   What happened: `async-handle.mjs` says current public sources check the profile, not a CDDL rule. That contradicts the guide and the working `validateHandle` API. The README's explicit command list omits `validate-handle.mjs`, the example that actually demonstrates the feature I wanted. I ran it separately and also validated my own request schema asynchronously. The older example additionally says reads resolve on later event-loop turns, while the API reference correctly describes the helper's default delay as a Promise microtask.

   Expected: the recommended async example should demonstrate current schema support and distinguish microtasks from scheduling turns.

   Fix: run `validate-handle.mjs` in the README list; change the old comment to “This example checks only the CBOR profile; use validateHandle for CDDL.” Explain that `quantum` enables cooperative scheduling and that default helper reads alone do not imply an event-loop turn per read.

6. **Minor — the profile object is documented incompletely in the profile reference.**

   Location: `docs/profiles.md:12–16`, compared with `docs/api.md:55` and `host/js/types/index.d.ts`, `profiles`.

   What happened: profiles.md spells the object as `{ top: 'map', cose: false }`; the actual object and declarations also contain `strictArrays: true`. This has observable behavior: my array with an extra named property encoded under defaults and failed with `unsupported` under `profiles.bindle`.

   Expected: the document dedicated to profiles should describe every behavior the preset selects.

   Fix: show the actual three-property object and explain the strict-array behavior there. Clarify that `top` affects checking/decoding, while encode does not enforce a map root even when given this preset.

7. **Major compatibility limitation, documented — “strict deterministic CBOR” is a narrower product than I initially expected.**

   Location: README opening and experimental-status paragraph; `docs/profiles.md`, current wire-policy and tag tables; `cose` and `compile(..., { profile })`.

   What happened: there is no way to accept a nested integer-keyed map, generic tagged value, timestamp tag or scalar infinity under the current policy. `full` is only a compiler restriction set; `cose` enables safe integer labels only at the top level. A nested text-keyed JavaScript Map was also refused in my probe. The documents disclose the wire restrictions correctly, but the practical compatibility decision requires reading several sections and learning two meanings of “profile”.

   Expected: when evaluating a general CBOR dependency, I want to reject or confirm protocol compatibility before studying implementation provenance.

   Fix: add a prominent README “Can it read my protocol?” checklist with common examples: timestamp tags, COSE/CWT nested integer maps, arbitrary tags, undefined/non-finite scalars and non-deterministic producers. State “Currently a restricted deterministic subset; no lenient/general mode.” Keep current restrictions clearly separate from the proposed general preset. An eventual wire-policy selector should have a name distinct from compiler restrictions.

8. **Minor — “new scratch directory” is not enough to explain accepted build destinations.**

   Location: `README.md:90–103`; public `npm run build -- destination` command.

   What happened: a new destination at `.cache/docreview/staged` was refused with `snug: package destination must be a new scratch directory`. The directory did not already exist and `.cache/` is gitignored. The identical command succeeded after setting `TMPDIR` to the absolute `.cache/docreview` path. This suggests the guard recognizes the runtime temporary directory rather than the ordinary meaning of scratch; I did not inspect its implementation.

   Expected: the error should tell me which condition failed and which roots are permitted.

   Fix: document the exact permitted destination rule and print it in the error. Include an example for keeping all build artifacts under a project scratch folder, if supported, using the explicit TMPDIR invocation that worked here. Distinguish “outside the repository”, “beneath os.tmpdir()”, and “must not already exist” instead of calling all three “scratch”.

9. **Minor — installation exists as staging instructions, but the consumer handoff is unfinished.**

   Location: README, “Package layout and reproducibility”; `docs/guide.md:3–6`; package metadata.

   What happened: the quick start works because it runs inside `host/js`. A script in an ordinary project cannot resolve `snug` merely because the checkout exists. “Point a local package dependency/bundler at the staged directory” leaves the exact next commands to me. I supplied a scratch consumer package with `"snug": "file:../staged"`, installed offline and ran a consumer successfully. Copying `host/js` alone would not produce the documented self-contained package.

   Expected: a stranger should get an executable path from checkout to their own project.

   Fix: add a complete local-consumer recipe: build, use the printed path in a `file:` dependency, install locally, run a minimal ESM file. Explain that no registry installation is currently promised, describe what to retain when relocating the dependency, and show how to record the producing repository revision alongside version `0.0.0`.

10. **Major — choice diagnostics can point at a field that is valid in the intended branch.**

    Location: `Schema.validate`; `docs/api.md`, ValidationResult and Errors sections; response choices described in `docs/cddl-support.md`.

    What happened with this schema:

    ```cddl
    response = { ok: true, id: uint }
             / { ok: false, error: tstr .size (1..120) }
    ```

    `{ ok: false, id: 7 }` produced `{ ok: false, reason: 'value', path: ['ok'], offset: 8 }`. I expected an explanation concerning the missing `error` or extra `id`; `false` is explicitly a valid discriminator. `{ ok: false }`, in contrast, reported missing `error`. Refusal itself is correct, but the witness is surprising. The later architecture check explains that deterministic witness selection is intentional; it does not make this diagnostic an intuitive branch explanation.

    Fix: explain in public docs that a single witness is neither an exhaustive error list nor necessarily an explanation of the branch the application intended. Include this concrete example. Longer term, consider a diagnostic mode that prefers an alternative whose literal discriminator matches, while preserving the existing deterministic result contract for callers that rely on it.

11. **Minor — the error code table is useful, but messages and recovery guidance are uneven.**

    Location: `docs/api.md`, Errors; codec `decode`; `view` on SharedArrayBuffer; `SchemaError`.

    What happened: codec `not_map` and `too_large` both had only “The CBOR data is not valid under the Bindle profile.” as their message, with no offset. The structured code distinguishes them, as documented, but a normal error log hides the useful part. SharedArrayBuffer view refusal refers to “architecture §16.2”. The ordinary regexp error gave a code and the `.regexp` position, without saying why a familiar `\d` was refused. Some other messages were excellent: unsafe integer conversion says to use `bigint()`, and decimal JSON refusal suggests a string representation.

    Expected: useful messages should remain payload-free while naming the actual refusal and a likely next step.

    Fix: include the code and a short explanation in each message, e.g. `not_map: codec decode defaults to a map root; use top: 'any' when appropriate`. Replace internal architecture references with public ownership advice. Extend the existing code-family list with meanings and guidance, especially distinguishing budget/resource policy refusals from malformed CBOR. Document that callers should log selected `code`/`reason`/`path`/`offset` fields, not received values or arbitrary transport errors.

12. **Minor — the blanket “wrong arguments use TypeError” rule has visible exceptions.**

    Location: `docs/guide.md:388–395`; `docs/api.md`, final Errors paragraph; Writer methods.

    What happened: `new Writer().text(7)`, `.uint('7')` and `.beginArray('2')` all threw `SnugFault('unsupported')`, making the Writer unusable. These are clearly wrong API argument types, whereas wrong byte arguments and rule names do throw TypeError. The Writer documentation describes sticky errors, but the general error summary tells me to expect another class for misuse.

    Expected: a catch policy should not require discovering exceptions method by method.

    Fix: either normalize typed-method misuse to TypeError with an explicit failure-state policy, or document the existing exception: “Writer argument/admission refusals are sticky SnugFaults; facade byte/rule/options misuse uses TypeError.” Include a wrong-type Writer example in the error table.

13. **Minor — unknown options and two different limit vocabularies make silent configuration mistakes easy.**

    Location: `docs/api.md`, CompileLimits versus ValidationOptions; `docs/guide.md`, Limits; `compile`, `decode`, `Schema.validate`.

    What happened: `compile(text, { limits: { maxBytes: 1 } })` raised the useful `unknown compile limit maxBytes` TypeError, but `compile(text, { maxBytes: 1 })` silently succeeded. Both codec and schema validation ignored `{ maxByets: 1 }`. Compiler limits use `inputBytes`, `depth`, `entries`, `items`; runtime uses `maxBytes`, `maxDepth`, `maxEntries`, `maxItems`. Writer additionally accepts grouped `limits`, which override top-level spellings. My grouped-limit probe confirmed that precedence.

    Expected: mistakes in resource configuration should be especially visible.

    Fix: provide a compact compile/runtime/Writer mapping table next to one complete limits example. Reject unknown keys consistently, allowing the explicitly supported preset properties when a preset is spread across operations. If silent ignoring is intentional, say so and give a supported way to validate configuration. Consider one options object containing named validation and source settings instead of accumulating more positional bags.

14. **Minor — the limits reference omits several operational meanings of its numbers.**

    Location: `docs/guide.md`, Limits; `docs/api.md:83–86`, `:105–107`; CompileLimits and ValidationOptions.

    What happened: zero is allowed and really means zero: compiling with `inputBytes: 0`, `items: 0` or `budget: 0` succeeded, then refused my message. Zero `schemaBytes` or `compileBudget` refused compilation. A per-call `maxBytes` above the compiled cap did not raise an error or lift the cap; a message larger than that cap still failed. A compiler `inputBytes` request above the listed hard ceiling also compiled successfully, so “hard ceiling” does not mean the public call rejects the supplied number. The guide mentions effective limits but leaves the normalization behavior implicit.

    Expected: I need to know whether zero disables a limit, whether excessive limits clamp or throw, and how to inspect the effective values.

    Fix: state those policies explicitly, with a table of omitted/zero/above-cap/invalid cases. Document root depth and whether tags/keys count toward each bound beside the table. Expose read-only effective schema limits if callers are expected to enforce an admission policy around them. Do not use the currently permissive malformed-option behavior as the desired contract; fix finding 1 first.

15. **Minor — encode and decode are not default inverses for non-map roots.**

    Location: `README.md`, Defaults and limits; `docs/api.md:24`, `:31–35`; `encode`/`decode`.

    What happened: `decode(encode([1, 'x']))`, `decode(encode(1.5))` and `decode(encode(7n))` all threw `not_map`; adding `{ top: 'any' }` worked. This is correctly documented, but the first examples all use maps, so the surprise arrives when I try the codec independently. Schema decode has a different default again.

    Expected: a codec round trip is a natural first probe for a JS developer.

    Fix: put `decode(encode([1, 2]), { top: 'any' })` beside the first round-trip example and explain why checking and encoding have different defaults. When the general preset arrives, consider a symmetric any-root codec default with an explicit map-root application policy.

16. **Minor — Map is a much narrower host representation than the Value union suggests at first glance.**

    Location: `host/js/types/index.d.ts`, recursive `Value`; API Value description; guide Decode/Encode sections; `cose`.

    What happened: `encode(new Map([['id', 7]]))` failed with generic `unsupported`. A top-level mixed integer/text Map worked with `cose: true` and decoded back to Map. Nesting a text-only Map inside an object still failed with `cose: true`. Ordinary maps decode to null-prototype objects, not Map. The prose broadly explains the policy, but the recursive declaration cannot express that top-level-only distinction.

    Expected: someone using Map throughout an application needs an explicit conversion recipe, not just the word “map” in a feature list.

    Fix: add a host-value compatibility table covering plain/null-prototype objects, text-only Map, COSE Map and nested Map. Give the exact accepted option combination and a safe conversion example. Improve the unsupported-Map error to identify the top-level/cose requirement without displaying any key.

17. **Minor — exact integer values do not preserve JavaScript numeric type, and unsafe Number integers are floats.**

    Location: guide Decode and Encode sections; `docs/cddl-support.md`, Semantic notes; codec and Writer numeric methods.

    What happened: `7n` round-tripped as number `7`, while the uint64 and larger values remained bigints. More subtly, encoding Number `2 ** 53` succeeded as a float and then failed a `uint` schema with `type`; that numeric value fits CBOR uint64. `Writer.float(1)` was correctly refused and sticky. All these choices have support in the docs, but their combined effect needs a concrete JS example.

    Expected: “exact integers” could easily be read as choosing integer CBOR for every integral Number or preserving bigint identity.

    Fix: show `7n`, `2 ** 53`, `2n ** 53n`, and a bignum beyond uint64 side by side, including encoded kind, decoded JS type and the appropriate CDDL type (`uint`, `unsigned`, `integer`, `float`). Recommend bigint before arithmetic crosses the safe Number domain; the library cannot recover precision already lost in a Number.

18. **Minor — “owned” protects against the original buffer, not mutations through the view's own aliases.**

    Location: guide Views ownership paragraphs; API `bytes`, `raw`, `copyBytes`; `ViewOptions.borrow`.

    What happened: mutating an original `{id:7}` encoding changed a borrowed view's id to 8, while the owned view stayed at 7. Changing the borrowed byte from an integer to null changed the observed kind to `null`; no revalidation error occurred. Mutating the owned view's `raw()` alias changed its value to 9 too. These are deliberate violations of the documented lifetime contract, not failures of the promised contract.

    Expected: the word “checked” may suggest a lasting guarantee, especially with the default owned mode. There is no guard that catches the misuse at the time of mutation.

    Fix: put “mutation invalidates the check; snug does not detect it” directly beside `borrow`, `raw` and `bytes`. Add the small mutation demonstration and safe-copy alternatives. Consider `copyRaw()` for symmetry with `copyBytes()`, or names such as `rawAlias()` that make the risk visible at the call site. Preserve owned copying as the default.

19. **Minor — isNull is an exception to the wrong-kind accessor rule.**

    Location: `docs/api.md`, Views/Cursor paragraph immediately before Writer: “Accessors on the wrong kind throw TypeError”; `View.isNull()`.

    What happened: `.number()` on a text value threw a useful TypeError, but `.isNull()` on an integer returned false. That is a sensible predicate API; the blanket sentence is inaccurate.

    Expected: predicate and conversion methods should be described separately.

    Fix: say “Conversion accessors on the wrong kind throw TypeError; isNull() is a predicate and returns false for other kinds.” Give the same exception for Cursor if intended. Also document index behavior: negative array indexes returned undefined, while a fractional index raised TypeError in my probes.

20. **Minor — TypeScript declarations are discoverable, but there is no usable TypeScript onboarding path.**

    Location: README package table; `docs/api.md` introduction; `host/js/types/index.d.ts`, `Value`; `host/js/types/schema.d.ts`, `Schema.decode`.

    What happened: types are exported, but every decoded result is the full recursive `Value` union. By declaration inspection, copying `const message = schema.decode(...); console.log(message.id)` into TypeScript requires narrowing; validation does not turn it into a request interface. There is no TypeScript example, suggested module resolution/target, supported TypeScript version, or pattern for connecting a handwritten domain type to a checked rule. The support document correctly says CDDL-to-host type generation is outside scope. The docs also honestly disclose that semantic TypeScript checking was unavailable.

    Expected: “hand-written TypeScript declarations” should come with one demonstrated consumer workflow and a clear statement of the inference boundary.

    Fix: add a small `.mts` example, a tested NodeNext/ESM configuration with bigint-capable target/libs, explicit `ValidationResult.ok` narrowing and decoded-value narrowing or a carefully explained application wrapper. Do not advertise an unchecked `decode<T>()` assertion as inferred schema safety. Run that consumer with a pinned offline TypeScript compiler when available and record the actual version; parsing declarations alone is weaker evidence.

21. **Minor — async compilation/loading means a Promise boundary, not background work.**

    Location: `README.md:60–63`; guide Compile once, Limits and Programs; `compile`, `fromSerialized`, `fromProgram`.

    What happened: every compile/load example needs `await`, while the guide correctly says compilation and buffer validation run synchronously. Program serialization is synchronous; loading returns a Promise. The distinction is explained, but a reader trying to avoid blocking a server/Worker still has to assemble the startup strategy themselves. I exercised both loaders successfully; I did not measure responsiveness or cancellation.

    Expected: an experienced JS developer will associate async APIs with an opportunity to yield, so the scheduling contract needs a practical recipe.

    Fix: add “The returned Promise does not make compilation or verification cancellable/background work.” Show precompilation to a trusted Program artifact, one-time startup loading, and validation reuse. Include an explicit worker/process example for hostile compilation rather than implying that awaiting it supplies isolation. Explain why the loaders have a Promise shape while `new Program` verifies synchronously.

22. **Minor — source APIs are thorough but expensive to learn for a small integration.**

    Location: guide “Validating remote objects and streams”; API Sources; `validateHandle(schema, handle, rule, options?, sourceOptions?)` and profile scanners.

    What happened: my async request validation worked with five positional arguments, including `{}` solely to reach `chunk`/`quantum`. Schema validators return results, profile handle scanners return true, scanBuffer returns undefined, and profile refusals throw. A short read produced a useful SourceError; a transport exception propagated unchanged, correctly matching the docs. The push contract additionally requires feeding the declared count and finalizing even after done. None of this is missing, but the number of contracts makes a basic integration feel more advanced than expected.

    Expected: one common validation recipe should be usable before learning low-level sessions, profile scanners and push terminal states.

    Fix: put a minimal schema-handle example first, followed by a result/source/transport error handling example. Add a complete known-length AsyncIterable or ReadableStream adapter that demonstrates quantum handling, remaining-byte delivery and unconditional finalize. Consider an object-style convenience overload with named schema/rule/validation/source fields. State prominently that unknown-length fetch bodies and source decoding are not currently supported.

23. **Minor limitation, clearly disclosed — maxBytes is not an encoding allocation cap.**

    Location: README Defaults and limits; guide Limits; API encode and Writer sections; `EncodeOptions.maxBytes`.

    What happened: encoding with `maxBytes: 1` correctly threw `too_large`, but the contract says the check happens at finish, after growth. Encoding does not get the default input byte cap when maxBytes is omitted. It would be easy to infer the opposite from a shared “Resource bounds” options row; the repeated caveats elsewhere are valuable and accurate.

    Expected: a developer may use a byte limit specifically to bound memory while constructing a response.

    Fix: mark this exception directly in the options table and add “bounds output acceptance, not peak allocation” in the declaration for both encode and WriterOptions. Consider an explicitly named advance-allocation limit in a future Writer API, with prospective checks and a separate documented policy. Keep the current security guidance to bound constructed values and application concurrency; do not present work budgets as transport deadlines.

24. **Minor — regexp documentation assumes more RFC knowledge than a JavaScript user brings.**

    Location: `docs/cddl-support.md`, Controls, Unicode regexp categories, Refused and planned features; guide Unicode example; SchemaError `regexp`.

    What happened: my explicit `[A-Za-z][A-Za-z0-9_-]*` request-name pattern worked; JavaScript-familiar `\d+` was refused with `regexp`. The support table warns about `\d`, `\w`, `\s`, lookarounds and backreferences, and whole-string matching is documented. There is no short supported-pattern cookbook that turns those warnings into a replacement, and escaping involves both JavaScript and CDDL strings. The optional category example is useful but currently appears before the basic validation workflow in the guide.

    Expected: I should be able to write a bounded identifier or ASCII digit rule without reading an RFC or internal automaton description.

    Fix: add paired ordinary-JS-string and `String.raw` examples for ASCII digits, bounded identifiers, whole-string matching and Unicode categories. Show the actual CDDL text after escaping. Link the supported grammar and explain positions counted against limits. Move generation/Rust maintenance detail out of the main JS onboarding path.

25. **Minor — browser/Worker consumption lacks a reproducible public recipe, and the status needs scope.**

    Location: `README.md:100–106`, `:121`, `:127–129`; guide Compile once and Programs; package `exports`.

    What happened in the stranger pass: ESM facades and a dynamic compiler split were described, but there was no concrete browser import/bundler command, Worker entry, runtime compatibility matrix or minimal deployment-free example. I could only establish Node consumption myself. I did not test browsers or Workers.

    Later accuracy check: DEVLOG P7.7 records Chrome/workerd evidence for staged revision `f275938`, including precompiled and runtime-compilation arms, while README says real browser/Worker package evidence is pending. That historical evidence does not establish the current Unicode and schema-source additions; the proper correction is scoped evidence, not an unconditional “all browsers supported” claim.

    Fix: publish a small bundle recipe preserving dynamic imports, a compiler-free Program-loading variant, and local browser/Worker test instructions. Replace blanket pending prose with a dated matrix of revision, entry points and runtime versions actually checked. Keep new APIs pending until tested. Explain the distinction between shipping compiler bytes and merely initializing them lazily in a single-file bundle.

26. **Minor — Program docs are cautious and usable, but send a consumer to conflicting format rules.**

    Location: guide “Programs, caching and compatibility”, especially lines 366–375; API Programs; linked `docs/program.md:1000–1020`.

    What happened: serialization/reload preserved bytes and verdicts, and a flipped byte correctly rejected with ProgramError `digest`. The public guide says format major must match, minor must not be newer, and producer snug version may differ. It then warns that the linked Program document says something older. After the stranger pass I confirmed that document still requires exact producer-version equality. Reading a format reference should not require knowing which D-number supersedes it.

    Expected: one authoritative compatibility statement, with provenance and integrity kept distinct. The trusted-cache warning already does this distinction well.

    Fix: update or explicitly archive the conflicting container paragraph and link directly to the authoritative current rule. Add a short save/load/error example using the exact public classes. Because the package remains `0.0.0`, recommend namespacing application caches by the pinned package/repository revision as well as sourceKey; this is a conservative adoption recommendation, not a cross-version cache failure demonstrated here.

27. **Minor — performance/status evidence is dated carefully in individual records, but the reader is sent to a misleading index.**

    Location: `README.md:119–130`; `bench/README.md`, Method and “Tests and outstanding scanner work”; `bench/VM.md`, P3.6/P6.2; `bench/WRITER.md`, D113.

    What happened in the final evidence check: README reports a 996-test run. `bench/WRITER.md` records a later 1,051-test, zero-failure/skip gate for D113. That does not invalidate the earlier run, but “This work's … passes” lacks a date/revision and looks current. The linked benchmark README still says the scanner is unavailable and decode throws `unavailable`, describing an older implementation; its first timing table is trusted build-only, not public decode. Later VM/view records clearly measure working checking-plus-building APIs. I did not reinterpret the earlier build-only speedup as a decode claim.

    Expected: the top benchmark link should identify the latest relevant evidence before displaying historical results.

    Fix: add an index with date/revision, public operation measured, ownership/copy policy, runtime, and links to historical snapshots. Put an archival banner over the old scanner-unavailable and partial-codec status. Label test totals as specific gate runs, not evergreen properties, and link the exact evidence. Preserve old tables rather than rewriting their measured facts.

    Accuracy conclusions from the requested root benchmark documents: the guide's Unicode sizes match `bench/README.md` exactly (19,377 bytes minified, 9,287 gzip-9, 77,028 decoded ranges). VM P3.6 supports the recorded 2.3M schedule-2 budget calibration, not a universal wall-clock guarantee. VIEW supports the selective-reading rationale, but also shows owned-copy costs, linear lookup costs and cases where full decoding wins. P6.2 measures reused low-level session storage, not the full allocating async-handle facade. WRITER's latest D113 section supersedes the old claim that default array encoding is dominated by mandatory own-key enumeration. README appropriately does not promise a universal speed lead or claim the 20 KB runtime target passed. The root benchmark tables mostly size components or older boundaries; they do not supply one clearly current full public-package runtime-size result. Add that exact artifact to the index instead of asking readers to add component sizes or treat an internal-core benchmark as a package benchmark.

The ten changes that would most improve a stranger's experience, in priority order:

1. Make schema option validation match the codec and the documented TypeError contract; configuration mistakes must not masquerade as bad messages (finding 1).
2. Make Buffer-backed in-memory handles own immutable snapshots by default (finding 2).
3. Reconcile current capability claims across README/API/guide/examples: Unicode, seven exports, schema handle validation, preset properties and dated evidence (findings 4–6, 25, 27).
4. Put a concrete protocol compatibility checklist at the top of README, before a user commits to the restrictive wire policy (finding 7).
5. Fix the decimal Writer example to handle integral factory results and explain fixed-scale money implications (finding 3).
6. Publish an end-to-end local installation recipe with exact staging destination rules and a separate consumer project (findings 8–9).
7. Improve safe error messages, explain alternative witnesses, and document the actual error-class exceptions (findings 10–12).
8. Add a semantically checked TypeScript consumer example with honest narrowing and inference boundaries (finding 20).
9. Consolidate limits/configuration into one operational mapping, reject misspellings, and show a simple async adapter with clear scheduling/ownership rules (findings 13–14, 21–23).
10. Add runnable browser and Worker recipes with split-compiler and precompiled-Program variants, plus a current evidence index that identifies the measured public API boundary (findings 25–27).
