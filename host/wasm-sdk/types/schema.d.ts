// @3sln/snug-wasm/schema: the native declarations plus fromSerializedSync.
import './view.js'; // View.release()
import type { ProgramOptions, Schema } from '../../js/types/schema.js';
export * from '../../js/types/schema.js';
/** fromSerialized without the promise: after init, a Worker can load a stored Program at module scope. */
export declare function fromSerializedSync(bytes: Uint8Array, options?: ProgramOptions): Schema;
