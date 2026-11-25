# Configurable SSH reconnect interval

## Goal

Reduce repeated connection-error noise on long outages without changing the
existing reconnect lifecycle. Add an integer interval of 5–3600 seconds to
Settings → Terminal → Connection. The default remains 5 seconds.

## Behavior

The existing terminal settings store persists the interval. Older installations
receive the default; invalid/non-numeric values fall back to 5, finite values are
rounded and clamped to the supported range. The timer and retry notice use the
same normalized value. Editing the field commits on blur or Enter so users can
clear it and type a new value. Disabling automatic reconnection disables the field.

Each newly scheduled retry reads the setting. A timer already waiting keeps its
original deadline. Manual reconnect, cancellation, successful connection, and
intentional shell logout retain their existing behavior. Retry-count limits and
backoff are separate future work.

## Development and validation

- Tests were added first and failed against the previous fixed-delay behavior.
- Focused checks cover missing legacy settings, JSON round trips, interval
  bounds, malformed values, millisecond conversion, and existing reconnect rules.
- Implementation complete; final repository checks are recorded in the PR.
