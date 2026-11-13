import type { Schema } from './schema.js';
import type { Controls } from './controls.js';
/** Finite non-negative safe integers; unknown keys and malformed values reject with TypeError. */
export interface CompileLimits {
  schemaBytes?: number; nesting?: number; astNodes?: number; instantiations?: number;
  /** Format 2.0: PEG nodes per group after inlining (default 1024, at most 16384). */
  pegNodes?: number; arrayPositions?: number; regexpPositions?: number; width?: number;
  poolBytes?: number; totalBytes?: number; compileBudget?: number; leaves?: number;
  depth?: number; inputBytes?: number; entries?: number; items?: number;
  bignumBytes?: number; budget?: number;
}
export interface CompileOptions {
  /** XSD Appendix F (default), or strict RFC 9485 interoperability mode. */
  regexp?: 'xsd' | 'iregexp';
  /** Cut semantics: `rfc` (the literal RFC 8610 cut, default) or `branch` (rule A: a failed cut fails only its `//` branch). See the guide's "Discriminated unions under the RFC cut". */
  cuts?: 'rfc' | 'branch';
  /** The PEG group arena cap in words (default 4,194,304; at most 2^24). */
  groupWords?: number;
  profile?: 'full' | 'bindle' | 'bus'; limits?: CompileLimits; unicode?: Int32Array;
  /** Extension controls the schema may use as `.name`; see @3sln/snug/controls. */
  controls?: Controls;
  /** Admit extension controls under the `bus` profile (refused there by default). */
  controlsInBus?: boolean;
  /** `.abnf`/`.abnfb` controllers (@3sln/snug/abnf): 'strict' (default) parses RFC 5234 + RFC 7405
   *  as RFC 9165 §3 frames them; 'lenient' also admits snug's non-RFC forms. Bound
   *  into the source key. */
  abnf?: 'strict' | 'lenient';
}
export type SchemaErrorCode = 'syntax' | 'undefined_name' | 'duplicate_rule' | 'type_group_mismatch' |
  'generic_arity' | 'nonproductive' | 'group_recursion' | 'unwrap' | 'enum' | 'range' |
  'float_literal' | 'control_target' | 'control_value' | 'unsupported_control' |
  'unknown_control' | 'regexp' | 'map_key' |
  'tag' | 'major' | 'profile' | 'empty_schema' | 'internal' | 'control_registry' |
  'limit_schema_bytes' | 'limit_nesting' | 'limit_ast_nodes' | 'limit_instantiations' |
  'limit_peg_nodes' | 'limit_array_positions' | 'limit_regexp_positions' | 'limit_width' |
  'limit_pool_bytes' | 'limit_total_bytes' | 'limit_compile_budget' | 'limit_leaves' | 'limit_memory';
export declare class SchemaError extends Error {
  constructor(code: SchemaErrorCode, line?: number, column?: number, rule?: string);
  code: SchemaErrorCode; line: number; column: number; rule: string | undefined;
}
/** First call lazily imports the compiler; compilation then runs synchronously. */
export declare function compile(text: string | Uint8Array, options?: CompileOptions): Promise<Schema>;
