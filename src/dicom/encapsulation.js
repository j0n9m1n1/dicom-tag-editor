/** Resolve Basic Offset Table entries to fragment indexes (PS3.5 A.4). */
export function basicOffsetFrameStarts(table, fragments, frameCount) {
  if (!table?.length) return null;
  if (table.length % 4 !== 0 || table.length / 4 !== frameCount) {
    throw new Error('Basic Offset Table must contain one offset per frame.');
  }
  const entries = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const starts = [];
  let fragment = 0;
  let offset = 0;
  for (let i = 0; i < frameCount; i++) {
    const target = entries.getUint32(i * 4, true);
    if ((i === 0 && target !== 0) || (i > 0 && target <= entries.getUint32((i - 1) * 4, true))) {
      throw new Error('Basic Offset Table must start at zero with strictly increasing offsets.');
    }
    while (fragment < fragments.length && offset < target) {
      offset += 8 + fragments[fragment++].length;
    }
    if (fragment === fragments.length || offset !== target) {
      throw new Error('Basic Offset Table offset does not point to a fragment Item tag.');
    }
    starts.push(fragment);
  }
  return starts;
}
