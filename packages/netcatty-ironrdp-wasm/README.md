# @netcatty/ironrdp-wasm

Self-contained WebAssembly build of [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) `crates/ironrdp-web` for Netcatty's built-in RDP client.

- **Upstream commit:** `293cb4bee90baddfd7b8ea08d2f46e31947a3888`
- **License:** `MIT OR Apache-2.0` (see `LICENSE-MIT` and `LICENSE-APACHE`)
- **Patches applied** (under `scripts/ironrdp-web-patches/`):
  1. `0001-session-responsiveness.patch` — 16ms dirty-rectangle coalescing (`PaintTicker`) and cooperative event-loop yielding every 16 frames so rapid screen updates do not starve DOM keyboard/mouse input.
  2. `0002-load-balance-info-and-shell.patch` — Exposes `load_balance_info`, `alternate_shell`, and `work_dir` extensions on `SessionBuilder` for JumpServer Razor and RDS Connection Broker routing.
  3. `0003-rdpdr-drives-and-multimonitor.patch` — Adds `WasmDriveBackend` for MS-RDPEFS drive redirection (`rdpdr_drives`, `rdpdr_request_callback`, `rdpdr_response`, `rdpdr_add_drive`, `rdpdr_remove_drive`, composing cleanly with audio and printer redirection) and MS-RDPEDISP multi-monitor layout extensions (`set_monitor_layout`, `display_control_caps_callback`).
  4. `0004-standard-rdp-security.patch` — Fixes `ConferenceCreateRequest` GCC `connectPDU` PER length encoding, raises `ServerSecurityData` certificate size limits, and adds Standard RDP Security (MS-RDPBCGR 5.3) with 40/56/128-bit RC4 (standard & salted MAC, 4096-packet key update) and FIPS (3DES-EDE3-CBC + HMAC-SHA1) across Slow-Path, Fast-Path, and Deactivation-Reactivation, plus `security_info_callback`.

## Rebuilding

```bash
./scripts/build-ironrdp-wasm.sh
```
