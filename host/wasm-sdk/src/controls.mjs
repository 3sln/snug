// `snug/controls` for the SDK: the native package's generic controls,
// the same objects. Given to compile({ controls }) or fromSerialized(bytes, {
// controls }) of the SDK they run inside wasm (the core's Rust, recognised by their
// check function); given to the native package, in the core's JS. Either way
// the verdicts are the core's.
export { chars, unique, samelen, controls } from '../../js/src/controls.mjs';
