// An RFC 8742 (CBOR Sequences) framer, written from the RFC text alone:
// RFC 8742 §2 (a sequence is zero or more concatenated, well-formed CBOR data
// items) and RFC 8949 §3, §3.2, §3.3 and Appendix C (the well-formedness
// pseudocode) / Appendix F (the three kinds of well-formedness error).
//
// It is an independent oracle for snug's sequence reader (P9.5): it imports
// nothing from snug and shares no code with snug's scanner, session or
// sequence modules. It only FRAMES: it finds where each well-formed data item
// ends. It checks nothing about validity (UTF-8, duplicate keys, tag
// semantics) or determinism (shortest heads, key order), and has no limits
// (depth, size, item counts) beyond the length of the input.
//
// Result of framing one item at `offset` (frameItem):
//   { kind: 'ok', end }                 a well-formed item spans [offset, end)
//   { kind: 'truncated', at }           too little data (Appendix F kind 2): the
//                                       input ends inside the item; `at` is the
//                                       head of the innermost item being read
//                                       (the input length when an item was
//                                       expected and no byte was left)
//   { kind: 'malformed', at, why }      a syntax error (Appendix F kind 3) in the
//                                       head at `at`; `why` one of
//       'reserved-ai'      additional information 28, 29 or 30 (§3)
//       'bad-simple'       0xf8 followed by a byte < 0x20 (§3.3)
//       'indefinite-mt'    additional information 31 on major type 0, 1 or 6 (§3)
//       'chunk'            a chunk of an indefinite-length string that is not a
//                          definite-length string of the same major type (§3.2.3)
//       'break'            a "break" where no indefinite-length item can end (§3.2.1)
//       'break-as-value'   a "break" in place of a map value (§3.2.2)
//
// Appendix C checks a chunk's type only after reading the whole chunk, so an
// indefinite chunk cut short reads there as too little data; here a chunk is
// refused at its initial byte instead, because Appendix F defines a syntax
// error as one that "cannot be remedied by adding data at the end" -- and no
// added data can make that chunk acceptable. Everything else follows the
// pseudocode's order. Nesting is handled with an explicit stack, so input
// nested millions deep cannot exhaust the call stack.
//
// Optional detail (`info`, for a caller comparing against a decoder that
// reports offsets differently):
//   info.strings  receives [start, end) for the content of every definite-length
//                 byte string read (chunks of indefinite ones included);
//   info.open     on a stop, the items that were still open, outermost first, as
//                 { head, min }: `head` the offset of its initial byte, `min` a
//                 lower bound on where it can end given what was read (for a
//                 definite array or map, the next item's offset plus one byte
//                 for each item still due; for a tag or an indefinite item, one
//                 more byte; for a string or head cut short, the end its head
//                 claims). A truncation ends with the cut item itself; a
//                 syntax error does not list the refused head.

const BREAK = 0xff;

/** Frame the data item starting at `offset` in `bytes` (a Uint8Array). */
export function frameItem(bytes, offset, info = null) {
  const n = bytes.length;
  let p = offset;
  // Open items, innermost last, each with its head offset h:
  //   { k: 'count', left }           definite array/map: data items still due
  //   { k: 'array' }                 indefinite array: items until a break
  //   { k: 'map', value }            indefinite map: value = a key was read
  //   { k: 'string', mt }            indefinite string: chunks until a break
  //   { k: 'tag' }                   a tag: its one content item is due
  const stack = [];
  // a stop at the head h; `claim` (truncations) where the cut item's own head says it ends
  const stop = (r, h, claim) => {
    if (info) {
      info.open = stack.map(f => ({ head: f.h, min: h + (f.k === 'count' ? f.left : 1) }));
      if (claim !== undefined) info.open.push({ head: h, min: claim });
    }
    return r;
  };
  for (;;) {
    // ---- one head, at p (an item is expected here) ----
    const top = stack.length ? stack[stack.length - 1] : null;
    const h = p;
    if (p >= n) return stop({ kind: 'truncated', at: n }, n, n + 1);
    const ib = bytes[p++];
    const mt = ib >> 5, ai = ib & 0x1f;
    if (ai >= 28 && ai <= 30) return stop({ kind: 'malformed', at: h, why: 'reserved-ai' }, h);
    if (top && top.k === 'string') {
      // inside an indefinite-length string: a break, or a definite chunk of the same major type
      if (ib === BREAK) { stack.pop(); p = finished(stack, p); if (!stack.length) return { kind: 'ok', end: p }; continue; }
      if (mt !== top.mt || ai === 31) return stop({ kind: 'malformed', at: h, why: 'chunk' }, h);
    }
    if (ai === 31) {
      if (mt === 7) {
        // the "break" stop code: it ends the innermost indefinite array or map, if that is
        // where an item could stand; anywhere else the enclosing item is not well-formed
        if (top && top.k === 'array') { stack.pop(); p = finished(stack, p); if (!stack.length) return { kind: 'ok', end: p }; continue; }
        if (top && top.k === 'map') {
          if (top.value) return stop({ kind: 'malformed', at: h, why: 'break-as-value' }, h);
          stack.pop(); p = finished(stack, p); if (!stack.length) return { kind: 'ok', end: p }; continue;
        }
        return stop({ kind: 'malformed', at: h, why: 'break' }, h);
      }
      if (mt === 0 || mt === 1 || mt === 6) return stop({ kind: 'malformed', at: h, why: 'indefinite-mt' }, h);
      // major types 2..5 with an indefinite length
      stack.push(mt === 2 || mt === 3 ? { k: 'string', mt, h } : mt === 4 ? { k: 'array', h } : { k: 'map', value: false, h });
      continue;
    }
    // the argument: ai itself, or the 1, 2, 4 or 8 bytes that follow
    let val = ai;
    if (ai >= 24) {
      const len = 1 << (ai - 24);
      if (n - p < len) return stop({ kind: 'truncated', at: h }, h, p + len);
      val = 0;
      for (let i = 0; i < len; i++) val = val * 256 + bytes[p++];   // exact up to 2^53; above it only "more than any input"
    }
    switch (mt) {
      case 0: case 1: break;                                          // integers: no content
      case 2: case 3:                                                 // strings: val bytes of content
        if (n - p < val) return stop({ kind: 'truncated', at: h }, h, p + val);
        if (info && info.strings && mt === 2) info.strings.push([p, p + val]);
        p += val;
        break;
      case 4: if (val > 0) { stack.push({ k: 'count', left: val, h }); continue; } break;
      case 5: if (val > 0) { stack.push({ k: 'count', left: 2 * val, h }); continue; } break;
      case 6: stack.push({ k: 'tag', h }); continue;                  // one enclosed item follows
      case 7: if (ai === 24 && val < 32) return stop({ kind: 'malformed', at: h, why: 'bad-simple' }, h); break;
    }
    // a complete item ends at p: account for it in the containers that hold it
    p = finished(stack, p);
    if (!stack.length) return { kind: 'ok', end: p };
  }
}

// A data item (or a break-ended indefinite item) has just been completed at p:
// pop every container it completes. Answers p.
function finished(stack, p) {
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.k === 'count') { if (--top.left > 0) return p; stack.pop(); continue; }
    if (top.k === 'tag') { stack.pop(); continue; }
    if (top.k === 'map') { top.value = !top.value; return p; }
    return p;   // an indefinite array or string: more items or chunks follow until its break
  }
  return p;
}

/** Frame a whole CBOR sequence (RFC 8742): every well-formed item from `offset`
 *  on, and where framing stops.
 *  Answers { items: [[offset, end], ...], stop } with stop one of
 *    { kind: 'end', offset }                      the input ended at an item boundary
 *    { kind: 'truncated', offset, at }            the item at `offset` is cut short
 *    { kind: 'malformed', offset, at, why }       the item at `offset` is not well-formed */
export function frameSequence(bytes, offset = 0) {
  const items = [];
  let o = offset;
  for (;;) {
    if (o >= bytes.length) return { items, stop: { kind: 'end', offset: o } };
    const r = frameItem(bytes, o);
    if (r.kind !== 'ok') return { items, stop: { offset: o, ...r } };
    items.push([o, r.end]);
    o = r.end;
  }
}
