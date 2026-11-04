# Autocomplete description overlay: zip/unzip/make/nano batch

This batch continues the offline Fig description overlay after the `touch`
pilot. The Fig specs keep their English names, arguments, and structure; only
suggestion descriptions are localized for `zh-CN` and generated into `zh-TW`.

## Sources

| Source | Version / location | Used for |
| --- | --- | --- |
| `@withfig/autocomplete` | `2.692.3`, npm `gitHead` `aef52acff84c45edde61ae610cc2c964802b9a38`; `src/{zip,unzip,make,nano}.ts` and compiled `build/*.js` | English keys, option names, and arguments |
| `jaywcjlove/linux-command` | repository HEAD `8041aeda04762e136078decb2de201ec4348527c` (2026-10-31); `command/zip.md`, `command/unzip.md`, `command/make.md`, `command/nano.md` | Simplified-Chinese terminology and common examples |
| GNU Make | local `GNU Make 3.81`, `make --help` and `make(1)` | Make option semantics |
| Apple gnumake | tag `gnumake-136`, commit `d16cdb2067133c031532d19c5a06d2e74993ef2a`, [`main.c`](https://github.com/apple-oss-distributions/gnumake/blob/d16cdb2067133c031532d19c5a06d2e74993ef2a/main.c) | `-N` NeXT compatibility extension |
| Info-ZIP | local `zip 3.0` and `unzip 6.00` (Apple builds), `-h`/manual output | ZIP option semantics |
| ArchWiki | `Character encoding`, checked 2026-11-04, `https://wiki.archlinux.org/title/Character_encoding` | Confirm patched unzip uses `-O gbk` for legacy Windows filenames |

Checked on 2026-11-04. Every adopted English key below occurs only in the
`zip`, `unzip`, `make`, or `nano` spec in the bundled Fig package and local
`electron/specs`; no other command shares these keys. Where the Fig English text
conflicts with the verified implementation, the zh-CN text follows the verified
behavior and the discrepancy is recorded below.

## Adopted entries

### zip

| Entry | English | zh-CN |
| --- | --- | --- |
| command | Package and compress (archive) files into zip file | 将文件打包并压缩为 zip 文件 |
| argument | Name of archive | 压缩包名称 |
| `-r` | Package and compress a directory and its contents, recursively | 递归打包并压缩目录及其内容 |
| `-9` | Archive a directory and its contents with the highest level [9] of compression | 使用最高压缩级别 9 |

### unzip

| Entry | English | zh-CN |
| --- | --- | --- |
| command | Extract compressed files in a ZIP archive | 解压 ZIP 压缩包中的文件 |
| `-l` | List the contents of a zip file without extracting | 列出 zip 文件内容而不解压 |
| `-0` | Extract a zip file created in windows, containing files with non-ascii (chinese) filenames | 上游选项疑似错误，请核对当前 unzip 版本支持的参数 |

### make

| Entry | English | zh-CN |
| --- | --- | --- |
| `--file`, `-f`, `--makefile` | Read FILE as a makefile | 将 FILE 作为 makefile 读取 |
| `-C`, `--directory` | Change to DIRECTORY before doing anything | 执行任何操作前先切换到 DIRECTORY |
| `-B`, `--always-make` | Unconditionally make all targets | 无条件构建所有目标 |
| `-e`, `--environment-overrides` | Environment variables override makefiles | 环境变量覆盖 makefile 中的设置 |
| `-h`, `--help` | Print this message and exit | 显示此帮助信息并退出 |
| `-i`, `--ignore-errors` | Ignore errors from commands | 忽略命令返回的错误 |
| `-k`, `--keep-going` | Keep going when some targets can't be made | 某些目标无法构建时继续执行 |
| `-L`, `--check-symlink-times` | Use the latest mtime between symlinks and target | 在符号链接与目标之间使用最新的修改时间 |
| `-p`, `--print-data-base` | Print make's internal database | 打印 make 的内部数据库 |
| `-q`, `--question` | Run no commands; exit status says if up to date | 不运行任何命令；退出状态表示目标是否最新 |
| `-r`, `--no-builtin-rules` | Disable the built-in implicit rules | 禁用内置隐式规则 |
| `-R`, `--no-builtin-variables` | Disable the built-in variable settings | 禁用内置变量设置 |
| `-t`, `--touch` | Touch targets instead of remaking them | 仅更新目标的时间戳，而不重新构建 |
| `-v`, `--version` | Print the version number of make and exit | 显示 make 版本号并退出 |
| `-w`, `--print-directory` | Print the current directory | 显示当前目录 |
| `-d` | Print lots of debugging information | 输出大量调试信息 |
| `--debug` | Print various types of debugging information | 输出各类调试信息 |
| `-I`, `--include-dir` | Search directory for included makefiles | 在目录中搜索被包含的 makefile |
| `-l`, `--load-average` | Don't start multiple jobs unless load is below N | 仅当负载低于 N 时才启动多个作业 |
| `-o`, `--old-file` | Consider file to be very old and don't remake it | 将文件视为非常旧，不重新构建 |
| `--no-print-directory` | Turn off -w, even if it was turned on implicitly | 关闭 -w，即使它是被隐式启用的 |
| `-W`, `--what-if`, `--new-file`, `--assume-new` | Consider file to be infinitely new | 将文件视为永远最新 |
| `--warn-undefined-variables` | Warn when an undefined variable is referenced | 引用未定义变量时发出警告 |
| `-N`, `--Next-option` | Turn on value of next option | 启用指定的 NeXT 兼容选项（Apple 扩展） |

### nano

| Entry | English | zh-CN |
| --- | --- | --- |
| command | Nano's ANOther editor, an enhanced free Pico clone | Nano 的 ANOther 编辑器，一个增强的免费 Pico 克隆 |

`zh-TW` is generated from these values with
`node scripts/generate-autocomplete-descriptions-zh-TW.mjs` (OpenCC s2twp), not
edited by hand. Spot checks include `遞迴`, `檔案`, `資訊`, and `除錯`.

## Semantic notes

- `zip -r` enables recursive directory archiving. `zip -9` only selects the
  highest compression level 9; it does not recurse by itself. The Fig English
  description mentions archiving a directory, but `zip -h2` separates the two,
  so the zh-CN text is limited to the compression level.
- `unzip -l` matches `linux-command` and the local manual: list archive contents
  without extracting.
- `unzip -0` is a Fig-only entry in this package. The local `unzip 6.00` and
  `linux-command` do not list `-0`. Some Linux builds with filename-encoding
  patches use `-O gbk` for Windows/GBK filenames (confirmed against the ArchWiki
  character-encoding notes), but that support is not universal and must be
  checked against the installed build. The zh-CN text therefore only warns that
  the upstream option looks wrong and asks users to verify the current unzip
  version; `-O gbk` remains in this research note. The Fig option name and
  argument structure are unchanged, and no platform detection or option rename
  was added.
- Make options were checked against the local GNU Make 3.81 help/man output.
  `-N`/`--NeXT-option` is an Apple/NeXT compatibility extension, not a generic
  GNU Make option: Apple's source enables NeXT features such as `vpath`,
  `quiet`, `makefiles`, and `errexit`. Fig spells the long form
  `--Next-option`, which differs in capitalization from Apple's
  `--NeXT-option`; the option name is preserved while the zh-CN text describes
  the NeXT compatibility purpose.
- `unzip`/`zip` entry semantics match the local Apple Info-ZIP builds and
  `linux-command`; no platform-specific text was added.
- `nano`'s description is a recursive wordplay ("Nano's ANOther editor"); the
  translation keeps `ANOther` and describes it as an enhanced free Pico clone.

## Later batches

This batch completed `zip`, `unzip`, `make`, and `nano`. The remaining preloaded
common commands were completed in batch 2; see
`docs/research/autocomplete-descriptions-batch-2.md` for the current unresolved
item and overall counts. `ip`, `netstat`, and `ss` remain listed without a
bundled Fig spec in `2.692.3`.

## License notices

The English description strings are derived from `@withfig/autocomplete`, and
the terminology review used `jaywcjlove/linux-command`. Both are MIT licensed:
Copyright (c) 2021 Hercules Labs Inc. (Fig); Copyright © 2019 小弟调调™.
The full MIT text is preserved in
`docs/research/autocomplete-descriptions-touch.md#license-notices`.
