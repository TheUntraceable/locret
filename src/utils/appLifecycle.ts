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

export interface BackgroundGraceHandlers {
  /** App entered 'background' (not 'inactive'). The grace countdown starts. */
  onBackground?: () => void;
  /** The app stayed in the background for the whole grace period. Fires at most once per background episode. */
  onExpire: () => void;
  /** App is 'active' again after a background episode. */
  onResume?: (info: { expired: boolean; elapsedMs: number }) => void;
}

/**
 * Runs `onExpire` once the app has been in the background for `graceMs`.
 *
 * - 'inactive' is ignored entirely: it never starts or cancels anything.
 * - Android pauses JS timers while the app is backgrounded (RN's
 *   JavaTimerManager stops on host pause), so the timer alone is unreliable:
 *   on return to 'active' the elapsed wall-clock time is checked too (an
 *   overdue grace expires before `onResume` runs), and the returned
 *   `checkExpiry()` lets code that keeps running in the background (e.g. LLM
 *   token callbacks, which are not timer-driven) expire it on time.
 * - Handlers are read through a ref, so callers may pass inline functions.
 *
 * @returns checkExpiry: expires now if backgrounded for at least `graceMs`. Cheap; safe to call often.
 */
export function useBackgroundGrace(
  handlers: BackgroundGraceHandlers,
  graceMs: number = BACKGROUND_LOCK_GRACE_MS,
): () => void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const stateRef = useRef<{
    backgroundedAt: number | null;
    expired: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ backgroundedAt: null, expired: false, timer: null });

  const expire = useCallback(() => {
    const st = stateRef.current;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    if (st.expired) return;
    st.expired = true;
    handlersRef.current.onExpire();
  }, []);

  const checkExpiry = useCallback(() => {
    const st = stateRef.current;
    if (st.backgroundedAt !== null && !st.expired && Date.now() - st.backgroundedAt >= graceMs) expire();
  }, [expire, graceMs]);

  useEffect(() => {
    const st = stateRef.current;
    const onChange = (state: AppStateStatus) => {
      if (state === 'background') {
        if (st.backgroundedAt !== null) return; // already counting down
        st.backgroundedAt = Date.now();
        st.expired = false;
        handlersRef.current.onBackground?.();
        st.timer = setTimeout(expire, graceMs);
      } else if (state === 'active') {
        if (st.backgroundedAt === null) return; // e.g. back from 'inactive' only
        const elapsedMs = Date.now() - st.backgroundedAt;
        st.backgroundedAt = null;
        if (st.timer) clearTimeout(st.timer);
        st.timer = null;
        if (elapsedMs >= graceMs) expire();
        handlersRef.current.onResume?.({ expired: st.expired, elapsedMs });
      }
    };

    const sub = AppState.addEventListener('change', onChange);
    return () => {
      sub.remove();
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
    };
  }, [expire, graceMs]);

  return checkExpiry;
}
