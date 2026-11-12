// Test-only oracles that the oldest supported Node lacks (P9.18, D344). Library
// code never needs them. Under SNUG_NODE_OLDEST=1 (set only by `bb gates
// node-oldest`) a missing oracle is a logged note and that comparison is left
// out; anywhere else it fails the test, so the main npm-test gate keeps every
// comparison. Returns undefined, or throws.
import assert from 'node:assert/strict';

export function oracleMissing(t, what, consequence) {
  assert.equal(process.env.SNUG_NODE_OLDEST, '1', `Node ${process.version} lacks ${what}, a test oracle; run npm test on a newer Node (only the node-oldest gate may run without it)`);
  t.diagnostic(`note: Node ${process.version} lacks ${what}; ${consequence} (node-oldest gate)`);
  return undefined;
}
