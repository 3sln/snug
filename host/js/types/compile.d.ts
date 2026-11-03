import type { Schema } from './schema.js';
export interface CompileLimits {
  schemaBytes?: number; nesting?: number; astNodes?: number; instantiations?: number;
  alternatives?: number; arrayPositions?: number; regexpPositions?: number; width?: number;
  poolBytes?: number; totalBytes?: number; compileBudget?: number; leaves?: number;
  depth?: number; inputBytes?: number; entries?: number; items?: number;
  bignumBytes?: number; budget?: number;
}
export interface CompileOptions { profile?: 'full' | 'bindle' | 'bus'; limits?: CompileLimits; unicode?: Int32Array }
export type SchemaErrorCode = 'syntax' | 'undefined_name' | 'duplicate_rule' | 'type_group_mismatch' |
  'generic_arity' | 'nonproductive' | 'group_recursion' | 'unwrap' | 'enum' | 'range' |
  'float_literal' | 'control_target' | 'control_value' | 'unsupported_control' |
  'unknown_control' | 'regexp' | 'map_key' | 'map_group_occurrence' | 'map_cut' |
  'map_overlap' | 'tag' | 'major' | 'profile' | 'empty_schema' | 'internal' |
  'limit_schema_bytes' | 'limit_nesting' | 'limit_ast_nodes' | 'limit_instantiations' |
  'limit_alternatives' | 'limit_array_positions' | 'limit_regexp_positions' | 'limit_width' |
  'limit_pool_bytes' | 'limit_total_bytes' | 'limit_compile_budget' | 'limit_leaves' | 'limit_memory';
export declare class SchemaError extends Error {
  constructor(code: SchemaErrorCode, line?: number, column?: number, rule?: string);
  code: SchemaErrorCode; line: number; column: number; rule: string | undefined;
}
/** First call lazily imports the compiler; compilation then runs synchronously. */
export declare function compile(text: string | Uint8Array, options?: CompileOptions): Promise<Schema>;
