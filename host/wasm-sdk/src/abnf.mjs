// `snug/abnf` for the SDK: the native package's `.abnf` / `.abnfb` controls (D334),
// the same objects. They run through the module's one import in kin's JS (the wasm
// binary does not carry the ABNF engine), with arguments prepared once at bind, so
// verdicts and charges are the native package's.
export { abnf, abnfWith, checkAbnf } from '../../js/src/abnf.mjs';
