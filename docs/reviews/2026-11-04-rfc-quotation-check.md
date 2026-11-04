# RFC quotation check of docs/conformance.md — 2026-11-04

An independent reviewer checked every RFC quotation and paraphrase in `docs/conformance.md` against the published texts. The audit had been written offline and said its quotations were reconstructed from memory. The texts were fetched from `https://www.rfc-editor.org/rfc/rfcNNNN.txt` on 2026-11-04 and saved unmodified under `corpus/rfc/`; the README there gives URLs, hashes and the reproduction terms. RFC 8949, 8610, 9165, 9682, 9485, 8742, 8746, 3339, 3986, 8392 and 9052 were fetched. The audit cites RFC 8392 and RFC 9052 only in the prevalence table, without quoting them. The RFC 8610 errata page was also consulted.

Three behaviours were re-probed against a `git archive HEAD` snapshot, because the shared working tree was mid-edit at the time. The probes used `compile(...).validate(bytes,'r')`:

| Probe | snug verdict | RFC verdict |
| --- | --- | --- |
| `r = [* uint, uint]` on `[1]` (`8101`) | ok | no match: Appendix A says `"*a a"` “never can match anything” |
| `r = [? uint, 2*3 uint, tstr]` on `[1,2,"x"]` | ok | no match: greedy `?` takes `1`, then `2*3 uint` fails |
| `r = [(uint // uint, uint), tstr]` on `[1,2,"x"]` | ok | no match: prioritised choice locks in `uint`, then `tstr` fails on `2` |
| `r = uint .default 1` on `1` | ok | no match by the published text (“implied .ne control”); contested by Erratum 9229 |
| `r = #7.24` on `f820` | refused `cbor/simple` | RFC 9682 §3.2: `#7.24` is additional information 24, i.e. simple values 32..255 |
| `r = #7.<24>` | compile `syntax` | valid RFC 9682 §3.2 syntax |

No code was changed.

## Results

Verdicts: **exact**; **minor wording difference**; **misquote** (the words are not in the RFC); **wrong section**; **paraphrase unfaithful**; **paraphrase faithful**.

| # | Q-label / location | Audit text | Actual RFC text | Verdict | Classification effect |
| --- | --- | --- | --- | --- | --- |
| 1 | Q1 | 8949 §4.2.1 “Preferred serialization MUST be used.” | §4.2.1: “Preferred serialization MUST be used.” | exact | none |
| 2 | Q2 | 8949 §4.2.1 “Indefinite-length items MUST NOT appear.” | §4.2.1: “Indefinite-length items MUST NOT appear.  They can be encoded as definite-length items instead.” | exact | none |
| 3 | Q3 | 8949 §4.2.1 “The keys in every map MUST be sorted in the bytewise lexicographic order of their deterministic encodings.”; §4.2.3 length-first | identical in §4.2.1; §4.2.3 defines “length-first core deterministic encoding requirements” | exact | none (S03 stands) |
| 4 | Q4 quote | §§4.1–4.2.2 “shortest form that preserves the value” | §4.2.1: “Floating-point values also MUST use the shortest form that preserves the value”. §4.1 has “shortest floating-point encoding that preserves the value being encoded” | exact (the phrase is in §4.2.1) | none |
| 5 | Q4 paraphrase; §c NaN bullets; exec summary bullet 4 | §4.2.2 covers NaN/zero/int-float choices; f97e00-only is an additional policy, not a §4.2.1 MUST; payload NaN that cannot narrow is not “non-shortest” | §4.2.2: “If NaN is an allowed value, and there is no intent to support NaN payloads or signaling NaNs, the protocol needs to pick a single representation, typically 0xf97e00.” §4.1: “For NaN values, a shorter encoding is preferred if zero-padding the shorter significand towards the right reconstitutes the original NaN value” | paraphrase faithful | none (D122/S12 deliberate deviation stand; the text recommends exactly this kind of additional rule) |
| 6 | Q5; D180; S08; §j | 8949 §9.2 lists the invalid tag numbers | They are in **§3.4**: “IANA allocated tag numbers 65535, 4294967295, and 18446744073709551615 …”. §9.2 only gives the registration ranges | wrong section | none |
| 7 | Q5; §j | “permanently invalid tag numbers”, “impossible tag number” | §3.4: “These tags are not intended to occur in actual CBOR data items; implementations MAY flag such an occurrence as an error.” | paraphrase unfaithful (overstated) | none: refusing is permitted (MAY), so D180/S08 stay conformant |
| 8 | Q5; S07 | “§9.1 reserves simple values 24..31” | §3.3 Table 4: “24..31 (reserved)”. §9.1 lists only the registrable ranges 0..19 and 32..255 | wrong section | none |
| 9 | Q6 | Existential assignment; “No specified implementation requires greedy selection or no-backtracking.” | App. A (normative): prioritized choice is “tested in left-to-right order, locking in the first successful match”; “the occurrence indicators ("?", "*", "+") are "greedy" in PEG”; “"*a a" in CDDL syntax never can match anything”. §3.5.3: arrays are “fully determined by the PEG formalism”; for maps, pathological picks are “indeterminate” | paraphrase unfaithful | **D012, D036, S28 → non-conformant**. D010 (single-item type sets), S23 (non-pathological maps) and S29/S30 (refusals) are unchanged |
| 10 | Q7 | XSD “Appendix F” | §3.8.3: “XSD regular expressions are defined in Appendix F of [W3C.REC-xmlschema-2-20041028].” | exact | none |
| 11 | Q7; D014's “RFC 8610 §3.8.3 anchoring” | matching is “implicitly anchored at both ends” (8610 §3.8.3) | Not in RFC 8610 or RFC 9485. Anchoring comes from XSD semantics, which RFC 9485 §4 makes normative. RFC 9485 §5.3 maps to ECMAScript with “Envelope the result in ^(?: and )$”; §5.4 uses `\A(?: … )\z` | misquote | none (S38 still conformant: whole-string matching follows from XSD/9485 §§4–5). §3.8.3.1 also confirms “"." matches any character but the line-ending characters \r or \n” |
| 12 | Q7; D014, D083, D110, D111, S37–S40 | RFC 9485 §2 defines the subset | §2 is “Objectives”. Syntax is **§3** (“essentially an XSD regexp without” subtraction, multi-character escapes and Unicode blocks); semantics §4 | wrong section | none. Note: §3 requires full Unicode property support (“MUST support the Unicode character property set”), which is consistent with S39/D083 being *incomplete* |
| 13 | Q8 | “the entire map fails” | §3.5.4: “… so when it does not, the entire map fails to match.” | minor wording difference (truncated clause) | none |
| 14 | Q8; exec summary bullet 1; §a | Paraphrase: a failed cut only blocks later entries in the same branch, and “Choice alternatives can still supply another match” | §3.5.4: later matches for the key “in later entries in the group of the map are no longer allowed … the entire map fails to match.” App. A: PEG choice locks in “(but not disabling alternatives in choices containing this choice, as a cut (Section 3.5.4) would)” | paraphrase unfaithful | **D021, S26 → deliberate deviation**. The literal text is global, and DEVLOG D021 calls its per-alternative reading “a deliberate reading” with a reason. The reference tools agree with D021 |
| 15 | §a last table row | Cut-free `{? "a" => uint, * tstr => any}` with `{a:"bad"}` is valid | §3.5.4: `{ "optional-key": "nonsense" }` “does match this specification: while the first entry of the group does not match, the second one (the wildcard) does.” | paraphrase faithful (now directly confirmed) | none |
| 16 | Q9; D210–D217; S53–S55 | Sequence = concatenated complete items, no delimiters, zero items allowed, truncated tail detectable | 8742 §2: empty sequence, or “an encoded CBOR data item … followed by a CBOR Sequence”; “do not use a marker between items”; “can reliably detect truncation of the bytes making up the last CBOR data item” | paraphrase faithful | none |
| 17 | Q10 | “empty type choice” | §3.9: “the symbol is then taken to be an empty type choice (group choice), i.e., no choice is available.” | exact | none |
| 18 | Q10 | “empty group choice” | §3.9: “starting out as an empty group choice”; “there is no way to satisfy the rule (i.e., the choice is empty)” | exact | none (S32 non-conformant is strengthened) |
| 19 | S32; §i heading | basis “9682 clarifications”; “RFC9682 grammar, prelude and sockets” | RFC 9682 says nothing about sockets or the prelude | wrong section (wrong RFC) | none |
| 20 | Q11 (.size/.bits/.and/.within/comparisons); S19–S21, S42, S47, S49 | `.size` counts bytes/magnitude; `.bits` positions; `.and/.within` intersection; comparisons | §3.8.1 “directly controls the number of bytes in the string”, “uint .size N” ≡ “0...BYTES_N”; §3.8.2 “(str[n >> 3] & (1 << (n & 7))) != 0”; §3.8.5 “intersection”; §3.8.6 comparisons and composite `.eq/.ne` | paraphrase faithful | none |
| 21 | Q11; S46; §d `.default` row | “`.default` is annotation”; “does not relax matching” | §3.8.6: “A variant of the ".ne" control is the ".default" control … the implied .ne control is there to prevent this value from being sent over the wire.” Erratum 9229 (Reported 2026-10-16, not verified) proposes the annotation-only reading | paraphrase unfaithful | **S46 → non-conformant** against the published text. snug's `uint .default 1` accepts `1`. It would revert to conformant if Erratum 9229 is verified |
| 22 | Q12; D013, S41, S43–S45 | RFC 9165 §§2–4 controls | .plus §2.1, .cat §2.2, .det §2.3, .abnf/.abnfb §3, .feature §4. §2: “Not all tools may be able to work with non-unique targets or controllers.” §4: a tool “may mark the instance as using a feature”; enable/disable is only something “One could also imagine” | paraphrase faithful | none (S43 incomplete is explicitly anticipated by §2) |
| 23 | Q12 | `.pcre` in RFC 8610 §3.8.3 | §3.8.3.2: “a proposal for a ".pcre" control is defined in [CDDL-Freezer]” | wrong section (subsection) | none |
| 24 | Q13 | 9682: “grammar/prelude clarifications … Unicode escape forms and nonliteral tag-number notation” | 9682 changes only the grammar: §2.1 escapes and SCHAR/BCHAR/PCHAR; §3.1 zero-rule files; §3.2 `#6.<type>` **and `#7.<type>`**; for #7, 24..31 “stands for the "additional information"”. No prelude change | paraphrase unfaithful (prelude claimed; #7 and §3.1 omitted) | none for S34/S35 |
| 25 | §j `#7.24` | compiling `#7.24` to an uninhabited predicate is fine | 9682 §3.2: `#7.24` is additional information 24 = simple values 32..255 | paraphrase unfaithful | none for S07 (which is about data). New coverage gap: `#7.<type>` is a syntax error, and `#7.24` is empty only because of S06 |
| 26 | Q14; S56, S57 | Typed arrays: byte-string payloads, tags 64–87, 76 reserved, element bytes | 8746 §2: “encoded as a single CBOR byte string”, tags “from 64 to 87”, the LE sint8 tag (76) “MUST NOT be used; its tag number is marked as reserved” | paraphrase faithful | none |
| 27 | §h; S58 | “RFC8746's unsigned shape list does not impose these local positive/rank bounds” | §3.1.1: dimensions “are unsigned integers distinct from zero”; §3.1.2: tag 1040 is “The same as tag 40, except …” order | paraphrase unfaithful | none: S58 stays a deliberate deviation for the rank bounds only, and zero-extent refusal is now known to be required |
| 28 | Q15; S04; exec summary bullet 3 | Duplicate keys and malformed UTF-8 are invalid; tag-content validity is separate | 8949 §5.3.1 lists “Duplicate keys in a map” and “Invalid UTF-8 string” as the two basic validity errors; §5.3.2 covers tag validity; §5.6 describes “enforce validity for maps” | paraphrase faithful | none |
| 29 | S66; E10 | JS Map merges integer 1 and float 1.0 keys | 8949 §5.6: “in JavaScript Maps [ECMA262], a key of integer 1 cannot be distinguished from a key of floating-point 1.0”; §5.6.1: they are distinct at the generic level | paraphrase faithful | none |
| 30 | §b paragraph after examples | `[? uint, 2*3 uint, tstr]` accepting `[1,2,"x"]` is valid; Ruby/Rust are “not existential” | Under App. A greedy semantics `[1,2,"x"]` does not match, so Ruby/Rust are right | paraphrase unfaithful | part of row 9 |
| 31 | S24; §b examples | “Valid finite overlapping counters … refused” | §3.5.3: such overlapping picks are “indeterminate” and specification writers are “urged to not write pathologically non-deterministic specifications” | paraphrase unfaithful (overstated) | none: refusing an indeterminate schema is still incomplete coverage, not a wrong meaning |
| 32 | D031/S33 | Prelude replacement is a portability deviation | App. D: “The following prelude is automatically added to each CDDL file”; “the prelude is deemed to be fixed” | paraphrase faithful (supports the deviation) | none |
| 33 | S14, S18, S65, §f | Prelude float widths; integer/unsigned include bignums; 40 names | App. D: `float16 = #7.25` …; `integer = int / bigint`; `unsigned = uint / biguint`; 40 rule names | paraphrase faithful | none |
| 34 | S60, D121 | Tag 32 must be a valid RFC 3986 URI | 8949 §3.4.5.3: “If the text string doesn't match the "URI-reference" production, the string is invalid.” | paraphrase faithful | none |
| 35 | S61, §j | RFC 3339 §5.7 restricts leap seconds | RFC 3339 §5.6 `time-second` “00-58, 00-59, 00-60 based on leap second rules”; §5.7 limits leap seconds to the end of months in which one occurs | paraphrase faithful | none |
| 36 | S64 | §3.4.6 imposes no nesting prohibition | §3.4.6: tag 55799 is for use “at the start of a stored encoded CBOR data item”, with semantics “exactly identical to the semantics of the tag content itself”; no prohibition | paraphrase faithful | none |
| 37 | S10, D181 | Preferred minimal bignums | 8949 §3.4.3: preferred serialization “never makes use of bignums that also can be expressed as basic integers” and leaves out leading zeroes; decoders “MUST be able to decode bignums that do have leading zeroes” | paraphrase faithful | none |
| 38 | S06, S36 | Unassigned simple values 0..19/32..255 are valid | 8949 §3.3 Table 4 “(unassigned)”; two-byte forms below 32 are “not well-formed” | paraphrase faithful | none |
| 39 | S50, D040 | `.cborseq` matches a virtual array | 8610 §3.8.4: “When the data items are taken as an array, the array matches the type” | paraphrase faithful | none |
| 40 | S11 | Decimal normalisation is not required by §4.2.1 | 8949 §4.2.2: “The same number can be represented by different decimal fractions … needs to be explicit about how the formats for deterministic encoding are to be chosen.” | paraphrase faithful | none |

### Counts

40 rows:

| Verdict | Count | Rows |
| --- | --- | --- |
| exact | 7 | 1, 2, 3, 4, 10, 17, 18 |
| minor wording difference | 1 | 13 |
| misquote | 1 | 11 |
| wrong section | 5 | 6, 8, 12, 19, 23 |
| paraphrase unfaithful | 9 | 7, 9, 14, 21, 24, 25, 27, 30, 31 |
| paraphrase faithful | 17 | 5, 15, 16, 20, 22, 26, 28, 29, 32–40 |

## Classification changes (6 items)

| Item | Was | Now | Reason |
| --- | --- | --- | --- |
| D012 | conformant but incomplete | non-conformant | NFA/existential array matching accepts data rejected by RFC 8610 Appendix A's normative greedy, prioritised PEG semantics |
| D036 | conformant but incomplete | non-conformant | same row text as D012 |
| S28 | conformant | non-conformant | same; the row text “no greedy shortcut” directly contradicts Appendix A |
| D021 | conformant | deliberate deviation | §3.5.4 “the entire map fails to match” and Appendix A's cut-disables-enclosing-alternatives sentence are literally global. D021 documents its per-alternative reading as deliberate |
| S26 | conformant | deliberate deviation | as D021 |
| S46 | conformant | non-conformant | §3.8.6 `.default` has an “implied .ne control”. Contested by Erratum 9229 (Reported, not verified) |

Revised totals: 143 conformant, 43 conformant but incomplete, 20 deliberate deviation, 10 non-conformant (were 147/45/18/6).

## Corrections applied to docs/conformance.md

1. Added a dated note at the top. It lists the verified quotations, the corrected ones and the six classification changes, and gives the revised totals. The inventory-count sentence in the executive summary now carries the revised numbers.
2. Q4: added the §4.1 NaN-shortening sentence, which supports the audit's NaN argument.
3. Q5: §9.2 → §3.4, quoting the allocation and “MAY flag” sentences; “permanently invalid” withdrawn; simple 24..31 → §3.3 Table 4.
4. Q6: rewritten around Appendix A and §3.5.3. Arrays are PEG (greedy, prioritised); maps are PEG-picked with pathological cases indeterminate.
5. Q7: the RFC 8610 Appendix F sentence and the §3.8.3.1 dot sentence are now quoted. The “implicitly anchored at both ends” attribution is withdrawn, and anchoring is sourced to XSD via RFC 9485 §§4–5. RFC 9485 §2 → §3.
6. Q8: full verified cut sentence plus the Appendix A parenthetical. The paraphrase now states that the literal text is global and that D021's reading is deliberate.
7. Q11: `.default` implies `.ne` (with the erratum status). Subsections given.
8. Q12: `.pcre` → §3.8.3.2.
9. Q13: RFC 9682's actual scope (escapes, zero-rule files, `#6`/`#7` head numbers; no prelude or socket change).
10. Q14: tag 40/1040 dimensions are nonzero.
11. Rows: “9485 §2” → “9485 §3” (D014, D083, D110, D111, S37–S40). D180/S08 §9.2 → §3.4. S07 §9.1 → §3.3 Table 4. S24 basis notes §3.5.3 indeterminacy. S32 drops “9682 clarifications”. S58 notes zero extents are RFC-required. D012/D036/S28/D021/S26/S46 reclassified, each with an inline reason.
12. Prose: exec summary bullets 1–2 annotated (D021; E5's array agreement is not RFC evidence). §a D021 paragraph annotated, with §3.5.4's own example confirming the cut-free row. §b's `[? uint, 2*3 uint, tstr]` paragraph corrected. §d `.default` row annotated. §h zero-extent sentence corrected. §i note on RFC 9682's scope. §j's tag-number section and wording corrected, and the `#7.24` note added.

## Follow-ups for the owner (not applied; the ranked fix list was left unchanged)

- **PEG array semantics (D012/S28).** This is the largest new finding. Matching RFC 8610 Appendix A means greedy occurrences and committed group choices in arrays. That changes what the Glushkov/NFA engine must accept, and the corpus oracle (`corpus/tools/oracle.mjs`) encodes the existential reading. Decide between implementing PEG semantics, or documenting existential matching as a deliberate, more permissive deviation (with its own D-entry and reason).
- **Cuts (D021).** Either keep the documented reading, now classified as a deliberate deviation that matches the reference tools, or offer the literal global cut as an option.
- **`.default` (S46).** Track Erratum 9229. If it is rejected or left unverified, lower `.default` to `.ne`.
- **RFC 9682 §3.2 `#7.<type>`, and `#7.24..31` as additional information.** These are coverage gaps next to S35/S36.
- Recheck errata status before any certification; this check consulted only the RFC 8610 errata page.
