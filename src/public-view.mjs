import { view as open } from './view.mjs';
import { validationFault } from './public-errors.mjs';
export { View, Cursor } from './view.mjs';
export function view(bytes, options = {}) {
  try { return open(bytes, options); }
  catch (e) { if (e.reason) throw validationFault(e); throw e; }
}
