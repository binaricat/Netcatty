# Issue #2974: Shift+Enter 的终端输入链路与开源 TUI 对照

> 研究日期：2026-09-02
> 范围：Netcatty PR #3247、Kitty keyboard protocol、Windows ConPTY/win32-input-mode、xterm.js，以及 Codex、Grok Build、OpenCode、Gemini CLI、Qwen Code 当前开源源码。所有外部结论只使用官方规范、官方仓库与项目自身源码。

## 结论

1. **本轮研究开始时的 PR 头 `f2ec2a4` 不是 #2974 的彻底修复。** 它修正了一个必要的兼容性回退：不能把“进入全屏/备用屏幕”误当成 TUI 已协商 Kitty 键盘协议，否则 Grok 一类未协商的程序会把 `CSI 13;2u` 显示成字面文本。PR 改为只有协商成功时才发送 CSI-u，否则继续发送配置的换行文本。这个改动能消除 `[13;2u` 泄漏，但在报告者的本机 Windows PowerShell → Codex 路径上仍会丢失 Shift，因此旧头单独合并不能关闭 issue。[PR #3247 说明](https://github.com/binaricat/Netcatty/pull/3247)；[旧 PR 头部的回退分支](https://github.com/binaricat/Netcatty/blob/f2ec2a4842dc4e1fc50b489df45f77bff79eb9d8/components/terminal/runtime/createXTermRuntime.ts#L1974-L2015)
2. **报告者原始路径的根因在 Windows ConPTY 输入层，不是 Codex 热键本身。** ConPTY 启动时会主动发送 `CSI ? 9001 h`，要求前端用无损的 Win32 `INPUT_RECORD` 格式回送键盘事件；xterm.js 已实现这个模式和 Shift+Enter，但该能力默认关闭。Netcatty 在补丁前的依赖已经包含实现，却没有开启它，所以 Enter、Shift+Enter、Ctrl+Enter 在到达 PowerShell/Codex 前已经被旧式输入编码折叠。[ConPTY 当前启动代码](https://github.com/microsoft/terminal/blob/62711fd73ef9733fa83108bfa7cea22528d2dbb9/src/host/VtIo.cpp#L196-L204)；[xterm.js 开关默认值](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/typings/xterm.d.ts#L485-L492)；[Netcatty 的 xterm.js 版本](https://github.com/binaricat/Netcatty/blob/f2ec2a4842dc4e1fc50b489df45f77bff79eb9d8/package.json#L103-L110)
3. **覆盖报告者复现的最小正确修法**是：仅对 Netcatty 本机 Windows 的 ConPTY 终端开启 xterm.js `vtExtensions.win32InputMode`，并在 `term.modes.win32InputMode` 生效时让 Netcatty 自己的 Shift+Enter 文本回退和 Kitty 编码让路。这样浏览器中的 Shift 状态会被 ConPTY 重建成原生键盘记录，Codex 和 Grok 都能从各自现有的 Windows 输入栈读到真正的 Shift，无需按应用名判断，也无需强塞 CSI-u。
4. **本次不需要改 Codex 或 Grok。** 两者已经把 Shift+Enter 绑定为换行；Codex 在 Windows 明确选择原生 `INPUT_RECORD` 模式，Grok 所用的 crossterm 也会把 Win32 `SHIFT_PRESSED` 解成 Shift。缺失的是 Netcatty/xterm.js 到 ConPTY 的无损传输。[Codex Windows 模式](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/tui/src/tui/windows_console.rs#L1-L17)；[Codex 换行键](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/tui/src/keymap.rs#L1462-L1479)；[Grok 换行处理](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager-render/src/input/terminal_support.rs#L45-L55)
5. **关闭 issue 的边界**：把上述 ConPTY 补丁纳入 PR 后，代码因果链和字节级测试足以证明修法正确；但最好仍用真实 Windows 跑一次 Netcatty 本机 PowerShell → Codex/Grok。远端 Windows SSH 不是报告者原始复现，不能据此阻止本 issue 关闭；它应作为后续兼容范围单列。

## 1. 报告者说的 Grok 是哪个项目

这里不是根据同名项目猜测。Netcatty 自己把命令 `grok` 登记为 **Grok Build**，描述为 xAI 的 coding agent CLI：[agent discovery](https://github.com/binaricat/Netcatty/blob/f2ec2a4842dc4e1fc50b489df45f77bff79eb9d8/electron/bridges/aiBridge/agentDiscoveryHandlers.cjs#L98-L101) 和 [设置类型](https://github.com/binaricat/Netcatty/blob/f2ec2a4842dc4e1fc50b489df45f77bff79eb9d8/components/settings/tabs/ai/types.ts#L221-L231) 都指向同一产品。[xAI 官方公告](https://x.ai/news/grok-build-open-source)称其开放的是 Grok Build 的 agent 与 TUI 源码，[官方仓库 README](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/README.md#L10-L17) 也明确该仓库包含 `grok` CLI/TUI。因此本报告审查的是 `xai-org/grok-build`，不是其他同名 Grok CLI。

## 2. 为什么这个问题容易被“修坏”

旧式终端协议没有“键盘对象”，只有字节流。Kitty 官方规范的旧式编码表明确写出：普通 Enter、Ctrl+Enter、Shift+Enter、Ctrl+Shift+Enter 都是同一个 `0x0d`；只有 Alt 会多一个 ESC。[官方规范旧式 C0 表](https://github.com/kovidgoyal/kitty/blob/0dbbedfb5e316dfa23ce61fd23e6ea7e3e91d88b/docs/keyboard-protocol.rst#L523-L534)

因此一旦浏览器按键在终端模拟器中被编码成 CR/LF，后面的 PowerShell、Codex 或 Grok 无法反推它原来是否带 Shift。发送 `\n` 只是“让某些输入框换行”的内容映射，不是传递 Shift+Enter；反过来，无条件发送 `CSI 13;2u` 也不对，因为不理解 CSI-u 的程序会把它当作普通输入。报告者先看到修饰键全部变成 `Mods=0`，后来又在 Grok 看到 `[13;2u`，正好对应这两个失败方向：[原始按键记录](https://github.com/binaricat/Netcatty/issues/2974#issuecomment-5289958145)；[最新补充](https://github.com/binaricat/Netcatty/issues/2974#issuecomment-5506053970)。

Kitty 协议的正确模型是**应用协商**：应用先查询 `CSI ? u`，终端回复当前 flags；应用再 push 所需 flags，主屏与备用屏各有独立栈。[查询、push/pop 与双屏栈](https://github.com/kovidgoyal/kitty/blob/0dbbedfb5e316dfa23ce61fd23e6ea7e3e91d88b/docs/keyboard-protocol.rst#L285-L334) 应用应把 Kitty 查询和 DA 查询一起发；若只收到 DA，则判定终端不支持。[检测规则](https://github.com/kovidgoyal/kitty/blob/0dbbedfb5e316dfa23ce61fd23e6ea7e3e91d88b/docs/keyboard-protocol.rst#L437-L456) Shift 的修饰值为 `1 + 1 = 2`，所以 Shift+Enter 才是 `CSI 13;2u`。[修饰值编码](https://github.com/kovidgoyal/kitty/blob/0dbbedfb5e316dfa23ce61fd23e6ea7e3e91d88b/docs/keyboard-protocol.rst#L182-L210)

这也说明 PR #3247 删除“只要进入备用屏就发送 CSI-u”的判断是对的：备用屏只决定协议状态栈存在哪里，不代表应用支持或已经启用协议。

## 3. Windows 上还有一条更直接的标准路径

Windows ConPTY 不是普通 Unix PTY。Microsoft 的规范专门把 Shift+Enter 列为没有唯一 VT 编码、需要保真的按键，并定义了 `win32-input-mode`：[设计目标与 Shift+Enter](https://github.com/microsoft/terminal/blob/62711fd73ef9733fa83108bfa7cea22528d2dbb9/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md#L40-L69)。

链路如下：

```text
浏览器 KeyboardEvent
  → xterm.js（收到 ConPTY 的 CSI ?9001h 后切换）
  → CSI Vk;Sc;Uc;Kd;Cs;Rc _
  → ConPTY 重建 INPUT_RECORD
  → PowerShell / Codex / Grok 读取原生键盘记录
```

官方格式包含虚拟键码、扫描码、Unicode 字符、按下/抬起、修饰键状态和重复次数，因此不是只为 Shift+Enter 打补丁，而是完整传递键盘记录。[请求和格式](https://github.com/microsoft/terminal/blob/62711fd73ef9733fa83108bfa7cea22528d2dbb9/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md#L100-L179) ConPTY 会主动向承载它的终端请求该模式，不支持的终端忽略即可。[ConPTY 场景说明](https://github.com/microsoft/terminal/blob/62711fd73ef9733fa83108bfa7cea22528d2dbb9/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md#L278-L295)

xterm.js PR [#5603](https://github.com/xtermjs/xterm.js/pull/5603) 已于 2026-01-10 合并该能力。当前实现只在选项允许时接受 `DECSET 9001`，[模式开关](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/InputHandler.ts#L2043-L2047)；模式激活后优先于 Kitty 和旧式编码，[键盘分派](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/browser/services/KeyboardService.ts#L36-L65)；它把 Shift 记录为 Win32 flag 16，并输出完整序列。[编码实现](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/input/Win32InputMode.ts#L20-L33) [输出格式](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/input/Win32InputMode.ts#L275-L296) 上游测试还直接覆盖了 Shift+Enter 与 Ctrl+Enter 的区别。[xterm.js 测试](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/input/Win32InputMode.test.ts#L176-L197)

Netcatty 使用的 `@xterm/xterm 6.1.0-beta.292` 已带这个接口，但默认 `false`。VS Code 的当前源码也把它接到 xterm.js，却仍标为 restricted、experimental、advanced 且默认关闭：[VS Code 配置](https://github.com/microsoft/vscode/blob/0eb8ec268728142ee7665e7e07cf6bdf9379cc7e/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts#L592-L607) [传给 xterm.js](https://github.com/microsoft/vscode/blob/0eb8ec268728142ee7665e7e07cf6bdf9379cc7e/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts#L265-L278)。这为本 PR 只在已知的“本机 Windows + ConPTY”路径最小开启提供了兼容性依据，而不是把实验能力无条件扩大到所有会话。

## 4. 开源 TUI 的实际做法

| 项目 | 输入栈与协商 | Shift+Enter 处理 | 对 #2974 的含义 |
|---|---|---|---|
| OpenAI Codex | Rust + crossterm 0.29 fork。Unix 会按 Kitty 规范发 `CSI ?u` + DA 并解析回复；Windows 则先清除 `ENABLE_VIRTUAL_TERMINAL_INPUT`，明确选择原生 `INPUT_RECORD`。 | 默认把 Shift+Enter、Alt+Enter、Ctrl+J、Ctrl+M 绑定为插入换行。 | 报告者本机 Windows 路径不依赖 Kitty；Netcatty 应把浏览器修饰键无损交给 ConPTY。 |
| Grok Build | Rust + crossterm 0.28。先按终端品牌做兼容性门禁，再调用 crossterm 探测；Windows 的 crossterm 探测恒为 false。Grok 明确跳过 Windows Terminal、VS Code/xterm.js 家族和无正面证据的未知终端。 | 源码已经接受 Shift+Enter/Alt+Enter；判定 Shift 不可靠时 UI 改提示 Alt+Enter。 | 强塞 Kitty 必然与 Grok 的门禁冲突；Win32 INPUT_RECORD 才是本机 Windows 的共同路径。 |
| OpenCode | TypeScript + OpenTUI 0.4.5，启用 `useKittyKeyboard`。OpenTUI 会查询 Kitty；未用 Kitty 时尝试 `modifyOtherKeys`，并能解析 `CSI 27;2;13~`。 | 默认 Shift/Ctrl/Alt+Enter 和 Ctrl+J 都是换行。 | 说明成熟 TUI 会协商并保留多种回退，但终端侧不能替应用擅自假定协议。 |
| Gemini CLI | TypeScript/Ink。启动时同时查询 Kitty、`modifyOtherKeys`、终端名和 DA；收到 Kitty 回复优先启用，否则只在确认 `modifyOtherKeys` level 2 后启用。 | Shift/Ctrl/Cmd/Alt+Enter 和 Ctrl+J 都是换行。 | 是“探测后启用”的直接范例，不支持无条件 CSI-u。 |
| Qwen Code | TypeScript，Ink 与 OpenTUI 两条路径都先发 Kitty query + DA；无回复/仅 DA/超时即保持 legacy，备用屏重新 push。解析器也认识 `modifyOtherKeys`。 | Shift/Ctrl/Cmd+Enter 和 Ctrl+J 是换行。 | 同样把能力协商与备用屏状态分开，支持 PR #3247 的方向。 |

### Codex

Codex Unix 启动探针发 `CSI ?u` 和 DA，[探针发送](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/tui/src/terminal_probe.rs#L268-L289) 并把“只收到 DA”判为不支持。[探针解析](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/tui/src/terminal_probe.rs#L437-L499) 但 Windows 初始化先执行 `set_input_record_mode()`，[TUI 初始化](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/tui/src/tui.rs#L227-L247)；其 crossterm fork 在 Windows 上也明确让 Kitty 支持探测恒为 false。[crossterm fork](https://github.com/openai-oss-forks/crossterm/blob/45fecb9508105988f42fe6ff0441783ed3717f92/src/terminal/sys/windows.rs#L71-L77) 这与报告者“打开 Netcatty Kitty 设置仍无效”完全一致：Codex 的 Windows 路径本来就不靠 Kitty。

### Grok Build

Grok 使用 crossterm 0.28，[依赖声明](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/Cargo.toml#L140-L149)。它在 VS Code/xterm.js、Windows Terminal、旧 VTE、未知且无 multiplexer 的环境主动跳过 Kitty，[兼容性门禁](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs#L313-L358)；只有门禁通过且 crossterm 探测成功才 push flags。[启动协商](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/src/app/mod.rs#L1466-L1497) crossterm 0.28 在 Windows 的 `supports_keyboard_enhancement()` 恒为 false，[crossterm 0.28](https://github.com/crossterm-rs/crossterm/blob/5d50d8da62c5e034ef8b2787a771a2c0f9b3b2f9/src/terminal/sys/windows.rs#L71-L77)，但它读取 Win32 控制键状态时会把 `SHIFT_PRESSED` 转成 `KeyModifiers::SHIFT`。[Windows 按键解析](https://github.com/crossterm-rs/crossterm/blob/5d50d8da62c5e034ef8b2787a771a2c0f9b3b2f9/src/event/sys/windows/parse.rs#L79-L98)

所以 Grok 当前源码并不要求 Netcatty“伪装成 Kitty 终端”；它要求 Windows 输入链路不要在进入 crossterm 前丢掉 Shift。Grok 已经在输入框中处理 Shift/Alt+Enter，[输入框逻辑](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/src/views/prompt_widget/mod.rs#L1680-L1686)，并在不可区分时提示 Alt+Enter。[提示逻辑](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/src/views/agent.rs#L952-L973)

### OpenCode / OpenTUI

OpenCode 当前创建 OpenTUI renderer 时启用 `useKittyKeyboard`，[OpenCode TUI](https://github.com/sst/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/tui/src/app.tsx#L186-L206)，换行键包括 Shift/Ctrl/Alt+Return 与 Ctrl+J。[按键配置](https://github.com/sst/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/tui/src/config/keybind.ts#L161-L165) 它的框架 OpenTUI 0.4.5 会发 `CSI ?u`，[能力查询](https://github.com/sst/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/ansi.zig#L311-L336)，只有检测到 Kitty 回复才 push flags；否则先尝试 `modifyOtherKeys`。[模式选择](https://github.com/sst/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/terminal.zig#L362-L381) 解析器同时支持 Kitty 与 `modifyOtherKeys` 的 Shift+Enter。[解析器](https://github.com/sst/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/lib/parse.keypress.ts#L311-L339)

### Gemini CLI

Gemini 同时定义 Kitty、`modifyOtherKeys` 与 DA 查询，[查询定义](https://github.com/google-gemini/gemini-cli/blob/4963a4456a886bb6af7dcfb807ad6e3e46ce46fc/packages/cli/src/ui/utils/terminalCapabilityManager.ts#L41-L85)，把 DA 当作所有查询已经处理的哨兵，[探测流程](https://github.com/google-gemini/gemini-cli/blob/4963a4456a886bb6af7dcfb807ad6e3e46ce46fc/packages/cli/src/ui/utils/terminalCapabilityManager.ts#L182-L250)，并且只启用已经得到正面回复的协议。[启用决策](https://github.com/google-gemini/gemini-cli/blob/4963a4456a886bb6af7dcfb807ad6e3e46ce46fc/packages/cli/src/ui/utils/terminalCapabilityManager.ts#L258-L272) 其解析器兼容两种编码，[按键解析](https://github.com/google-gemini/gemini-cli/blob/4963a4456a886bb6af7dcfb807ad6e3e46ce46fc/packages/cli/src/ui/contexts/KeypressContext.tsx#L565-L588)，并把所有常见 modified Enter 绑定为换行。[按键配置](https://github.com/google-gemini/gemini-cli/blob/4963a4456a886bb6af7dcfb807ad6e3e46ce46fc/packages/cli/src/ui/key/keyBindings.ts#L359-L371)

### Qwen Code

Qwen 的 Ink 路径按规范发 Kitty query + DA，只有收到 Kitty 回复才 push，超时则保持 legacy。[检测器](https://github.com/QwenLM/qwen-code/blob/83c4e7ea84d5c5dde9b6fb14d3a5ab4aa7afaf94/packages/cli/src/ui/utils/kittyProtocolDetector.ts#L27-L124) 它也明确处理了主屏/备用屏各自有协议栈的问题。[备用屏重新 push](https://github.com/QwenLM/qwen-code/blob/83c4e7ea84d5c5dde9b6fb14d3a5ab4aa7afaf94/packages/cli/src/ui/utils/kittyProtocolDetector.ts#L134-L151) OpenTUI 路径先做同样的 200ms 探测，无回复就不启用 Kitty。[OpenTUI 协商](https://github.com/QwenLM/qwen-code/blob/83c4e7ea84d5c5dde9b6fb14d3a5ab4aa7afaf94/packages/cli/src/ui/opentui/kitty-negotiation.ts#L76-L147) 它的按键配置已经支持 Shift/Ctrl/Cmd+Enter 和 Ctrl+J 换行。[按键配置](https://github.com/QwenLM/qwen-code/blob/83c4e7ea84d5c5dde9b6fb14d3a5ab4aa7afaf94/packages/cli/src/config/keyBindings.ts#L208-L230)

## 5. 为什么不能把 Windows 修法改成“ConPTY 内部统一转 Kitty”

Windows Terminal 已通过 PR [#19817](https://github.com/microsoft/terminal/pull/19817) 实现 Kitty keyboard protocol，但当前 ConPTY 源码明确临时禁止把 win32-input-mode 输入转成 Kitty，因为这会绕过 Windows Terminal 自己的开关。[当前 `VtIo.cpp`](https://github.com/microsoft/terminal/blob/62711fd73ef9733fa83108bfa7cea22528d2dbb9/src/host/VtIo.cpp#L125-L131) 对应的 Microsoft issue [#19847](https://github.com/microsoft/terminal/issues/19847) 截至研究时仍 open。

因此现在让 Netcatty 在 ConPTY 路径强发 Kitty，不仅与 Codex/Grok 的 Windows 输入模型不合，还押注了一个 Microsoft 尚未放开的转换。让 xterm.js 按 ConPTY 已经发出的 `?9001h` 请求回送 Win32 输入记录，才是当前标准定义且已落地的路径。

## 6. Netcatty 能独立修什么，哪些必须由 TUI 配合

### Netcatty 可以独立修复

- 本机 Windows + ConPTY：开启 xterm.js `win32InputMode` capability；实际切换仍由 ConPTY 的 `CSI ?9001h` 触发。
- 模式生效时，不再由 Netcatty 的 Shift+Enter 文本映射或 Kitty 编码截获按键，让 xterm.js 输出 Win32 记录。
- 保留 PR #3247 的协商门槛：未协商 Kitty 的非 ConPTY 程序不能收到强制 CSI-u。
- 保持现有 Kitty query/set/push/pop 支持。Netcatty 当前已经处理这些序列，[协议处理器](https://github.com/binaricat/Netcatty/blob/f2ec2a4842dc4e1fc50b489df45f77bff79eb9d8/components/terminal/runtime/kittyKeyboardRuntime.ts#L58-L118)，只是默认设置关闭。[默认设置](https://github.com/binaricat/Netcatty/blob/f2ec2a4842dc4e1fc50b489df45f77bff79eb9d8/domain/models/terminal.ts#L483-L488)

### 必须由 TUI 协商或支持

- 普通 Unix/VT 链路要区分 Shift+Enter，TUI 必须启用 Kitty、`modifyOtherKeys` 或其他双方都理解的增强协议。Netcatty 只能提供能力和回复查询，不能凭“它看起来像 TUI”强制发送。
- 未协商增强协议的旧程序只能收到传统 CR/LF；Netcatty 的“Shift+Enter 发送文本”可以作为内容级兼容选项，但不能称为修饰键直传。
- Grok 在非 Windows、xterm.js/未知品牌的 VT 路径中主动跳过 Kitty，这是 Grok 的兼容策略。若以后要让这类路径也原生支持 Shift+Enter，应由 Grok 放宽门禁或由双方增加可靠的正面能力识别；这不属于 #2974 的本机 ConPTY 复现。

### 暂不需要做

- 不做 Codex/Grok/Claude/OpenCode 应用名识别。
- 不根据主屏/备用屏猜协议能力。
- 不为关闭 #2974 新增 `modifyOtherKeys`。它对部分 Unix TUI 有兼容价值，但 xterm.js 当前源码没有该模式的实现，而且本机 ConPTY 已有更直接的无损路径。
- 不把 win32-input-mode 默认扩大到所有会话。VS Code 仍把它视为实验能力；先覆盖已知本机 ConPTY 路径更稳妥。

## 7. PR #3247 的最终判断与关闭条件

### 对补入 ConPTY 修复前的 PR 头 `f2ec2a4` 的判断

**不能单独用它关闭 #2974。** 它是必要的安全修正，不是回退到“问题已解决前”的旧代码：它消除了错误的能力猜测和 Grok 字面 CSI-u 泄漏。但它在未协商 Kitty 时仍发送默认 `\n`，所以报告者的 Codex 仍拿不到 Shift。[默认回退文本](https://github.com/binaricat/Netcatty/blob/f2ec2a4842dc4e1fc50b489df45f77bff79eb9d8/components/terminal/runtime/shiftEnterText.ts#L52-L74) [PR 分支](https://github.com/binaricat/Netcatty/blob/f2ec2a4842dc4e1fc50b489df45f77bff79eb9d8/components/terminal/runtime/createXTermRuntime.ts#L1974-L2015)

### 纳入 ConPTY 补丁后的判断

对报告者明确的“Netcatty 本机启动 PowerShell → Codex/Grok”路径，这是针对根因的修复，不是应用级 workaround。当前工作树的字节级验证已经证明：

- xterm.js 默认忽略 `CSI ?9001h`；
- 开启 capability 后，模式会激活；
- Enter、Shift+Enter、Ctrl+Enter、Alt+Enter 分别产生不同 Win32 输入记录；
- Shift+Enter 的控制状态为 16，Ctrl+Enter 为 8，不再互相混淆；
- Shift+Enter 文本回退和 Netcatty Kitty 编码在 Win32 模式下让路。
- 原始 Win32 传输内容不会被误记为命令、自动补全文本或密码输入；修饰回车和按键松开没有文本提交含义。
- 被 Netcatty 自己消费的快捷键不会留下孤立的松键；切走焦点时会补齐已经发出的松键，避免 TUI 认为 Shift 等按键一直按住。
- 多终端广播按每个目标实际支持的协议分别编码，且不会把输入焦点从当前终端抢走。

本地执行：

```text
node --test --import tsx \
  components/terminal/runtime/shiftEnterText.test.ts \
  components/terminal/runtime/win32InputMode.test.ts \
  components/terminal/runtime/kittyKeyboardBroadcast.test.ts \
  components/terminal/runtime/kittyKeyboardProtocol.test.ts \
  components/terminal/runtime/terminalImeTextInput.test.ts

90 passed, 0 failed
```

交付前的项目级验证也已通过：`npm run lint` 无错误，`npm test` 共 11,206 项（11,192 通过、0 失败、14 项环境限定跳过），`npm run build` 成功。两轮独立对抗审查均未发现 #2974 范围内仍可达的问题；弹窗迁移或远端 Windows 等额外覆盖面保留为范围外建议。

### 建议的关闭门槛

1. 把 ConPTY capability + 让路逻辑及测试提交到 PR #3247，而不是只保留当前 `f2ec2a4`。
2. 在真实 Windows 上用本机终端复验：
   - PowerShell 按键记录：Enter=`Mods=0`、Shift+Enter=`Mods=Shift`、Ctrl+Enter=`Mods=Control`；
   - Codex：Shift+Enter 插入新行，不再被识别为 Ctrl+Enter；
   - Grok：Shift+Enter 插入新行，不出现 `[13;2u` 字面文本。
3. 上述真实链路通过后可以关闭 #2974；发布版让报告者复测仍是最理想的最后确认，但不应把“远端 Windows SSH 尚未专门验证”混入本 issue 的原始范围。

## 8. 剩余不确定性

- 本报告的源码和 JSDOM 字节测试确认了因果链，但没有代替真实 Windows UI/ConPTY 运行验证。
- `win32-input-mode` 在 xterm.js 与 VS Code 中仍属较新的实验能力；本机 ConPTY 的窄范围启用降低了外溢风险。
- 若未来收到“Netcatty → SSH → 远端 Windows ConPTY”同类报告，需要单独确认 `CSI ?9001h` 是否穿过该 SSH/PTY 实现，并决定是否在已识别的远端 Windows 会话启用 capability。那是后续覆盖面，不是当前 #2974 是否修复的否定条件。
