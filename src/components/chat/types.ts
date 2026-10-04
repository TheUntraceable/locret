import type { ChatMessage } from '../../types';

/** One row of the chat list. */
export interface ChatItem {
  /** List key: message id, or a local id for an optimistic user message. */
  key: string;
  message: ChatMessage;
  /** Assistant message currently streaming: content/reasoning come from the streaming fields. */
  live: boolean;
  /** Live and the latest tokens went to the thinking channel. */
  thinking: boolean;
  /** User message shown before it was persisted. */
  optimistic: boolean;
  /**
   * Showing the last streamed text because the stored copy is older (between
   * the end of a turn and the reload that brings the finalised message).
   */
  stale: boolean;
}

export type TurnAction = 'continue' | 'retry' | 'regenerate' | 'copy';

/** Controls shown under the last message when no reply is running. */
export interface TurnFooter {
  status:
    | { kind: 'complete' }
    | { kind: 'incomplete'; label: string }
    | { kind: 'error'; text: string }
    | { kind: 'no-reply' };
  /** An action was just requested; buttons are disabled until it starts. */
  busy: boolean;
  onAction: (action: TurnAction) => void;
}
