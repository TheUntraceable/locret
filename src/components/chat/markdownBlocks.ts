/**
 * Splits markdown into top-level blocks so each can be rendered (and memoised)
 * on its own.
 *
 * A block ends at a blank line outside a code fence whose next non-blank line
 * starts at column 0. Indented follow-ups (list continuations, nested lists,
 * code inside list items) stay in the same block, so the split renders like
 * the whole document.
 *
 * Streaming only appends text and a boundary depends only on the lines up to
 * the first character after it, so once a block is settled its string never
 * changes: a memo'd renderer parses it once instead of on every ~80 ms flush.
 * Only the `tail` (the block still being written, possibly an unterminated
 * code fence) is re-parsed as tokens arrive.
 */
export interface MarkdownBlocks {
  /** Complete blocks, each ending with its blank-line separator. */
  settled: string[];
  /** Text after the last boundary (may be empty or contain an open fence). */
  tail: string;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

export function splitMarkdownBlocks(text: string): MarkdownBlocks {
  const settled: string[] = [];
  let blockStart = 0;
  let blockHasContent = false;
  /** Start of the line after a blank line that may end the current block. */
  let pendingBoundary = -1;
  let fenceChar = '';
  let fenceLen = 0;
  let lineStart = 0;

  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart);
    const complete = nl !== -1;
    const lineEnd = complete ? nl : text.length;
    const line = text.slice(lineStart, lineEnd);
    const next = complete ? nl + 1 : text.length;

    if (fenceChar) {
      if (complete) {
        const close = FENCE_CLOSE_RE.exec(line);
        if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) fenceChar = '';
      }
    } else if (line.trim() === '') {
      // A blank line; the incomplete last line can't be judged yet.
      if (complete && blockHasContent && pendingBoundary === -1) pendingBoundary = next;
    } else {
      if (pendingBoundary !== -1) {
        // Only a block starting at column 0 is a new top-level block.
        if (line[0] !== ' ' && line[0] !== '\t') {
          settled.push(text.slice(blockStart, pendingBoundary));
          blockStart = pendingBoundary;
        }
        pendingBoundary = -1;
      }
      blockHasContent = true;
      // An opening fence is only trusted once its line is complete.
      const open = complete ? FENCE_RE.exec(line) : null;
      if (open) {
        fenceChar = open[1][0];
        fenceLen = open[1].length;
      }
    }
    lineStart = next;
  }

  return { settled, tail: text.slice(blockStart) };
}
