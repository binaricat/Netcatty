import { useEffect, useRef, useState } from 'react';

import { advanceIndeterminateConnectionProgress } from './connectionProgress';

/**
 * Indeterminate connection progress, animated locally by the connection dialog.
 *
 * The 200 ms animation used to live in Terminal state, which re-rendered the
 * whole Terminal + TerminalView (~45 ms) five times a second for every
 * connecting session, hidden tabs and startup restores included. Terminal now
 * only publishes real progress events (`baseValue`); this hook animates from
 * there while `animating` and never moves backwards, except when the base
 * itself drops (a new connection attempt restarts the bar).
 */
export function useAnimatedConnectionProgress(baseValue: number, animating: boolean): number {
  const [value, setValue] = useState(baseValue);
  const lastBaseRef = useRef(baseValue);

  useEffect(() => {
    const previousBase = lastBaseRef.current;
    lastBaseRef.current = baseValue;
    setValue((current) => (baseValue < previousBase ? baseValue : Math.max(current, baseValue)));
  }, [baseValue]);

  useEffect(() => {
    if (!animating) return undefined;
    const timer = setInterval(() => {
      setValue(advanceIndeterminateConnectionProgress);
    }, 200);
    return () => clearInterval(timer);
  }, [animating]);

  return value;
}

const secondsUntil = (deadlineAt: number): number =>
  Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));

/**
 * Seconds left until `deadlineAt`, ticking locally once a second. With no
 * deadline (timer stopped, e.g. while waiting for user input) the last value
 * is kept, matching the countdown that used to stop with its interval.
 */
export function useConnectionCountdownSeconds(deadlineAt: number | null, initialSeconds: number): number {
  const [seconds, setSeconds] = useState(() => (deadlineAt == null ? initialSeconds : secondsUntil(deadlineAt)));

  useEffect(() => {
    if (deadlineAt == null) return undefined;
    setSeconds(secondsUntil(deadlineAt));
    const timer = setInterval(() => setSeconds(secondsUntil(deadlineAt)), 1000);
    return () => clearInterval(timer);
  }, [deadlineAt]);

  return seconds;
}
