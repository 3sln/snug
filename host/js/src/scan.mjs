import { SnugFault } from './fault.mjs';

// Temporary seam: the generated scanner's export and verdict ABI are not frozen.
// Import once; do not hide syntax/linkage failures in a present generated module.
let generated;
try { generated = await import('../../../gen/js/snug/cbor/scan.mjs'); }
catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' ||
      error.url !== new URL('../../../gen/js/snug/cbor/scan.mjs', import.meta.url).href) throw error;
}

export function scan(bytes, options = {}) {
  if (typeof generated?.scan !== 'function') throw new SnugFault('unavailable');
  // Provisional ABI: null/undefined success; a code string or {code} failure.
  // Unknown verdict shapes stay unavailable until the generated ABI is wired.
  const result = generated.scan(bytes, options);
  if (result === null || result === undefined) return;
  if (typeof result === 'string') throw new SnugFault(result);
  if (typeof result?.code === 'string') throw new SnugFault(result.code);
  throw new SnugFault('unavailable');
}
