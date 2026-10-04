/**
 * Fallback parsing of inline "thinking" markup.
 *
 * The generation engine relies on llama.rn's native reasoning separation
 * (`reasoning_format: 'auto'` + `enable_thinking`, see generationEngine.ts):
 * for Qwen3.5 and Gemma 4 the native chat parser returns `reasoning_content`
 * and `content` separately, so reasoning never reaches `content`.
 *
 * This module only handles text that still carries markup inline:
 *  - assistant messages stored by older app versions (raw `</think>` or
 *    `<|channel>…<channel|>` inside `content`), normalised on load;
 *  - models whose chat template can't be parsed natively (non-jinja fallback).
 *
 * It is the single place for tag parsing; both the engine and the UI use it.
 */

const QWEN_OPEN = '<think>';
const QWEN_CLOSE = '</think>';
const GEMMA_OPEN = '<|channel>';
const GEMMA_CLOSE = '<channel|>';
// Gemma 4 opens its thought channel with `<|channel>thought\n`.
const GEMMA_THOUGHT_LABEL = /^thought[ \t]*\n?/;

export interface ThinkingSplit {
  /** Thinking text (markup removed). */
  reasoning: string;
  /** Visible answer text (markup removed). */
  content: string;
  /** A thinking block was opened but not closed yet (still thinking / cut off mid-thought). */
  isThinking: boolean;
}

export function hasThinkingMarkup(text: string): boolean {
  return (
    text.includes(QWEN_CLOSE) ||
    text.includes(QWEN_OPEN) ||
    text.includes(GEMMA_OPEN) ||
    text.includes(GEMMA_CLOSE)
  );
}

/**
 * Splits raw model output into reasoning and visible content.
 *
 * Supported formats:
 *  - Qwen:  `[<think>]reasoning</think>answer` (the opening tag usually lives in
 *           the prompt, so it is optional)
 *  - Gemma: `<|channel>thought\nreasoning<channel|>answer`
 *
 * @param openAtStart treat untagged text as reasoning (the prompt ended inside
 *        an open thinking block, e.g. Qwen's forced-open `<think>\n`).
 */
export function splitThinking(text: string, { openAtStart = false }: { openAtStart?: boolean } = {}): ThinkingSplit {
  const gemmaStart = text.indexOf(GEMMA_OPEN);
  if (gemmaStart !== -1) {
    const before = text.slice(0, gemmaStart);
    const after = text.slice(gemmaStart + GEMMA_OPEN.length);
    const gemmaEnd = after.indexOf(GEMMA_CLOSE);
    if (gemmaEnd === -1) {
      return { reasoning: after.replace(GEMMA_THOUGHT_LABEL, '').trim(), content: before.trim(), isThinking: true };
    }
    return {
      reasoning: after.slice(0, gemmaEnd).replace(GEMMA_THOUGHT_LABEL, '').trim(),
      content: (before + after.slice(gemmaEnd + GEMMA_CLOSE.length)).trim(),
      isThinking: false,
    };
  }

  const qwenEnd = text.indexOf(QWEN_CLOSE);
  if (qwenEnd !== -1) {
    let head = text.slice(0, qwenEnd);
    let prefix = '';
    const openIdx = head.indexOf(QWEN_OPEN);
    if (openIdx !== -1) {
      prefix = head.slice(0, openIdx);
      head = head.slice(openIdx + QWEN_OPEN.length);
    }
    return {
      reasoning: head.trim(),
      content: (prefix + text.slice(qwenEnd + QWEN_CLOSE.length)).trim(),
      isThinking: false,
    };
  }

  const qwenOpen = text.indexOf(QWEN_OPEN);
  if (qwenOpen !== -1) {
    return {
      reasoning: text.slice(qwenOpen + QWEN_OPEN.length).trim(),
      content: text.slice(0, qwenOpen).trim(),
      isThinking: true,
    };
  }

  if (openAtStart) return { reasoning: text.trim(), content: '', isThinking: true };
  return { reasoning: '', content: text, isThinking: false };
}

/**
 * Normalises an assistant message's text fields: if `reasoning` is empty and
 * `content` still carries inline markup, move the thinking into `reasoning`.
 * Messages that already have separated reasoning are returned unchanged.
 */
export function normalizeReasoning(
  content: string,
  reasoning: string,
  opts?: { openAtStart?: boolean },
): { content: string; reasoning: string; isThinking: boolean } {
  if (reasoning || !(hasThinkingMarkup(content) || opts?.openAtStart)) {
    return { content, reasoning, isThinking: false };
  }
  return splitThinking(content, opts);
}

/**
 * Legacy shape used by the current chat screen. Content coming from the engine
 * no longer carries markup, so untagged text is always treated as visible.
 */
export function parseThinking(content: string, isStreaming: boolean) {
  const split = splitThinking(content);
  const stillThinking = isStreaming && split.isThinking;
  return {
    completedBlocks: !stillThinking && split.reasoning ? [split.reasoning] : ([] as string[]),
    isThinking: stillThinking,
    thinkingText: stillThinking ? split.reasoning : '',
    visible: split.content,
  };
}
