// P9.5: the independent RFC 8742 framer (corpus/tools/rfc8742-framer.mjs) as a
// second oracle for bb sequence-test. D211's oracle lines (which the gate
// already holds equal to the kin session, the Rust build and the JS and Rust
// hosts) must agree with the framer wherever their meanings overlap; where
// they differ by design, the case is named below and counted, never skipped.
//
// Per message line of D211's oracle, for a message at absolute offset o with
// P = maxMessageBytes (the session's provisional end), R = |S| - o, the
// window end w = o + min(R, P), and F = the framer's answer for the item at o
// (with the items still open where it stopped, each with a lower bound `min`
// on where it can end):
//
//   m / s <len>   accepted / skipped: F is a well-formed item of exactly len
//                 bytes, and o is where the previous message ended.
//   end <o>       o = |S|: the framer also ends at a boundary there.
//   x truncated   R <= P, and either F is truncated and snug's offset e is the
//                 head of one of the items the framer had open (snug names the
//                 OUTERMOST item whose length or count claim runs past the
//                 input, the framer the innermost cut item: equal offsets are
//                 counted apart), or F is malformed at a later head but an
//                 item open there, at e, already claims more bytes than the
//                 input has (min > |S|): §18.1 answers a refusal only once no
//                 earlier length claim is open, so an unsatisfiable claim
//                 outranks a later syntax error. Or F is well-formed within w
//                 and e lies in one of its byte strings (embedded CBOR: tag 24,
//                 .cbor / .cborseq; a payload of its own the framer does not
//                 open).
//   x malformed   F is malformed at the same head; or inside a byte string.
//   x too_large   R > P, and F gives no well-formed item within w: it is longer
//                 than P; or truncated; or malformed in a head whose refusal
//                 needs a byte past w (f8 17 with w after the f8); or malformed
//                 before w under an open claim reaching past w (as for
//                 truncated); or (§18.1 case 3) F fits within w and holds a byte
//                 string, whose embedded payload was cut short.
//   x <any other> a validity, determinism, limit, schema or budget refusal:
//                 the offset e is within w and no later than where the framer
//                 stops (F's end; the head it calls malformed or truncated --
//                 the same head may be refused for another reason first, e.g.
//                 `indefinite` for 1f, `simple` for f8 1f, `not_map` at o).
//                 Schema reasons in a stopping line come from complete
//                 messages: F is well-formed within w. `indefinite` is at a
//                 head whose additional information is 31; `not_map` at o;
//                 `trailing` (a root's end is a boundary) only in a byte string.
// After a stop, the framer may read further items of S: snug ends the
// sequence at its first refusal (D214), so they have nothing to compare with;
// they are counted, not checked.
import { frameItem, frameSequence } from '../../corpus/tools/rfc8742-framer.mjs';

const TRUNCATED = 1, INDEFINITE = 3, MALFORMED = 4, SIMPLE = 10, TRAILING = 16, TOO_LARGE = 20, NOT_MAP = 21;
const NAMES = { 1: 'truncated', 2: 'non_shortest', 3: 'indefinite', 4: 'malformed', 5: 'key_type', 6: 'key_order', 7: 'duplicate_key',
  8: 'text', 9: 'float', 10: 'simple', 11: 'tag', 12: 'bignum', 13: 'decimal', 14: 'typed_array', 15: 'ndarray', 16: 'trailing',
  17: 'depth', 18: 'too_many_entries', 19: 'too_many_items', 20: 'too_large', 21: 'not_map', 44: 'group_limit', 48: 'budget' };
const nameOf = c => (c >= 32 && c <= 43 ? 'schema' : NAMES[c] ?? `code ${c}`);
export const PAST_STOP = '#items the framer reads past a stop';

/** Is e the head of an item open at the framer's stop whose claim -- its own or an item's
 *  open inside it -- runs past `limit`? */
function openClaim(open, e, limit) {
  const i = open.findIndex(f => f.head === e);
  return i >= 0 && open.slice(i).some(f => f.min > limit);
}

/** Check D211's oracle lines for S (P = maxMessageBytes) against the framer. Adds each line's
 *  class to `tally` (a Map class -> count). Answers null, or a description of the disagreement. */
export function framerCheck(S, P, lines, tally) {
  const n = S.length;
  const count = (k, by = 1) => tally.set(k, (tally.get(k) ?? 0) + by);
  let next = 0;   // where the next message must start
  for (const line of lines) {
    const f = line.split(' ');
    if (f[0] === 'end') {
      const o = Number(f[1]);
      if (o !== next || o !== n) return `end at ${o}, but the framer's last item ended at ${next} of ${n}`;
      count('end: the framer ends at the same boundary');
      continue;
    }
    const o = Number(f[2]);
    if (o !== next) return `message ${f[1]} at ${o}, but the previous one ended at ${next}`;
    if (f[0] === 'm' || f[0] === 's') {
      const len = Number(f[3]), F = frameItem(S, o);
      if (F.kind !== 'ok' || F.end !== o + len) return `message ${f[1]} at ${o} ${f[0] === 'm' ? 'accepted' : 'skipped'} with length ${len}, framer ${JSON.stringify(F)}`;
      count(f[0] === 'm' ? 'accepted: same item' : 'skipped (schema): same item');
      next = o + len;
      continue;
    }
    // x: the sequence stops at message f[1]
    const code = Number(f[3]), e = Number(f[5]);
    const R = n - o, w = o + Math.min(R, P);
    const info = { strings: [] };
    const F = frameItem(S, o, info);
    const open = info.open ?? [];
    const fits = F.kind === 'ok' && F.end <= w;
    // an embedded payload's offsets run to its string's end (a truncation there is at the end)
    const inBytes = info.strings.some(([a, b]) => e >= a && e <= b);
    const why = `${nameOf(code)} at ${e} (message ${f[1]} at ${o}, P ${P}, |S| ${n}), framer ${JSON.stringify(F)} open ${JSON.stringify(open)}`;
    let cls = null;
    if (code === TOO_LARGE) {
      if (R <= P) return `too_large with only ${R} bytes left: ${why}`;
      if (F.kind === 'ok' && F.end > w) cls = 'too_large: the item is longer than P';
      else if (F.kind === 'truncated') cls = 'too_large: the item is cut short past P';
      // a syntax error shows in its initial byte, except f8 <32: there the byte after it
      else if (F.kind === 'malformed' && F.at + (F.why === 'bad-simple' ? 2 : 1) > w) cls = 'too_large: malformed only past P';
      else if (F.kind === 'malformed' && open.some(x => x.min > w)) cls = 'too_large: a claim runs past P before a syntax error';
      else if (fits && info.strings.length) cls = 'too_large: fits in P, embedded payload cut short (§18.1 case 3)';
    } else if (code === TRUNCATED) {
      if (R > P) return `truncated with more than P bytes left: ${why}`;
      if (F.kind === 'truncated' && e === F.at) cls = 'truncated: same head';
      else if (F.kind === 'truncated' && openClaim(open, e, n)) cls = 'truncated: an enclosing item whose claim runs past the input';
      else if (F.kind === 'malformed' && openClaim(open, e, n)) cls = 'truncated: a claim runs past the input before a syntax error (§18.1)';
      else if (fits && inBytes) cls = 'truncated: inside a byte string (embedded)';
    } else if (code === MALFORMED) {
      if (F.kind === 'malformed' && F.at === e) cls = `malformed: same head (${F.why})`;
      else if (fits && inBytes) cls = 'malformed: inside a byte string (embedded)';
    } else {
      const stop = F.kind === 'ok' ? F.end : F.at;
      const name = nameOf(code);
      if (e > w || e > stop) return `refused past where the framer stops: ${why}`;
      if (name === 'schema' && !fits) return `a schema refusal of an incomplete message: ${why}`;
      if (code === NOT_MAP && e !== o) return `not_map away from the root: ${why}`;
      if (code === TRAILING && !inBytes) return `trailing outside a byte string: ${why}`;
      if (code === INDEFINITE && !inBytes && (S[e] & 0x1f) !== 31) return `indefinite at a head without additional information 31: ${why}`;
      if (code === SIMPLE && F.kind === 'malformed' && F.at === e && F.why !== 'bad-simple') return `simple at a head the framer refuses as ${F.why}: ${why}`;
      cls = inBytes ? `${name}: inside a byte string (embedded)`
        : F.kind === 'ok' ? `${name}: a well-formed item`
        : e === F.at ? `${name}: at the head the framer calls ${F.kind}${F.why ? ` (${F.why})` : ''}`
        : `${name}: before the framer's ${F.kind} head`;
    }
    if (!cls) return why;
    count(cls);
    // the items the framer can still read past the stop (nothing to compare them with)
    if (F.kind === 'ok') count(PAST_STOP, frameSequence(S, F.end).items.length);
    return null;
  }
  return null;
}
