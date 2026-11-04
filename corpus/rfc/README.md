# RFC texts (authoritative plain-text copies)

Fetched 2026-11-04 with `curl -sfL https://www.rfc-editor.org/rfc/rfcNNNN.txt`
so that spec-conformance audits can quote and check RFC wording offline.
The files are byte-for-byte copies of the RFC Editor's plain-text versions:
do not edit them. Put notes, extracts and derived files beside them.

| File | RFC | Source URL | SHA-256 |
| --- | --- | --- | --- |
| `rfc8949.txt` | RFC 8949 (STD 94) CBOR | https://www.rfc-editor.org/rfc/rfc8949.txt | `f1164a5b31a39350ad46abe29b83575eb933ca6c45366989c118b6b1058a214a` |
| `rfc8610.txt` | RFC 8610 CDDL | https://www.rfc-editor.org/rfc/rfc8610.txt | `3713f2a50e23a2bea0a6147ad6c4433605a00c3d00a868bfa86a42b204997089` |
| `rfc9165.txt` | RFC 9165 Additional CDDL control operators | https://www.rfc-editor.org/rfc/rfc9165.txt | `94f86116c04fde0f11d54576465181090ec33983d78db82527c0703a41976774` |
| `rfc9682.txt` | RFC 9682 Updates to the CDDL grammar | https://www.rfc-editor.org/rfc/rfc9682.txt | `d35602e7f784e509a5984283ea8d998adfee23f086ad0d77bd22f98c6cdea89c` |
| `rfc9485.txt` | RFC 9485 I-Regexp | https://www.rfc-editor.org/rfc/rfc9485.txt | `61e7addfe64e3b0fbff96619d067f3812aa9960cf9b87526d064c3fb3bfbe91f` |
| `rfc8742.txt` | RFC 8742 CBOR Sequences | https://www.rfc-editor.org/rfc/rfc8742.txt | `4462966836b60f42ebae9b5f1d2a479c328e16f0380a3434311a083bccbce30e` |
| `rfc8746.txt` | RFC 8746 CBOR tags for typed arrays | https://www.rfc-editor.org/rfc/rfc8746.txt | `26d0f7d0ee9d2e7dedc382cff6ad1dfe74d25f28fb66b20157a3bbd78baf4fe8` |
| `rfc3339.txt` | RFC 3339 Date and Time on the Internet | https://www.rfc-editor.org/rfc/rfc3339.txt | `9ab2b8864a85dca73a88f49b0927bc7bc85f596926e4fd1890905777924e700a` |
| `rfc3986.txt` | RFC 3986 (STD 66) URI generic syntax | https://www.rfc-editor.org/rfc/rfc3986.txt | `3102dae4b68cebe40337730312fcb612297b8928547267e8b3d1ee6002b2d683` |
| `rfc8392.txt` | RFC 8392 CBOR Web Token | https://www.rfc-editor.org/rfc/rfc8392.txt | `9021ff7c4d274cf34873fe4f4fb17c4fe323247dd0f96bfcab54909bfcdc5f13` |
| `rfc9052.txt` | RFC 9052 (STD 96) COSE structures and process | https://www.rfc-editor.org/rfc/rfc9052.txt | `01eecd7f646537600e7aad665b1fa581ce6ec33dae4ef4add0997aaf38cd0a45` |

Errata are not included. The RFC 8610 errata page
(https://www.rfc-editor.org/errata/rfc8610) was consulted on the same date
for `docs/reviews/2026-11-04-rfc-quotation-check.md`; recheck it before
relying on an erratum's status.

## Reproduction terms

The RFCs published from 2009 onwards (all of the above except RFC 3339 and
RFC 3986) are © the IETF Trust and the persons identified as their authors.
They are subject to BCP 78 and the IETF Trust's Legal Provisions Relating to
IETF Documents (https://trustee.ietf.org/license-info). These provisions
permit anyone to copy, publish, display and distribute RFCs in full and
without modification. Code Components extracted from them are under the
Revised BSD License, as each document states.

RFC 3986 (2005, © The Internet Society) is likewise subject to BCP 78; its
rights are now administered by the IETF Trust under the same provisions.
RFC 3339 (2002, © The Internet Society) carries the pre-BCP 78 "Full
Copyright Statement". It allows the document to be copied and furnished to
others provided the copyright notice and that paragraph are kept, and it
forbids modifying the document itself.

Each file here is unmodified and keeps its original copyright notice.
