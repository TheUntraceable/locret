import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * How long the app may stay in the background before the vault and the AI chat
 * lock themselves.
 *
 * Android reports brief system overlays (Circle to Search, notification shade,
 * permission and biometric dialogs) as 'background'; iOS reports Control Center
 * and Face ID sheets as 'inactive'. Locking instantly on those threw users to
 * /auth mid-reply and unloaded the model. 30 s covers overlays and quick app
 * switches while still locking an abandoned app.
 */
export const BACKGROUND_LOCK_GRACE_MS = 30_000;

/**
 * The current background episode, shared by every useBackgroundGrace instance
 * (AutoLockManager for the vault, ChatContext for the chat) so they can never
 * disagree: the start and end of an episode are recorded once (by whichever
 * listener sees the AppState event first), and once any instance finds the
 * grace expired (timer, token-driven check or return to foreground), all of
 * them treat the episode as expired. Without this, two listeners computing
 * `Date.now() - start` a millisecond apart around the 30 s mark could lock the
 * chat but not the vault (or vice versa).
 */
const episode = {
  seq: 0,
  backgroundedAt: null as number | null,
  /** When the app became active again; null while still in the background. */
  resumedAt: null as number | null,
  expired: false,
};

function isInBackgroundEpisode(seq: number): boolean {
  return episode.seq === seq && episode.backgroundedAt !== null && episode.resumedAt === null;
}

/** Joins the running episode, or starts a new one. */
function joinOrBeginEpisode(now: number): number {
  if (episode.backgroundedAt === null || episode.resumedAt !== null) {
    episode.seq++;
    episode.backgroundedAt = now;
    episode.resumedAt = null;
    episode.expired = false;
  }
  return episode.seq;
}

/** Decides expiry for the current episode (sticky once true). */
function episodeExpired(now: number): boolean {
  if (episode.backgroundedAt === null) return false;
  if (!episode.expired && (episode.resumedAt ?? now) - episode.backgroundedAt >= BACKGROUND_LOCK_GRACE_MS) {
    episode.expired = true;
  }
  return episode.expired;
}

export interface BackgroundGraceHandlers {
  /** App entered 'background' (not 'inactive'). The grace countdown starts. */
  onBackground?: () => void;
  /** The app stayed in the background for the whole grace period. Fires at most once per background episode. */
  onExpire: () => void;
  /** App is 'active' again after a background episode. */
  onResume?: (info: { expired: boolean; elapsedMs: number }) => void;
}

/**
 * Runs `onExpire` once the app has been in the background for
 * BACKGROUND_LOCK_GRACE_MS.
 *
 * - 'inactive' is ignored entirely: it never starts or cancels anything.
 * - Android pauses JS timers while the app is backgrounded (RN's
 *   JavaTimerManager stops on host pause), so the timer alone is unreliable:
 *   on return to 'active' the elapsed wall-clock time is checked too (an
 *   overdue grace expires before `onResume` runs), and the returned
 *   `checkExpiry()` lets code that keeps running in the background (e.g. LLM
 *   token callbacks, which are not timer-driven) expire it on time.
 * - Every instance shares one episode (see `episode` above), so all of them
 *   expire together or not at all.
 * - Handlers are read through a ref, so callers may pass inline functions.
 *
 * @returns checkExpiry: expires now if backgrounded for at least the grace. Cheap; safe to call often.
 */
export function useBackgroundGrace(handlers: BackgroundGraceHandlers): () => void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const stateRef = useRef<{
    /** Episode this instance is counting down, null while in the foreground. */
    episode: number | null;
    expired: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ episode: null, expired: false, timer: null });

  const clearTimer = useCallback(() => {
    const st = stateRef.current;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
  }, []);

  /** Expires this instance if the shared episode has expired. */
  const checkExpiry = useCallback(() => {
    const st = stateRef.current;
    if (st.episode === null || st.episode !== episode.seq || st.expired) return;
    if (!episodeExpired(Date.now())) return;
    clearTimer();
    st.expired = true;
    handlersRef.current.onExpire();
  }, [clearTimer]);

  useEffect(() => {
    const st = stateRef.current;
    const tick = () => {
      st.timer = null;
      checkExpiry();
      // A timer may fire marginally early: re-arm for what is left.
      if (!st.expired && st.episode !== null && isInBackgroundEpisode(st.episode) && episode.backgroundedAt !== null) {
        const left = BACKGROUND_LOCK_GRACE_MS - (Date.now() - episode.backgroundedAt);
        st.timer = setTimeout(tick, Math.max(50, left));
      }
    };
    const onChange = (state: AppStateStatus) => {
      if (state === 'background') {
        if (st.episode !== null && isInBackgroundEpisode(st.episode)) return; // already counting down
        st.episode = joinOrBeginEpisode(Date.now());
        st.expired = false;
        handlersRef.current.onBackground?.();
        clearTimer();
        st.timer = setTimeout(tick, BACKGROUND_LOCK_GRACE_MS);
      } else if (state === 'active') {
        if (st.episode === null) return; // e.g. back from 'inactive' only
        if (isInBackgroundEpisode(st.episode)) episode.resumedAt = Date.now(); // first listener records the end
        clearTimer();
        checkExpiry(); // uses the shared end time: every instance reaches the same verdict
        const elapsedMs = st.episode === episode.seq ? (episode.resumedAt ?? Date.now()) - (episode.backgroundedAt ?? 0) : 0;
        const expired = st.expired;
        st.episode = null;
        handlersRef.current.onResume?.({ expired, elapsedMs });
      }
    };

    const sub = AppState.addEventListener('change', onChange);
    return () => {
      sub.remove();
      clearTimer();
    };
  }, [checkExpiry, clearTimer]);

  return checkExpiry;
}
