/** Profile failures never include payload data. */
export class SnugFault extends Error {
  constructor(code = 'malformed', message = 'The CBOR data is not valid under the selected profile.') {
    super(message); this.name = 'SnugFault'; this.code = code;
  }
}
export const fail = (code, message) => { throw new SnugFault(code, message); };
