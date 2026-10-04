import type {
  CompletionParams,
  FormattedChatResult,
  JinjaFormattedChatResult,
  LlamaContext,
  NativeCompletionResult,
  RNLlamaOAICompatibleMessage,
  TokenData,
} from 'llama.rn';
import type { ChatMessage, FinishReason } from '../types';
import { normalizeReasoning } from './thinking';

/**
 * Pure generation helpers on top of llama.rn (no React, no storage).
 *
 * How thinking works (verified against llama.rn 0.12.0-rc.6 sources):
 *  - `enable_thinking` is passed into the jinja context of the chat template
 *    (cpp/common/chat.cpp `common_chat_template_direct_apply_impl`). Qwen3.5's
 *    template emits an empty `<think>\n\n</think>` when it is false, and Gemma 4's
 *    template only adds its `<|think|>` system marker when it is true. The
 *    `/think` `/no_think` soft prompts are therefore unnecessary and not used.
 *  - With `reasoning_format !== 'none'` the native PEG chat parser (autoparser
 *    for Qwen, a dedicated parser for Gemma 4) separates thinking into
 *    `reasoning_content`; `content` never contains it. Token callbacks carry the
 *    accumulated parsed `content` / `reasoning_content` (not deltas).
 *  - `chat_template_kwargs` values must be JSON-encodable non-strings: a string
 *    'false' becomes the truthy jinja string "false". We don't use it.
 *
 * Continuation ("assistant prefill"): llama.rn has no continue-final-message
 * option, so we format the history ourselves with `getFormattedChat`, append
 * the partial assistant text to the prompt, and pass the parser metadata
 * through to `completion({ prompt })`. `prefill_text` is the appended text: the
 * native parser parses `generation_prompt + prefill_text + generated_text`
 * (rn-completion.cpp `parseChatOutput`, chat.cpp `common_chat_peg_parse`), so
 * the parsed output covers the whole message, old text included.
 */

export const SYSTEM_PROMPT =
  'You are the helpful AI Assistant, R.AI. You help users with whatever it is that they need. You are free to use whatever language you want to, do NOT force anything.';

/** Tokens kept free between prompt + n_predict and the end of the context window. */
export const CONTEXT_SAFETY_MARGIN = 64;
/** Below this many tokens of room for the reply, refuse instead of producing a stub. */
export const MIN_PREDICT_TOKENS = 128;
/** Rough per-turn cost of role markers, used only to estimate how many turns to drop. */
const PER_TURN_OVERHEAD_TOKENS = 8;
const TEMPERATURE = 0.7;

/**
 * Extra stop strings for templates that don't declare their own end-of-turn
 * stops. Only special-token spellings: plain words like "user:" would cut
 * legitimate replies short.
 */
const STOP_STRINGS = [
  '</s>',
  '<|end|>',
  '<|eot_id|>',
  '<|end_of_text|>',
  '<|im_end|>',
  '<|EOT|>',
  '<|END_OF_TURN_TOKEN|>',
  '<|end_of_turn|>',
  '<|endoftext|>',
  '<end_of_turn>',
  '<turn|>',
];

/** Gemma 4 opens its reasoning channel with this literal (chat.cpp `common_chat_params_init_gemma4`). */
const GEMMA4_THOUGHT_OPEN = '<|channel>thought\n';

/** A user-facing error (message is safe to show as-is). */
export class GenerationError extends Error {}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PartialAssistant {
  content: string;
  reasoning: string;
}

/**
 * How a continuation resumes:
 *  - 'fresh'     no usable partial: generate the whole turn
 *  - 'content'   resume the visible answer (thinking is formatted off)
 *  - 'reasoning' resume an unfinished thinking block
 */
export type ResumeMode = 'fresh' | 'content' | 'reasoning';

export interface PreparedPrompt {
  params: CompletionParams;
  promptTokens: number;
  nPredict: number;
  nCtx: number;
  /** Oldest history turns dropped to fit the context window. */
  trimmedTurns: number;
  mode: ResumeMode;
  /** True when llama.rn's native chat parser separates reasoning for this model. */
  nativeReasoning: boolean;
  /** Prompt ends inside an open thinking block (only used by the markup fallback). */
  openAtStart: boolean;
  /** Text appended after the formatted prompt (the part of the message being resumed). */
  prefill: string;
  partial: PartialAssistant | null;
}

export interface StreamSnapshot {
  content: string;
  reasoning: string;
  /** The most recent tokens went to the reasoning channel. */
  isReasoning: boolean;
  tokens: number;
}

export interface CompletionOutcome {
  content: string;
  reasoning: string;
  result: NativeCompletionResult | null;
  error: unknown;
  /** True when shouldAbort() was already set before the completion started. */
  skipped: boolean;
  predictedTokens: number;
  tokensPerSecond: number;
  durationMs: number;
}

/**
 * Converts stored messages into prompt turns: assistant turns send only their
 * visible content (reasoning is never fed back), empty assistant turns are
 * skipped, and consecutive same-role turns are merged so templates that
 * require strict user/assistant alternation (e.g. Gemma) never reject the
 * history (interrupt-with-new-message produces user,user sequences).
 */
export function toHistoryTurns(messages: ChatMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const m of messages) {
    const content = m.content;
    if (!content.trim()) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      turns.push({ role: m.role, content });
    }
  }
  return turns;
}

function toMessages(systemPrompt: string, turns: HistoryTurn[]): RNLlamaOAICompatibleMessage[] {
  return [{ role: 'system', content: systemPrompt }, ...turns.map((t) => ({ role: t.role, content: t.content }))];
}

function isJinja(f: FormattedChatResult | JinjaFormattedChatResult): f is JinjaFormattedChatResult {
  return f.type === 'jinja';
}

function promptEndsInsideThinking(f: JinjaFormattedChatResult): boolean {
  if (f.thinking_forced_open) return true;
  const tag = (f.thinking_start_tag ?? '<think>').trim();
  return !!tag && (f.generation_prompt ?? '').trimEnd().endsWith(tag);
}

/** Text that opens a thinking block after the generation prompt, or null if unknown. */
function reasoningOpener(f: FormattedChatResult | JinjaFormattedChatResult): string | null {
  if (!isJinja(f)) return null;
  if (promptEndsInsideThinking(f)) return '';
  if (f.thinking_start_tag) return f.thinking_start_tag.endsWith('\n') ? f.thinking_start_tag : `${f.thinking_start_tag}\n`;
  if (f.preserved_tokens?.includes('<|channel>') || (f.generation_prompt ?? '').includes('<|turn>')) {
    return GEMMA4_THOUGHT_OPEN;
  }
  return null;
}

interface Assembled {
  prompt: string;
  prefill: string;
  openAtStart: boolean;
}

function assemble(
  f: FormattedChatResult | JinjaFormattedChatResult,
  mode: ResumeMode,
  partial: PartialAssistant | null,
): Assembled | null {
  if (mode === 'content' && partial) {
    return { prompt: f.prompt + partial.content, prefill: partial.content, openAtStart: false };
  }
  if (mode === 'reasoning' && partial) {
    const opener = reasoningOpener(f);
    if (opener === null) return null;
    const text = opener + partial.reasoning;
    return { prompt: f.prompt + text, prefill: text, openAtStart: true };
  }
  return { prompt: f.prompt, prefill: '', openAtStart: isJinja(f) && promptEndsInsideThinking(f) };
}

/** Index of the first turn to keep so the kept history starts with a user turn. */
function alignToUser(turns: HistoryTurn[], start: number): number {
  let i = Math.min(start, turns.length - 1);
  while (i < turns.length - 1 && turns[i].role !== 'user') i++;
  return Math.max(0, i);
}

/**
 * Formats the conversation, trims the oldest turns until the prompt fits in
 * `nCtx - reserve - CONTEXT_SAFETY_MARGIN` (reserve = min(maxTokens, nCtx/2)),
 * and builds completion params. The system prompt and the newest turn are
 * never dropped. Throws GenerationError if even that doesn't fit.
 */
export async function preparePrompt(
  ctx: LlamaContext,
  opts: {
    systemPrompt: string;
    history: ChatMessage[];
    partial: PartialAssistant | null;
    thinkingEnabled: boolean;
    nCtx: number;
    maxTokens: number;
  },
): Promise<PreparedPrompt> {
  const { systemPrompt, partial, thinkingEnabled, nCtx, maxTokens } = opts;
  const turns = toHistoryTurns(opts.history);

  let mode: ResumeMode = 'fresh';
  if (partial?.content.trim()) mode = 'content';
  else if (partial?.reasoning.trim() && thinkingEnabled) mode = 'reasoning';

  const format = async (dropCount: number) => {
    const kept = turns.slice(dropCount);
    // Resuming visible content: thinking already happened, so format with
    // thinking off (Qwen closes the think block in the generation prompt,
    // Gemma omits its think marker) and the model continues the answer.
    const enableThinking = mode === 'content' ? false : thinkingEnabled;
    const formatted = await ctx.getFormattedChat(toMessages(systemPrompt, kept), null, {
      enable_thinking: enableThinking,
      reasoning_format: 'auto',
      add_generation_prompt: true,
    });
    let assembled = assemble(formatted, mode, partial);
    if (!assembled) {
      // Can't reopen this model's thinking block: regenerate the turn instead.
      mode = 'fresh';
      assembled = assemble(formatted, mode, partial)!;
    }
    // tokenize() doesn't add BOS; count it.
    const tokens = (await ctx.tokenize(assembled.prompt)).tokens.length + 1;
    return { formatted, assembled, tokens };
  };

  const reserve = Math.min(maxTokens, Math.floor(nCtx / 2));
  const promptBudget = nCtx - reserve - CONTEXT_SAFETY_MARGIN;
  const maxDrop = Math.max(0, turns.length - 1);

  let drop = 0;
  let r = await format(drop);
  if (r.tokens > promptBudget && maxDrop > 0) {
    // Estimate per-turn cost once, jump close to the answer, then verify.
    const sizes = await Promise.all(
      turns.map(async (t) => (await ctx.tokenize(t.content)).tokens.length + PER_TURN_OVERHEAD_TOKENS),
    );
    let excess = r.tokens - promptBudget;
    while (drop < maxDrop && excess > 0) {
      excess -= sizes[drop];
      drop++;
    }
    drop = alignToUser(turns, drop);
    r = await format(drop);
    while (r.tokens > promptBudget && drop < maxDrop) {
      drop = alignToUser(turns, drop + 1);
      r = await format(drop);
    }
  }

  const nPredict = Math.min(maxTokens, nCtx - r.tokens - CONTEXT_SAFETY_MARGIN);
  if (nPredict < Math.min(MIN_PREDICT_TOKENS, maxTokens)) {
    throw new GenerationError(
      partial && mode !== 'fresh'
        ? "This reply is too long to continue within the model's context window. Send a new message instead."
        : `Your message is too long for the model's context window (~${r.tokens} of ${nCtx} tokens). Try shortening it.`,
    );
  }

  const { formatted, assembled } = r;
  const params: CompletionParams = {
    prompt: assembled.prompt,
    n_predict: nPredict,
    temperature: TEMPERATURE,
    reasoning_format: 'auto',
    stop: [...STOP_STRINGS],
  };
  let nativeReasoning = false;
  if (isJinja(formatted)) {
    // Mirrors what LlamaContext.completion() copies from getFormattedChat()
    // when given `messages` (node_modules/llama.rn/src/index.ts).
    if (typeof formatted.chat_format === 'number') params.chat_format = formatted.chat_format;
    if (formatted.grammar) params.grammar = formatted.grammar;
    if (typeof formatted.grammar_lazy === 'boolean') params.grammar_lazy = formatted.grammar_lazy;
    if (formatted.grammar_triggers) params.grammar_triggers = formatted.grammar_triggers;
    if (formatted.preserved_tokens) params.preserved_tokens = formatted.preserved_tokens;
    if (formatted.additional_stops) params.stop!.push(...formatted.additional_stops);
    if (typeof formatted.generation_prompt === 'string') params.generation_prompt = formatted.generation_prompt;
    if (typeof formatted.thinking_forced_open === 'boolean') params.thinking_forced_open = formatted.thinking_forced_open;
    if (formatted.chat_parser) {
      params.chat_parser = formatted.chat_parser;
      nativeReasoning = true;
    }
  }
  if (assembled.prefill) params.prefill_text = assembled.prefill;

  return {
    params,
    promptTokens: r.tokens,
    nPredict,
    nCtx,
    trimmedTurns: drop,
    mode,
    nativeReasoning,
    openAtStart: assembled.openAtStart,
    prefill: assembled.prefill,
    partial,
  };
}

/** Initial streamed values for a prepared prompt (what the message shows before the first token). */
export function initialSnapshot(prepared: PreparedPrompt): StreamSnapshot {
  const p = prepared.partial;
  if (!p) return { content: '', reasoning: '', isReasoning: false, tokens: 0 };
  switch (prepared.mode) {
    case 'content':
      return { content: p.content, reasoning: p.reasoning, isReasoning: false, tokens: 0 };
    case 'reasoning':
      return { content: '', reasoning: p.reasoning, isReasoning: true, tokens: 0 };
    default:
      return { content: '', reasoning: '', isReasoning: false, tokens: 0 };
  }
}

/**
 * Maps parsed output (which covers prefill + generated text) to the message's
 * final fields, guarding against a parser that dropped the resumed prefix.
 */
function mapParsed(prepared: PreparedPrompt, parsedContent: string, parsedReasoning: string, rawNew: string) {
  let content = parsedContent;
  let reasoning = parsedReasoning;
  if (!prepared.nativeReasoning) {
    ({ content, reasoning } = normalizeReasoning(content, reasoning, { openAtStart: prepared.openAtStart }));
  }
  const p = prepared.partial;
  if (p && prepared.mode === 'content') {
    reasoning = p.reasoning; // thinking was formatted off; keep the original thoughts
    if (content.length < p.content.length) content = p.content + rawNew;
  } else if (p && prepared.mode === 'reasoning' && !content && reasoning.length < p.reasoning.length) {
    reasoning = p.reasoning + rawNew;
  }
  return { content, reasoning };
}

/**
 * Runs one completion, streaming snapshots to `onUpdate` (called per token;
 * throttle in the caller). Never throws: errors are returned in the outcome.
 * `shouldAbort` is checked synchronously right before the native call, so an
 * abort requested while the prompt was being prepared is never lost.
 */
export async function runCompletion(
  ctx: LlamaContext,
  prepared: PreparedPrompt,
  shouldAbort: () => boolean,
  onUpdate: (snapshot: StreamSnapshot) => void,
): Promise<CompletionOutcome> {
  const snap = initialSnapshot(prepared);
  let rawNew = '';
  let settled = false;
  const startedAt = Date.now();

  const onToken = (data: TokenData) => {
    if (settled) return;
    snap.tokens++;
    rawNew += data.token ?? '';
    let parsedContent: string;
    let parsedReasoning: string;
    if (data.content === undefined && data.reasoning_content === undefined && data.accumulated_text === undefined) {
      // The partial parse failed for this token (llama.rn swallows the error).
      if (prepared.nativeReasoning) {
        onUpdate({ ...snap });
        return;
      }
      parsedContent = prepared.prefill + rawNew;
      parsedReasoning = '';
    } else {
      parsedContent = data.content ?? '';
      parsedReasoning = data.reasoning_content ?? '';
    }
    const next = mapParsed(prepared, parsedContent, parsedReasoning, rawNew);
    if (next.reasoning.length > snap.reasoning.length) snap.isReasoning = true;
    else if (next.content.length > snap.content.length) snap.isReasoning = false;
    snap.content = next.content;
    snap.reasoning = next.reasoning;
    onUpdate({ ...snap });
  };

  const outcome = (result: NativeCompletionResult | null, error: unknown, skipped = false): CompletionOutcome => {
    settled = true;
    const durationMs = Date.now() - startedAt;
    const predictedTokens = result?.tokens_predicted ?? snap.tokens;
    const nativeTps = result?.timings?.predicted_per_second;
    const tokensPerSecond =
      typeof nativeTps === 'number' && nativeTps > 0 ? nativeTps : durationMs > 0 ? (predictedTokens * 1000) / durationMs : 0;
    let { content, reasoning } = snap;
    // A normally finished completion carries a final (non-partial) parse;
    // interrupted ones don't (JSICompletion.h), so keep the streamed values.
    if (result && !result.interrupted && (result.content !== undefined || result.reasoning_content !== undefined)) {
      ({ content, reasoning } = mapParsed(prepared, result.content ?? '', result.reasoning_content ?? '', rawNew));
    } else if (result && !content && !reasoning && result.text) {
      ({ content, reasoning } = mapParsed(prepared, prepared.prefill + result.text, '', result.text));
    }
    return { content, reasoning, result, error, skipped, predictedTokens, tokensPerSecond, durationMs };
  };

  if (shouldAbort()) return outcome(null, null, true);
  try {
    // With `prompt` (no `messages`) completion() reaches the native call
    // synchronously, so a stopCompletion() issued after this line applies.
    const result = await ctx.completion(prepared.params, onToken);
    return outcome(result, null);
  } catch (e) {
    return outcome(null, e);
  }
}

/** Finish reason for a settled completion. A requested abort always wins. */
export function classifyFinish(
  outcome: CompletionOutcome,
  abortReason: 'cancelled' | 'interrupted' | null,
): FinishReason {
  if (abortReason) return abortReason;
  if (outcome.error) return 'error';
  const r = outcome.result;
  if (!r || r.interrupted) return 'interrupted';
  if (r.stopped_limit || r.context_full) return 'length';
  return 'stop';
}

/** User-facing text for an error thrown by llama.rn or our own code. */
export function describeGenerationError(e: unknown): string {
  if (e instanceof GenerationError) return e.message;
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (/context is full/i.test(msg)) return "The conversation no longer fits in the model's context window.";
  if (/context is busy/i.test(msg)) return 'The model is still busy with another reply. Try again.';
  if (/not found|released|NULL_CONTEXT/i.test(msg)) return 'The model was unloaded during generation.';
  return msg ? `Generation failed: ${msg}` : 'Generation failed.';
}
