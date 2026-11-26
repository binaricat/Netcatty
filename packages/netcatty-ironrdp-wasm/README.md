# @netcatty/ironrdp-wasm

Self-contained WebAssembly build of [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) `crates/ironrdp-web` for Netcatty's built-in RDP client.

- **Upstream commit:** `293cb4bee90baddfd7b8ea08d2f46e31947a3888`
- **License:** `MIT OR Apache-2.0` (see `LICENSE-MIT` and `LICENSE-APACHE`)
- **Patches applied** (under `patches/ironrdp-web/`):
  1. `0001-session-responsiveness.patch` — 16ms dirty-rectangle coalescing (`PaintTicker`) and cooperative event-loop yielding every 16 frames so rapid screen updates do not starve DOM keyboard/mouse input.
  2. `0002-load-balance-info-and-shell.patch` — Exposes `load_balance_info`, `alternate_shell`, and `work_dir` extensions on `SessionBuilder` for JumpServer Razor and RDS Connection Broker routing.

## Rebuilding

```bash
./scripts/build-ironrdp-wasm.sh
```
