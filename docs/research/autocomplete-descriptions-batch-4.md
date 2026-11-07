# Autocomplete description overlay: small-gap utility batch

This batch closes the 22 general-purpose commands that the translation audit
listed with 15 or fewer missing descriptions. The same numeric tier also
contains 184 vendor-specific or niche specs (for example `sapphire`, `yomo`,
`tangram`, `mailsy`, `streamlit`); those are intentionally left to a later pass
because their semantics need per-tool verification. The Fig spec names,
arguments and structure stay untouched; only suggestion descriptions are
localized for `zh-CN` and generated into `zh-TW`.

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

| Command | Adopted | Notes |
| --- | ---: | --- |
| `echo` | 4 | newline suppression and escape handling |
| `which` | 3 | PATH lookup, `-a`, `-s` |
| `paste` | 3 | line concatenation, `-d` circular list, `-s` |
| `pwd` | 3 | logical vs physical directory |
| `clear` | 4 | terminal type, ncurses version, E3 scrollback |
| `su` | 4 | BSD `-f`/`-l`/`-`/`-m` |
| `crontab` | 5 | maintain, edit, list, remove, `-u` |
| `env` | 8 | NUL-terminated output, `-i`, `-v`, `-u`, `-P`, `-S` |
| `uname` | 8 | `-a`, `-m`, `-n`, `-p`, `-r`, `-s`, `-v` |
| `base64` | 5 | encode/decode, line breaks, input/output files |
| `date` | 13 | local GNU spec: `-d`, `--debug`, `-f`, `-I`, `-R`, `--rfc-3339`, `-r`, `-s`, `-u` |
| `id` | 10 | audit, full name, groups, MAC label, `-n`, `-p` |
| `split` | 9 | suffix length, `-b`, `-d`, `-l`, `-p`, file, prefix |
| `seq` | 11 | start/step/last, `-w`, `-s`, `-f`, `-t` |
| `join` | 11 | equality join, `-a`, `-e`, `-o`, `-t`, `-v`, file/field |
| `dig` | 11 | record types and output trimming |
| `dd` | 14 | block sizes, seek/skip, conversions |
| `htop` | 14 | delay, filter, highlight, sort, tree, user |
| `basename` | 4 | `-a`, `-s`, operand |
| `dirname` | 2 | operand |
| `readlink` | 1 | file operand |
| `more` | 11 | `-d`, `-l`, `-f`, `-p`, `-c`, `-s`, `-u`, `-n` |

Total adopted: 159 unique English keys across 22 commands.

All 22 commands are added to `COVERED_COMMANDS` and `COMMON_FIG_SPECS`. They are
small, general-purpose utilities, so preloading them costs little and removes the
on-demand spec load for the most common shell sessions.

## Semantic notes

- **dig**: the upstream spec labels the `NS` type as “Query MX Record”, and the
  `TTL` entry as “Query TTL Record” (TTL is not a DNS record type). The `NS`
  translation states the correct meaning and marks the upstream wording error;
  `TTL` is translated literally because the option name itself is what the spec
  inserts.
- **more**: the Fig spec maps `-l` to “Do not pause after any line containing a
  ^L (form feed)” and `-f` to “Count logical lines, rather than screen lines”.
  This matches GNU `more`; the translations follow the option each description
  belongs to, not the numeric order of the list.
- **date**: replaced by a local GNU spec (`electron/specs/date.js`). The bundled
  Fig spec exposed BSD/macOS flags (`-d` DST, `-f` input format, `-j` dry run,
  `-n`, `-R`, `-r` epoch seconds, `-t` minutes west of GMT, `-v` adjust) that
  Linux hosts do not have. The local spec describes `-d/--date`, `--debug`,
  `-f/--file`, `-I/--iso-8601`, `-R/--rfc-email`, `--rfc-3339`, `-r/--reference`,
  `-s/--set` and `-u/--utc` instead, and the 13 BSD-only entries were removed
  after a repository-wide scan showed no other spec used them.
- **su**: `-f` is the csh-specific `.cshrc` guard, `-l` performs a full login,
  `-` alone equals `-l`, and `-m` keeps the environment. All four descriptions
  follow the BSD assertions in the spec, including the `getusershell(3)`
  security note.
- **env**: `-P` searches an alternate directory list instead of `PATH`, `-S`
  splits a string into arguments, and the trailing “Utility to run” describes
  the command operand. These are three separate keys and are not conflated.
- **readlink**: the Fig spec reuses `stat` wording for the command root and for
  `-f`. Those shared keys already had translations from the `stat` batch, so the
  batch only adds the `file` operand; the inherited `stat` wording is unchanged
  upstream and is not re-translated here.
- **paste**: `-d` replaces newlines with characters drawn circularly from the
  list; the translation keeps the “wrap around the list” behavior explicit.
- **split**: `-p` starts a new output file on each matching extended regular
  expression and is incompatible with `-b`/`-l`; the translation states both.
- **id**: the long root description distinguishes real and effective IDs; the
  translation preserves that distinction and the “assumed identical when a user
  is named” clause.

## Platform coverage (GNU/Linux vs BSD/macOS)

Netcatty sessions usually target Linux hosts, so GNU semantics were checked
against `jaywcjlove/linux-command` (MIT, commit `master` at 2026-11-07) for every
command in this batch that the reference covers (21 of 22; `readlink` is absent).
That review changed four entries, confirmed the rest, and produced the GNU
`date` spec below:

- `uname -s/-r/-v`: the Fig text says “operating system name/release/version”,
  but GNU `uname` prints the kernel name/release/version. The zh-CN text now says
  内核名称 / 内核发行版本 / 内核版本, which matches what a Linux host prints and
  is still accurate on macOS (`Darwin`).
- `dd cbs`: “Set the conversion record size” is now 设置转换记录大小（cbs，每次转换的字节数）
  so the unit is explicit, matching GNU `dd` and the reference wording.
- No other wording diverged from the reference beyond synonyms (`制表符` vs
  `跳格字符`, `块` vs `区块`); the existing glossary terms stay in place.

`date` is no longer in this list: it now ships a GNU spec of its own (see the
semantic notes). The remaining specs in this batch expose options that do not
exist in GNU tools. Those
descriptions describe the option each spec actually inserts, so they are **not**
rewritten into GNU wording — doing so would label an item with behavior it does
not have on the host being connected to:

| Command | Spec-only (BSD/macOS) options |
| --- | --- |
| `su` | `-f`, `-l`, `-m`, `-` |
| `id` | `-A`, `-F`, `-M`, `-P` |
| `base64` | `-b`, `-i`, `-o` |
| `split` | `-p` |
| `seq` | `-t` |
| `env` | `-P` |
| `more` | `-u` (GNU uses it for underlining; the spec follows BSD “ignored”) |
| `which` | `-s` |

Making those commands platform-correct needs per-OS spec selection (the loader
currently resolves one spec per command name and ignores `hostOs`), which is a
code change rather than a translation change. `dd` also carries an upstream
artifact: an operand named `files` with “Copy this many files before
terminating”, which real `dd` does not have; the literal translation is kept and
flagged here instead of inventing behavior.

## Adopted entries (excerpt)

| Command | English | zh-CN |
| --- | --- | --- |
| `echo` | Write arguments to the standard output | 将参数写入标准输出 |
| `which` | Locate a program in the user's PATH | 在用户的 PATH 中定位程序 |
| `pwd` | Return working directory name | 返回工作目录名称 |
| `seq -w` | Equalize the widths of all numbers by padding with zeros as necessary | 必要时用零填充，使所有数字宽度一致 |
| `basename` | Return filename portion of pathname | 返回路径名的文件名部分 |
| `dirname` | Return directory portion of pathname | 返回路径名的目录部分 |
| `readlink` | File(s) to readlink | 要读取的符号链接文件 |
| `date -u` | Display or set the date in UTC (Coordinated Universal) time | 以 UTC（协调世界时）显示或设置日期 |
| `more -f` | Count logical lines, rather than screen lines | 按逻辑行计数，而不是按屏幕行 |
| `dig` (NS) | Query MX Record | 查询 NS 记录（上游英文描述误写为 MX） |
| `split -p` | The file is split whenever an input line matches pattern, which is interpreted as an extended regular expression. The matching line will be the first line of the next output file. This option is incompatible with the -b and -l options | 每当输入行匹配 pattern（按扩展正则表达式解释）时就拆分成新文件。匹配行会成为下一个输出文件的第一行。该选项与 -b 和 -l 不兼容 |
| `dd bs` | Set input and output block size | 同时设置输入和输出块大小 |
| `htop -d` | Delay between updates, in tenths of sec | 更新间隔，单位为 0.1 秒 |

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
