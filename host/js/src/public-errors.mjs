import { SnugFault } from './fault.mjs';

/** Preserve the VM's safe witness, while sharing the codec's fault class. */
export function validationFault(result) {
  const code = result.reason.startsWith('cbor/') ? result.reason.slice(5) : `schema/${result.reason}`;
  const error = new SnugFault(code, `snug: ${result.reason}`);
  error.reason = result.reason;
  error.path = result.path;
  error.offset = result.offset;
  if (result.subcode) error.subcode = result.subcode;
  return error;
}
