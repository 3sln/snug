// `snug/controls` for the SDK: the native package's generic controls (D142),
// the same objects. Given to compile({ controls }) or fromSerialized(bytes, {
// controls }) of the SDK they run inside wasm (kin's Rust, recognised by their
// check function, D171); given to the native package, in kin's JS. Either way
// the verdicts are kin's.
export { chars, unique, samelen, controls } from '../../js/src/controls.mjs';
