# Autocomplete description overlay: file/text utilities batch

This batch continues the offline Fig description overlay after the
`python`/`node`/`vim`/`sort`/`awk`/`sed` batch. The Fig specs keep their English
names, arguments, and structure; only suggestion descriptions are localized for
`zh-CN` and generated into `zh-TW`.

Scope: `ln`, `stat`, `wc`, `cut`, `uniq`, `tee`, and `xargs`. The batch adopts
70 previously untranslated English keys.

## Sources

| Source | Version / location | Used for |
| --- | --- | --- |
| `@withfig/autocomplete` | `2.692.3`, npm `gitHead` `aef52acff84c45edde61ae610cc2c964802b9a38`; `src/{ln,stat,wc,cut,uniq,tee,xargs}.ts` and compiled `build/*.js` | English keys, option names, and arguments |
| GNU Coreutils | 9.12, `wc`, `cut`, `uniq`, `tee`, `xargs` invocations | Shared GNU option semantics |
| BSD/macOS manuals | local macOS 26.7 `man ln`, `stat`, `wc`, `cut`, `uniq`, `tee`, `xargs` | BSD-specific behavior exposed by the Fig specs |
| `jaywcjlove/linux-command` | repository HEAD `8041aeda04762e136078decb2de201ec4348527c` (2026-10-31) | Simplified-Chinese terminology where available |

Checked on 2026-11-07. Every adopted English key occurs only in one of these
seven specs in the bundled Fig package; no other command shares these keys.

## Coverage

| Command | Adopted | Notes |
| --- | ---: | --- |
| `ln` | 8 | hard/symbolic link flags |
| `stat` | 12 | BSD/macOS `stat` output formats |
| `wc` | 6 | byte/line/character/word counts |
| `cut` | 11 | byte/column/field selection |
| `uniq` | 10 | repeated/unique line filtering |
| `tee` | 4 | append and signal handling |
| `xargs` | 19 | replacement, batching, and parallel execution |

Total adopted: 70 unique English keys.

The seven commands are also added to `COMMON_FIG_SPECS` so their specs are
preloaded with the other common commands instead of waiting for an on-demand
load.

## Semantic notes

- **wc**: the upstream description says “World, line, character, and byte
  count”. This is an upstream typo for “Word”; the zh-CN text translates the
  intended word-count meaning and does not repeat the typo.
- **xargs**: the upstream `-x` description says “Terminal if the arguments will
  not fit in the maximum line length”. This is an upstream typo for
  “Terminate”; the zh-CN text says the command terminates instead.
- **cut**: the upstream `-d` argument description uses “deliminator”. The
  zh-CN text uses the standard term 字段分隔符 and keeps `delim` as a literal
  placeholder from the option description.
- **stat**: the Fig spec follows the BSD/macOS `stat` output formats
  (`-F`, `-l`, `-r`, `-s`, `-t`), not GNU `stat`. The translations keep those
  BSD meanings rather than substituting GNU `--format` wording.
- **uniq**: `-c`/`--count`, `-d`/`--repeated`, and `-D`/`--all-repeated` are
  separate suggestions in the Fig spec; both the short and long spellings keep
  the same localized explanation.

## Adopted entries

| Command | English | zh-CN |
| --- | --- | --- |
| `ln` | Create (default hard) symbolic links to files | 为文件创建符号链接（默认为硬链接） |
| `ln -s` | Create a symbolic link | 创建符号链接 |
| `stat` | Display file status | 显示文件状态 |
| `stat -f` | Display information using the specified format; similar to printf(3) formats in that they start with %, are then followed by a sequence of formatting characters, and end in a character that selects the field of the struct stat which is to be formatted | 按指定格式显示信息；类似 printf(3)：以 % 开头，后接格式化字符，并以选择 struct stat 待格式化字段的字符结尾 |
| `wc` | World, line, character, and byte count | 统计单词数、行数、字符数和字节数 |
| `cut` | Cut out selected portions of each line of a file | 从文件的每一行中截取选定部分 |
| `cut -d` | Use delim as the field delimiter character instead of the tab character | 使用 delim 作为字段分隔符，而不是制表符 |
| `uniq -c` | Prefix lines by the number of occurrences | 在每行前加上出现次数 |
| `tee -a` | Append the output to the files rather than overwriting them | 将输出追加到文件而不是覆盖 |
| `xargs -0` | Use NUL (0x00) as a separator, instead of whitespace | 使用 NUL（0x00）而非空白作为分隔符 |
| `xargs -x` | Terminal if the arguments will not fit in the maximum line length | 若参数超出最大行长度则终止 |

`zh-TW` is generated from these values with
`node scripts/generate-autocomplete-descriptions-zh-TW.mjs` (OpenCC s2twp), not
edited by hand. Spot checks include `檔案`, `預設`, `欄位`, `訊號`, and `引數`.
