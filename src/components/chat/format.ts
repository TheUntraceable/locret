import type { FinishReason, MessageStats } from '../../types';

/** 842 → "842", 1234 → "1.2k", 12345 → "12k". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}

/** 800 → "0.8s", 4200 → "4.2s", 42000 → "42s", 95000 → "1m 35s". */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${Math.max(0.1, s).toFixed(1).replace(/\.0$/, '')}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

/** "42 tok/s · 1.2k tokens · Qwen3.5 4B" */
export function formatStats(stats: MessageStats): string {
  const parts: string[] = [];
  if (stats.tokensPerSecond > 0) {
    const tps = stats.tokensPerSecond;
    parts.push(`${tps >= 10 ? Math.round(tps) : tps.toFixed(1)} tok/s`);
  }
  if (stats.predictedTokens > 0) {
    parts.push(`${formatTokenCount(stats.predictedTokens)} token${stats.predictedTokens === 1 ? '' : 's'}`);
  }
  if (stats.model) parts.push(stats.model);
  return parts.join(' · ');
}

/** Short reason shown next to the Continue action. */
export function continueReasonLabel(reason: FinishReason | undefined): string {
  switch (reason) {
    case 'length':
      return 'Cut off';
    case 'cancelled':
      return 'Stopped';
    case 'interrupted':
      return 'Interrupted';
    default:
      return 'Incomplete';
  }
}
