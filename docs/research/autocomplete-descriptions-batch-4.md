# Autocomplete description overlay: small-gap utility batch

This batch closes the 22 general-purpose commands that the translation audit
listed with 15 or fewer missing descriptions. The same numeric tier also
contains 184 vendor-specific or niche specs (for example `sapphire`, `yomo`,
`tangram`, `mailsy`, `streamlit`); those are intentionally left to a later pass
because their semantics need per-tool verification. Descriptions are localized
for `zh-CN` and generated into `zh-TW`; local Fig specs also correct option
semantics where the bundled specs do not match the target operating system.

Scope: `echo`, `which`, `paste`, `pwd`, `clear`, `su`, `crontab`, `env`,
`uname`, `base64`, `date`, `id`, `split`, `seq`, `join`, `dig`, `dd`, `htop`,
`basename`, `dirname`, `readlink`, and `more`. The batch adopts 159 unique
English keys from 160 per-command entries (`String to operate on (typically
filenames)` is shared by `basename` and `dirname`).

## Sources

| Source | Version / location | Used for |
| --- | --- | --- |
| `@withfig/autocomplete` | `2.692.3`; compiled `build/{echo,which,paste,pwd,clear,su,crontab,env,uname,base64,date,id,split,seq,join,dig,dd,htop,basename,dirname,readlink,more}.js` | English keys, option names, and arguments |
| GNU Coreutils | documented `echo`, `env`, `base64`, `date`, `id`, `split`, `seq`, `join`, `dd`, `pwd`, `basename`, `dirname`, `readlink` behavior | Option semantics shared with GNU |
| BSD/macOS manuals | local macOS `man su`, `date`, `crontab`, `clear`, `more`, `id`, `paste` | Flags the Fig specs actually expose (several are BSD-only) |
| `jaywcjlove/linux-command` | MIT, `master` fetched 2026-11-07 (sparse clone of `command/`) | GNU option wording for the Linux-first review, and the option set of the local GNU `date` spec |

Checked on 2026-11-07 against `@withfig/autocomplete@2.692.3` by scanning all 714
bundled specs for each adopted key. Eleven keys are shared outside this batch
and were reviewed for wording that stays correct in every owner:

| Shared key | Also used by | Resolution |
| --- | --- | --- |
| `Query Domain A/MX/CNAME/TXT Record`, `Query SOA/TTL Record`, `Query ALL DNS Records`, `Query only answer section` | `dog` | DNS-record wording is command-neutral |
| `String to operate on (typically filenames)` | `basename`, `dirname` | shared inside the batch |
| `Print version info` | `ag` | generic version wording |
| `Display version information` | `ampx`, `hexo`, `julia`, `mkinitcpio`, `mvn`, `premake` | generic version wording |

## Coverage

| Command | Descriptions | Notes |
| --- | ---: | --- |
| `echo` | 4 | newline suppression and escape handling |
| `which` | 3 | PATH lookup, `-a`, `-s` |
| `paste` | 3 | line concatenation, `-d` circular list, `-s` |
| `pwd` | 3 | logical vs physical directory |
| `clear` | 4 | terminal type, ncurses version, E3 scrollback |
| `su` | 4 | BSD `-f`/`-l`/`-`/`-m` |
| `crontab` | 5 | maintain, edit, list, remove, `-u` |
| `env` | 9 | NUL-terminated output, `-i`, `-v`, `-u`, `-P`, `-S` |
| `uname` | 8 | `-a`, `-m`, `-n`, `-p`, `-r`, `-s`, `-v` |
| `base64` | 8 | local GNU spec: `-d`, `-i`, `-w` and file operands |
| `date` | 17 | local GNU spec: `-d`, `--debug`, `-f`, `-I`, `-R`, `--rfc-3339`, `-r`, `-s`, `-u` |
| `id` | 10 | audit, full name, groups, MAC label, `-n`, `-p` |
| `split` | 9 | suffix length, `-b`, `-d`, `-l`, `-p`, file, prefix |
| `seq` | 11 | start/step/last, `-w`, `-s`, `-f`, `-t` |
| `join` | 11 | equality join, `-a`, `-e`, `-o`, `-t`, `-v`, file/field |
| `dig` | 10 | local spec: record types and output filters |
| `dd` | 14 | block sizes, seek/skip, conversions |
| `htop` | 14 | delay, filter, highlight, sort, tree, user |
| `basename` | 4 | `-a`, `-s`, operand |
| `dirname` | 2 | operand |
| `readlink` | 11 | local GNU spec: canonicalize, quiet, verbose, zero; separate macOS spec |
| `more` | 11 | `-d`, `-l`, `-f`, `-p`, `-c`, `-s`, `-u`, `-n` |

The table counts the descriptions each command reaches with the specs in this
change, so later corrections are already reflected there (`dig` no longer
carries the removed `TTL` shortcut, for example). Totals: 175 reachable
descriptions on Linux; platform variants add descriptions beyond these numbers.
The local `date`, `dig`, `readlink` and `base64` specs replace bundled option
sets on Linux, while `htop` corrects the `-H` delay unit.

All 22 commands are added to `COVERED_COMMANDS` and `COMMON_FIG_SPECS`. They are
small, general-purpose utilities, so preloading them costs little and removes the
on-demand spec load for the most common shell sessions.

## Semantic notes

- **dig**: the bundled spec labels the `NS` type as “Query MX Record” and offers
  `TTL` as a record type. Both are spec defects rather than wording problems, so
  `electron/specs/dig.js` replaces them: NS is described as authoritative name
  servers, the bogus TTL shortcut is gone, and ANY carries the RFC 8482 caveat.
- **more**: the Fig spec maps `-l` to “Do not pause after any line containing a
  ^L (form feed)” and `-f` to “Count logical lines, rather than screen lines”.
  This matches GNU `more`; the translations follow the option each description
  belongs to, not the numeric order of the list.
- **date**: Linux uses the local GNU spec (`electron/specs/date.js`), with
  `-d/--date`, `--debug`, `-f/--file`, `-I/--iso-8601`, `-R/--rfc-email`,
  `--rfc-3339`, `-r/--reference`, `-s/--set` and `-u/--utc`. macOS uses
  `electron/specs/macos/date.js` for its BSD arguments, including `-f` input
  format, `-j`, `-r` file or epoch seconds, `-v` adjustment and `-z` output
  timezone. File suggestions for `-r` also appear for numeric prefixes so that
  filenames beginning with digits remain discoverable. The bundled macOS
  spec's obsolete `-d` and `-t` switches are omitted from the local one. If the
  native spec is ever missing, the loader falls back to the bundled spec and its
  descriptions keep the older BSD meanings they quote.
- **su**: the four descriptions no longer hardcode BSD-only environment claims.
  `-l` says it switches to the target home and rebuilds the login environment as
  the implementation and PAM decide. With `-m`, BSD selects the caller's
  login shell, while util-linux normally consults `SHELL`; explicit shell and
  restricted-shell rules affect the latter. `-f` prevents a csh/tcsh login
  shell from reading `.cshrc`.
- **env**: `-P` searches an alternate directory list instead of `PATH`, `-S`
  splits a string into arguments, and the trailing “Utility to run” describes
  the command operand. These are three separate keys and are not conflated.
- **readlink**: the bundled spec reuses `stat` wording for the command root and
  `-f` (“printf”, “struct stat”). `electron/specs/readlink.js` supplies the GNU
  options (`-f/-e/-m/-n/-q/-s/-v/-z`), while the macOS variant supplies its
  native `-f` and `-n`. `-s/--silent` suppresses errors; there is no `--strip`.
- **paste**: `-d` replaces newlines with characters drawn circularly from the
  list; the translation keeps the “wrap around the list” behavior explicit.
- **split**: `-p` starts a new output file on each matching extended regular
  expression and is incompatible with `-b`/`-l`; the translation states both.
- **id**: the long root description distinguishes real and effective IDs; the
  translation preserves that distinction and the “assumed identical when a user
  is named” clause.

## Platform coverage (GNU/Linux vs BSD/macOS)

Netcatty sessions usually target Linux hosts, so GNU semantics were checked
against `jaywcjlove/linux-command` (MIT, `master` fetched 2026-11-07) for every
command in this batch that the reference covers (21 of 22; `readlink` is absent).
That review changed four entries, confirmed the rest, and produced the GNU
`date` spec described in the semantic notes.

Local specs cover five commands whose bundled Fig data was wrong or macOS-only.
Linux hosts load the following local versions:

| Command | Local spec | Bundled spec problem |
| --- | --- | --- |
| `date` | `electron/specs/date.js` | `-j`, `-n`, `-t`, `-v`; `-d` meant DST, `-r` meant epoch seconds |
| `dig` | `electron/specs/dig.js` | `NS` labelled as an MX query, `TTL` offered as a record type |
| `readlink` | `electron/specs/readlink.js` | root and `-f` reused `stat` wording (`printf`, `struct stat`) |
| `base64` | `electron/specs/base64.js` | BSD `-b`/`-i`/`-o`; GNU uses `-w`, and `-i` means ignore garbage while decoding |
| `htop` | `electron/specs/htop.js` | `-H` delay described as tenths of a second; htop stores seconds |

For macOS sessions, the loader uses separate native `date` and `readlink`
specs and the bundled BSD `base64` spec. If the native `date` spec is missing,
the loader falls back to the bundled BSD `date` spec, whose descriptions retain
translations matching their English keys. `dig` and `htop` use their common
local specs. The renderer passes the target session's OS over the Fig bridge,
and loaded/in-flight spec caches, the available-spec list and the loaded-name
index are all scoped by command and OS. For macOS the bridge's spec list merges
`specs/` with `specs/macos/`; other sessions see only `specs/`, so a
macOS-only command is never suggested where it cannot load.

The remaining specs include options or meanings that depend on the platform.
The table records examples from the bundled BSD-oriented specs; some flags also
exist in GNU or util-linux tools but have different semantics:

| Command | Platform-dependent options |
| --- | --- |
| `su` | `-f`, `-l`, `-m`, `-` |
| `id` | `-A`, `-F`, `-M`, `-P` |
| `split` | `-p` |
| `seq` | `-t` |
| `env` | `-P` |
| `more` | `-u` (GNU uses it for underlining; the spec follows BSD “ignored”) |
| `which` | `-s` |

`su` is a special case: its spec is close to util-linux, but the wording no
longer hardcodes `PATH=/bin:/usr/bin` or a fixed variable list, because Linux
`su -l` setup depends on the implementation and PAM configuration. The `-m`
description calls out the BSD and util-linux shell-selection difference; the
`-l` and `-f` descriptions avoid fixed environment claims.

`dd` also carries an upstream artifact: an operand named `files` with “Copy this
many files before terminating”, which real `dd` does not have; the literal
translation is kept and flagged here instead of inventing behavior.

The loader now supports per-OS spec selection. The remaining commands listed
above still use their existing shared specs and need separate review before
adding platform-specific overrides.

## Review fixes (2026-11-08)

A second review pass over the 159 new entries found wording that would be
visible in the completion menu. Every item below was applied:

| Item | Resolution |
| --- | --- |
| `htop -H` “new and old processes” | 高亮新启动和已退出的进程 (old entries are processes that just exited and linger for highlighting) |
| `htop` highlight delay | The Fig text says “in tenths of sec”, but htop 3.2.2 compares `1000 * highlightDelaySecs`; `electron/specs/htop.js` corrects the English for every locale and the zh-CN text says seconds |
| `split -a` “letters” | 字符, because `-d` produces numeric suffixes |
| `split -b` units | KiB / MiB / GiB, matching GNU's 1024-based suffixes instead of KB |
| `dd cbs` | 转换记录长度（字节），供 block/unblock 等记录转换使用 |
| `join -a` / `-v` | 第 file_number 个文件中的行, because `file_number` is a file index |
| `join -o` | No longer limited to matched lines; `-o` also formats unpaired output from `-a`/`-v` |
| `basename -a` | 支持多个路径名，将每个参数作为路径名处理 |
| `env -0` | 每条环境变量记录以 NUL 而非换行符结束 |
| `dig` answer filter | The zh-CN value describes hiding comments, question, authority, additional and statistics; the English key stays unchanged because `dog` shares it |
| `dig ANY` | The shared `Query ALL DNS Records` key stays; the zh-CN value carries the RFC 8482 caveat |
| `dig TTL` | Removed from the `dig` spec; the dictionary key stays because `dog` still offers TTL |
| `readlink -f` | Fixed by the local spec; no longer shows `printf`/`struct stat` wording |
| `base64 -i` | GNU uses `--ignore-garbage`; macOS takes an input file and uses the bundled BSD spec |
| `su -l` / `-m` / `-f` | Removed hardcoded environment claims; see the platform note |
| `seq` root | 默认按 1 递增；BSD/macOS 在起始值大于结束值时按 -1 递减 |
| `uname` root | 显示系统信息（无选项时输出内核名称） |

Taiwan wording that OpenCC s2twp could not resolve is handled by a documented
post-conversion table in the generator (not by hand-editing `zh-TW`):
`擴充套件正規表示式`→`擴充正規表示式`, `擴充套件 E3`→`擴充 E3`,
`欄位連線`→`欄位聯結`, `二進位制資料`→`二進位資料`, `后綴`→`字尾`,
`執行檔例項`→`執行檔`, `屏幕`→`螢幕`, `文本`→`文字`.

Shared keys: `dig` keeps `A`, `MX`, `CNAME`, `TXT`, `SOA`, `ANY +noall +answer`
and the section-filter descriptions byte-identical to the bundled spec because
`dog` reuses them, so their corrections live in the zh-CN values. `NS` is the
one dig-specific key (`Query NS records (authoritative name servers)`), and
`Query TTL Record` remains in the dictionary for `dog` only.

## Adopted entries (excerpt)

| Command | English | zh-CN |
| --- | --- | --- |
| `echo` | Write arguments to the standard output | 将参数写入标准输出 |
| `which` | Locate a program in the user's PATH | 在用户的 PATH 中定位程序 |
| `pwd` | Return working directory name | 返回工作目录名称 |
| `seq -w` | Equalize the widths of all numbers by padding with zeros as necessary | 必要时用零填充，使所有数字宽度一致 |
| `basename` | Return filename portion of pathname | 返回路径名的文件名部分 |
| `dirname` | Return directory portion of pathname | 返回路径名的目录部分 |
| `readlink` | Symbolic link or path to resolve | 要解析的符号链接或路径 |
| `date -u` | Display or set the date in UTC (Coordinated Universal) time | 以 UTC（协调世界时）显示或设置日期 |
| `more -f` | Count logical lines, rather than screen lines | 按逻辑行计数，而不是按屏幕行 |
| `dig` (NS) | Query NS records (authoritative name servers) | 查询 NS 记录（权威名称服务器） |
| `split -p` | The file is split whenever an input line matches pattern, which is interpreted as an extended regular expression. The matching line will be the first line of the next output file. This option is incompatible with the -b and -l options | 每当输入行匹配 pattern（按扩展正则表达式解释）时就拆分成新文件。匹配行会成为下一个输出文件的第一行。该选项与 -b 和 -l 不兼容 |
| `dd bs` | Set input and output block size | 同时设置输入和输出块大小 |
| `htop -H` delay | Highlight duration in seconds | 高亮持续时间，单位为秒 |

`zh-TW` is generated from these values with
`node scripts/generate-autocomplete-descriptions-zh-TW.mjs` (OpenCC s2twp), not
edited by hand. Spot checks include `引數`, `檔案`, `程式`, `連結`, `預設`, and `列印`.

## Verification

| Command | Result |
| --- | --- |
| `node scripts/list-untranslated-autocomplete-descriptions.mjs` | only the known `node` shared key and `NO_SPEC ip netstat ss` remain |
| `node --test --import tsx components/terminal/autocompleteDescriptionI18n.batch4.test.ts` | 4 tests, 4 pass |
| `node --test --import tsx components/terminal/{figSpecLoader,autocompleteDescriptionI18n,batch,batch2,batch3}.test.ts` | 19 tests, 19 pass |
| `node scripts/generate-autocomplete-descriptions-zh-TW.mjs` re-run | idempotent, no diff |
| `git diff --check` | clean |

The generator was re-run after the merge and produced no further diff, so the
committed `zh-TW` file is exactly its output.
