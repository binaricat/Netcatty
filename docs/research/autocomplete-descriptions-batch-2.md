# Autocomplete description overlay: python/node/vim/sort/awk/sed batch

This batch completes the remaining preloaded common commands. The Fig specs keep
their English option names, arguments, and structure; only suggestion
descriptions are localized for `zh-CN` and generated into `zh-TW`.

Scope: `python`, `python3`, `node`, `vim`, `sort`, `awk`, and `sed`. The batch
adopts 177 unique English keys and deliberately defers one shared `node` key.

## Sources

| Source | Version / location | Used for |
| --- | --- | --- |
| `@withfig/autocomplete` | `2.692.3`, npm `gitHead` `aef52acff84c45edde61ae610cc2c964802b9a38`; `src/{python,python3,node,vim,sort,sed}.ts` and compiled `build/*.js` | English keys and option structure |
| local `electron/specs/awk.js` | Netcatty local spec | AWK options and arguments |
| `jaywcjlove/linux-command` | repository HEAD `8041aeda04762e136078decb2de201ec4348527c` (2026-10-31); `command/{sort,awk,sed}.md` | Simplified-Chinese terminology where available |
| Python | local `Python 3.15.0`, `python3 -h`; `https://docs.python.org/3/using/cmdline.html` and Python 3.11 docs | Python option behavior and version differences |
| Node.js | local `Node.js 26.12.0`, `node --help`; `https://nodejs.org/api/cli.html` | Node option behavior |
| Vim | local `Vim 9.1`, `vim --help`; `https://vimhelp.org/starting.txt.html` | Vim startup options |
| GNU Coreutils | 9.12, `sort invocation` (`https://www.gnu.org/software/coreutils/manual/html_node/sort-invocation.html`) | GNU sort options |
| macOS `sort(1)` | local macOS 26.7 manual and `sort --help` | BSD/macOS sort options |
| gawk | Debian bookworm `gawk(1)` (`https://manpages.debian.org/bookworm/gawk/gawk.1.en.html`) | gawk-specific options |
| GNU sed | `https://www.gnu.org/software/sed/manual/sed.html` | GNU sed extensions and automatic-print semantics |
| macOS `sed(1)` | local macOS 26.7 manual | BSD/Apple sed options |

Checked on 2026-11-04. `linux-command` has no `command/python.md`, `command/node.md`,
or `command/vim.md` at this revision, so those commands use the official manuals
and the local tool help instead.

## Coverage

| Command | Adopted | Notes |
| --- | ---: | --- |
| `python` | 23 | 23 keys shared with `python3` |
| `python3` | 24 | 23 shared keys plus `-m` |
| `node` | 12 | 1 shared key deferred |
| `vim` | 39 | includes keys shared with `nvim`/`lvim` |
| `sort` | 37 | Fig mixes shared and BSD/macOS-only options |
| `awk` | 23 | local spec; gawk-specific options are marked |
| `sed` | 42 | Fig mixes BSD/Apple and GNU options |

Total adopted: 177 unique English keys.

## Semantic notes

- **Python**: the local Python 3.15 help does not list `-g`; the behavior in the
  Fig description belongs to `-q`, so the zh-CN text warns that the upstream
  option looks wrong and points to `-q`. `-R` is version-dependent: it appears
  in Python 3.11 documentation but is absent from the Python 3.15 help, so the
  translation keeps the Fig meaning and the version difference is recorded
  here. `-b` is deprecated in 3.15 (scheduled to become a no-op), and `-I`
  additionally implies `-P` in 3.15; the translations describe the Fig-era
  behavior without claiming it is universal.
- **Node.js**: the local Node 26.12 help matches `--watch`, `--watch-path`,
  `--env-file`, `-e`, `-p`, `-c`, `-i`, `--inspect`, and the other adopted
  options.
- **Vim**: the adopted startup options match the local Vim 9.1 `--help` output.
  Keys shared with `nvim`/`lvim` use wording valid for all three.
- **sort**: Fig mixes shared options (including `--sort`, `--debug`, and
  `--parallel`) with BSD/macOS-only options (`--radixsort`, `--mergesort`,
  `--qsort`, `--heapsort`, `--mmap`). The GNU manual caps its default
  `--parallel` value at 8, while the local BSD/macOS manual says the default is
  the number of CPUs; the zh-CN text therefore only says that the option sets
  the number of parallel sorting threads, without a universal default.
- **awk**: the local macOS `awk` is BSD awk, while the spec also exposes
  gawk-specific options. The gawk manual confirms that `-c` is traditional
  compatibility mode (not POSIX), `-n` is `--non-decimal-data`, and `-t` is
  `--lint-old` (not type checking). The zh-CN text follows the gawk manual;
  `electron/specs/awk.js` itself is left unchanged.
- **sed**: the local macOS sed is BSD sed. Fig mixes BSD/Apple options
  (`-a`, `-I`, `-i`, `-l`) with GNU extensions (`e`, `F`, `v`, `z`) and shared
  options. In particular, BSD `-i` requires an extension while GNU `-i` treats
  it as optional; the Fig description follows the BSD form and the difference is
  recorded here. The `n` command prints the pattern space only when automatic
  printing has not been suppressed by `-n`; the zh-CN text states that
  condition.

## Unresolved

One `node` key is intentionally not translated:

```text
Follows symlinks to directories when examining source code and templates for translation strings
```

The same English key is also used by `django-admin --symlinks`, where it is
correct. For Node.js `--preserve-symlinks`, the upstream description is a copy
of the Django text and does not describe Node's module-resolution behavior. A
global dictionary key cannot hold two different translations, so this key is
left in English and the maintenance script reports it as the only missing
description. No platform detection or per-command dictionary was added.

## Remaining missing descriptions

All preloaded common commands are now covered except the deferred `node` key.
`ip`, `netstat`, and `ss` remain listed without a bundled Fig spec in `2.692.3`.
The wider app-visible library remains outside this 7-command scope: 699 specs
contain at least one missing description, totaling 46,887 occurrences and 38,276
unique English strings.

## Adopted entries

| Commands | English | zh-CN |
| --- | --- | --- |
| awk | Assign a variable (var=value) | 赋值一个变量（var=value） |
| awk | AWK program text (e.g. '{print $1}') | AWK 程序文本（例如 '{print $1}'） |
| awk | Disable automatic input record splitting (gawk) | 识别输入数据中的八进制和十六进制值，请谨慎使用（gawk） |
| awk | Dump variables to file (gawk) | 将变量转储到文件（gawk） |
| awk | e.g. ',' or '\t' | 例如 ',' 或 '\t' |
| awk | Enable pretty-printed output | 启用美化（pretty-print）输出 |
| awk | Enable type checking (gawk) | 对无法移植到原始 UNIX awk 的构造发出警告（gawk） |
| awk | Include AWK source library | 包含 AWK 源库 |
| awk | Input file(s) | 输入文件 |
| awk | Load dynamic extension (gawk) | 加载动态扩展（gawk） |
| awk | Pattern scanning and text processing language | 模式扫描和文本处理语言 |
| awk | POSIX compatibility mode (gawk) | POSIX 兼容模式（gawk） |
| awk | Print copyright information | 显示版权信息 |
| awk | Print version information | 打印版本信息 |
| awk | Profile execution and write to file (gawk) | 分析执行情况并写入文件（gawk） |
| awk | Read AWK program from file | 从文件读取 AWK 程序 |
| awk | Read AWK program from file (like -f but disables command-line variable assignments) | 从文件读取 AWK 程序（类似 -f，但禁用命令行变量赋值） |
| awk | Run in POSIX compatibility mode (gawk) | 以传统兼容模式运行，行为等同 Brian Kernighan 的 awk（gawk） |
| awk | Sandbox mode — disable system(), I/O redirection (gawk) | 沙箱模式——禁用 system() 和 I/O 重定向（gawk） |
| awk | Set field separator | 设置字段分隔符 |
| awk | Specify AWK program text | 指定 AWK 程序文本 |
| awk | Treat all input data as single-byte characters (gawk) | 将所有输入数据视为单字节字符（gawk） |
| awk | Use locale decimal point for parsing input data (gawk) | 解析输入数据时使用区域设置的小数点（gawk） |
| node | Activate inspector on host:port (default: 127.0.0.1:9229) | 在 host:port 上启用检查器（默认：127.0.0.1:9229） |
| node | Always enter the REPL even if stdin does not appear to be a terminal | 即使 stdin 不是终端也始终进入 REPL |
| node | Disable the clearing of the console when watch mode restarts the process | 监视模式重启进程时不清空控制台 |
| node | Evaluate script | 执行脚本 |
| node | Evaluate script and print result | 执行脚本并打印结果 |
| node | Print node command line options (currently set) | 打印 node 命令行选项（当前设置） |
| node | Print Node.js version | 打印 Node.js 版本 |
| node | Run the node interpreter | 运行 Node.js 解释器 |
| node | Specify a file containing environment variables | 指定包含环境变量的文件 |
| node | Specify a watch directory or file | 指定要监视的目录或文件 |
| node | Syntax check script without executing | 仅做语法检查，不执行脚本 |
| node | Watch input files | 监视输入文件 |
| python | Module | 模块 |
| python, python3 | Control the validation behavior of hash-based .pyc files. See Cached bytecode invalidation | 控制基于哈希的 .pyc 文件的校验行为。参见“缓存字节码失效” |
| python, python3 | Disable the import of the module site and the site-dependent manipulations of sys.path that it entails | 禁用 site 模块的导入，以及随之进行的 sys.path 站点相关调整 |
| python, python3 | Do -O and also discard docstrings | 执行 -O 的操作，并丢弃文档字符串 |
| python, python3 | Don’t add the user site-packages directory to sys.path | 不将用户 site-packages 目录加入 sys.path |
| python, python3 | Don’t display the copyright and version messages even in interactive mode | 上游选项疑似错误：交互模式下不显示版权和版本信息请用 -q |
| python, python3 | Execute the Python code in command. command can be one or more statements separated by newlines, with significant leading whitespace as in normal module code | 执行 command 中的 Python 代码。command 可以是用换行分隔的一条或多条语句，并像普通模块代码一样保留有意义的行首空白 |
| python, python3 | Force the stdout and stderr streams to be unbuffered. This option has no effect on the stdin stream | 强制 stdout 和 stderr 不缓冲；此选项对 stdin 无效 |
| python, python3 | If given, Python won’t try to write .pyc files on the import of source modules | 指定后，Python 在导入源模块时不会写入 .pyc 文件 |
| python, python3 | Ignore all PYTHON* environment variables, e.g. PYTHONPATH and PYTHONHOME, that might be set | 忽略所有可能设置的 PYTHON* 环境变量，例如 PYTHONPATH 和 PYTHONHOME |
| python, python3 | Issue a warning when comparing bytes or bytearray with str or bytes with int. Issue an error when the option is given twice (-bb) | 比较 bytes/bytearray 与 str，或 bytes 与 int 时发出警告；重复指定（-bb）时改为报错 |
| python, python3 | Print a message each time a module is initialized, showing the place (filename or built-in module) from which it is loaded | 每次初始化模块时输出一条消息，显示其加载位置（文件名或内置模块） |
| python, python3 | Print a short description of all command line options | 显示所有命令行选项的简要说明 |
| python, python3 | Print the Python version number and exit | 显示 Python 版本号并退出 |
| python, python3 | Remove assert statements and any code conditional on the value of __debug__ | 移除 assert 语句以及所有以 __debug__ 值为条件的代码 |
| python, python3 | Reserved for various implementation-specific options | 保留用于各种实现特定选项 |
| python, python3 | Run Python in isolated mode. This also implies -E and -s. In isolated mode sys.path contains neither the script’s directory nor the user’s site-packages directory | 以隔离模式运行 Python，同时隐含 -E 和 -s。隔离模式下 sys.path 不包含脚本目录和用户 site-packages 目录 |
| python, python3 | Run the python interpreter | 运行 Python 解释器 |
| python, python3 | Skip the first line of the source, allowing use of non-Unix forms of #!cmd. This is intended for a DOS specific hack only | 跳过源代码第一行，以支持非 Unix 形式的 #!cmd；仅用于 DOS 特定场景 |
| python, python3 | Turn on hash randomization. This option only has an effect if the PYTHONHASHSEED environment variable is set to 0, since hash randomization is enabled by default | 启用哈希随机化。仅当 PYTHONHASHSEED 环境变量设为 0 时此选项才有效，因为哈希随机化默认已启用 |
| python, python3 | Turn on parser debugging output (for expert only, depending on compilation options) | 启用解析器调试输出（仅供专家使用，是否可用取决于编译选项） |
| python, python3 | Warning control. Python’s warning machinery by default prints warning messages to sys.stderr | 警告控制。Python 的警告机制默认将警告消息输出到 sys.stderr |
| python, python3 | When a script is passed as first argument or the -c option is used, enter interactive mode after executing the script or the command, even when sys.stdin does not appear to be a terminal | 以脚本作为首个参数或使用 -c 时，在执行脚本或命令后进入交互模式，即使 sys.stdin 不是终端 |
| python3 | Search sys.path for the named module and execute its contents as the __main__ module | 在 sys.path 中搜索指定模块，并将其内容作为 __main__ 模块执行 |
| sed | (test) Branch to label only if there has been a successful substitution since the last input line was read or conditional branch was taken. The label may be omitted, in which case the next cycle is started | （test）仅当自上次读取输入行或执行条件分支以来发生过成功替换时，才分支到 label；可省略 label，此时开始下一轮循环 |
| sed | (test) Branch to label only if there have been no successful substitutions since the last input line was read or conditional branch was taken. The label may be omitted, in which case the next cycle is started | （test）仅当自上次读取输入行或执行条件分支以来没有发生成功替换时，才分支到 label；可省略 label，此时开始下一轮循环 |
| sed | (zap) Empties the content of pattern space | （zap）清空模式空间内容 |
| sed | Adds a newline to the pattern space, then appends the next line of input to the pattern space. If there is no more input then sed exits without processing any more commands | 在模式空间后追加一个换行符，再将下一行输入追加到模式空间；若没有更多输入，sed 退出，不再处理任何命令 |
| sed | Appends `text` after a line | 在行后追加 `text` |
| sed | Appends a newline to the contents of the hold space, and then appends the contents of the pattern space to that of the hold space | 在保持空间内容后追加一个换行符，再将模式空间的内容追加到保持空间内容之后 |
| sed | Appends a newline to the contents of the pattern space, and then appends the contents of the hold space to that of the pattern space | 在模式空间内容后追加一个换行符，再将保持空间的内容追加到模式空间内容之后 |
| sed | Appends the editing commands found in the file command_file to the list of commands. The editing commands should each be listed on a separate line | 将文件 command_file 中的编辑命令追加到命令列表。每条编辑命令应单独占一行 |
| sed | Appends the editing commands specified by the command argument to the list of commands | 将由 command 参数指定的编辑命令追加到命令列表 |
| sed | Branch unconditionally to `label` | 无条件分支到 `label` |
| sed | By default, each line of input is echoed to the standard output after all of the commands have been applied to it.  The `-n` option suppresses this behavior | 默认情况下，所有命令应用后每行输入都会回显到标准输出。`-n` 选项会抑制此行为 |
| sed | Causes sed to delay opening each file until a command containing the related ``w'' function is applied to a line of input | 使 sed 延迟打开每个文件，直到对某行输入应用包含相关 ``w'' 函数的命令 |
| sed | Comment until the next newline | 注释直到下一个换行符 |
| sed | Delete the pattern space; immediately start next cycle | 删除模式空间；立即开始下一轮循环 |
| sed | Edits files in-place similarly to `-I`, but treats each file independently from other files.  In particular, line numbers in each file start at 1, the ``$'' address matches the last line of the current file, and address ranges are limited to the current file | 类似 `-I` 就地编辑文件，但将每个文件独立处理。具体而言，每个文件的行号从 1 开始，``$'' 地址匹配当前文件的最后一行，地址范围限于当前文件 |
| sed | Edits files in-place, saving backups with the specified extension.  If a zero-length extension is given, no backup will be saved | 就地编辑文件，并使用指定扩展名保存备份。若扩展名为空，则不保存备份 |
| sed | Exchanges the contents of the hold and pattern spaces | 交换保持空间和模式空间的内容 |
| sed | Executes the command that is found in pattern space and replaces the pattern space with the output; a trailing newline is suppressed | 执行模式空间中的命令，并用命令输出替换模式空间；末尾换行符会被抑制 |
| sed | Exit sed without processing any more commands or input | 退出 sed，不再处理任何命令或输入 |
| sed | If pattern space contains newlines, delete text in the pattern space up to the first newline, and restart cycle with the resultant pattern space, without reading a new line of input. If pattern space contains no newline, start a normal new cycle as if the d command was issued | 若模式空间包含换行符，删除模式空间中第一个换行符之前的文本，并用剩余的模式空间重新开始循环，不读取新的输入行；若模式空间不含换行符，则像执行 d 命令一样开始正常的下一轮循环 |
| sed | Insert text before a line | 在行前插入文本 |
| sed | Interprets regular expressions as extended (modern) regular expressions rather than basic regular expressions | 将正则表达式解释为扩展（现代）正则表达式，而不是基本正则表达式 |
| sed | Makes output line buffered | 使输出行缓冲 |
| sed | Makes output unbuffered | 使输出不缓冲 |
| sed | Makes sed fail if GNU sed extensions are not supported, or if the requested version is not available | 若当前 sed 不支持 GNU sed 扩展或请求的版本不可用，则使 sed 失败 |
| sed | Match the regular-expression against the content of the pattern space. If found, replace matched string with replacement | 用正则表达式匹配模式空间内容；若匹配，将匹配到的字符串替换为 replacement |
| sed | Prints the file name of the current input file | 打印当前输入文件的文件名 |
| sed | Prints the pattern space | 打印模式空间 |
| sed | Prints the pattern space in an unambiguous form | 以无歧义的形式打印模式空间 |
| sed | Prints the pattern space up to the first newline | 打印模式空间中第一个换行符之前的部分 |
| sed | Prints the pattern space, then, regardless, replaces the pattern space with the next line of input. If there is no more input then sed exits without processing any more commands | 未禁用自动打印时，先打印模式空间；随后用下一行输入替换模式空间。若无更多输入则退出。 |
| sed | Queue a line of filename to be read and inserted into the output stream at the end of the current cycle, or when the next input line is read | 排队读取 filename 的一行，并在当前循环结束或读取下一行输入时插入输出流 |
| sed | Reads file | 读取文件 |
| sed | Replace (change) lines with `text` | 用 `text` 替换（更改）行 |
| sed | Replaces the contents of the hold space with the contents of the pattern space | 用模式空间的内容替换保持空间的内容 |
| sed | Replaces the contents of the pattern space with the contents of the hold space | 用保持空间的内容替换模式空间的内容 |
| sed | Same as `-E` for compatibility with GNU sed | 与 `-E` 相同，用于兼容 GNU sed |
| sed | Stream editor | 流编辑器 |
| sed | This command is the same as q, but will not print the contents of pattern space | 与 q 相同，但不打印模式空间的内容 |
| sed | Transliterate any characters in the pattern space which match any of the source-chars with the corresponding character in dest-chars | 将模式空间中与 source-chars 中任一字符匹配的字符转换为 dest-chars 中对应的字符 |
| sed | Writes the pattern space to the file | 将模式空间写入文件 |
| sed | Writes to the given filename the portion of the pattern space up to the first newline | 将模式空间中第一个换行符之前的部分写入指定文件 |
| sort | Check that the single input file is sorted | 检查单个输入文件是否已排序 |
| sort | Consider only blank spaces and alphanumeric characters in comparisons | 比较时仅考虑空白字符和字母数字字符 |
| sort | Convert all lowercase characters to their upper case equivalent before comparison | 比较前将所有小写字符转换为对应的大写形式 |
| sort | Define a restricted sort key that has the starting position field1, and optional ending position field2 | 定义受限排序键，包含起始位置 field1 和可选的结束位置 field2 |
| sort | Displays the current version of sort | 显示 sort 的当前版本 |
| sort | Ignore all non-printable characters | 忽略所有不可打印字符 |
| sort | Ignore leading blank characters when comparing lines | 比较行时忽略前导空白字符 |
| sort | In random sort, the file content is used as the source of the 'seed' data for the hash function choice | 随机排序时，使用文件内容作为哈希函数选择所需的 'seed' 数据来源 |
| sort | Merge only.  The input files are assumed to be pre-sorted.  If they are not sorted the output order is undefined | 仅合并。假定输入文件已预先排序；若未排序，输出顺序未定义 |
| sort | Print some extra information about the sorting process to the standard output | 将排序过程的一些额外信息输出到标准输出 |
| sort | Print the output to the output file instead of the standard output | 将输出写入输出文件而不是标准输出 |
| sort | Select how to sort values | 选择排序类型 |
| sort | Set the maximum number of execution threads.  Default number equals to the number of CPUs | 设置并行排序的线程数 |
| sort | Shows help message | 显示帮助信息 |
| sort | Sort by a random order | 按随机顺序排序 |
| sort | Sort by general numerical value | 按通用数值排序 |
| sort | Sort by month abbreviations.  Unknown strings are considered smaller than the month names | 按月份缩写排序。未知字符串视为小于月份名称 |
| sort | Sort by numerical value, but take into account the SI suffix, if present | 按数值排序，但考虑存在的 SI 后缀 |
| sort | Sort fields numerically by arithmetic value | 按算术值对字段进行数值排序 |
| sort | Sort in reverse order | 按逆序排序 |
| sort | Sort or merge records (lines) of text and binary files | 对文本和二进制文件中的记录（行）进行排序或合并 |
| sort | Sort version numbers | 对版本号排序 |
| sort | Specify maximum number of files that can be opened by sort at once | 指定 sort 一次最多可打开的文件数 |
| sort | Stable sort. This option maintains the original record order of records that have an equal key | 稳定排序。保持键相等的记录原有的相对顺序 |
| sort | Store temporary files in the directory dir | 将临时文件存储在目录 dir 中 |
| sort | Suppress errors on false check | 检查失败时不报告错误 |
| sort | Take the input file list from the file filename | 从文件 filename 中读取输入文件列表 |
| sort | Try to use file memory mapping system call.  It may increase speed in some cases | 尝试使用文件内存映射系统调用。在某些情况下可提高速度 |
| sort | Try to use heap sort, if the sort specifications allow.  This sort algorithm cannot be used with -u and -s | 若排序规范允许，尝试使用堆排序。此算法不能与 -u 和 -s 一起使用 |
| sort | Try to use quick sort, if the sort specifications allow.  This sort algorithm cannot be used with -u and -s | 若排序规范允许，尝试使用快速排序。此算法不能与 -u 和 -s 一起使用 |
| sort | Try to use radix sort, if the sort specifications allow | 若排序规范允许，尝试使用基数排序 |
| sort | Unique keys. Suppress all lines that have a key that is equal to an already processed one | 仅保留唯一键：丢弃键与已处理行相同的所有行 |
| sort | Use char as a field separator character | 使用 char 作为字段分隔符 |
| sort | Use mergesort.  This is a universal algorithm that can always be used, but it is not always the fastest | 使用归并排序。这是一种通用算法，但未必最快 |
| sort | Use NUL as record separator | 使用 NUL 作为记录分隔符 |
| sort | Use PROGRAM to compress temporary files (eg. bzip2) | 使用 PROGRAM 压缩临时文件（例如 bzip2） |
| sort | Use size for the maximum size of the memory buffer | 将 size 用作内存缓冲区的最大大小 |
| vim | 'nocompatible', Vim defaults, no plugins, no viminfo | 'nocompatible'、Vim 默认值、不加载插件、不使用 viminfo |
| vim | Append all typed commands to file <scriptout> | 将所有输入的命令追加到文件 <scriptout> |
| vim | Be verbose [level N] [log messages to fname] | 详细输出 [级别 N] [将日志消息写入 fname] |
| vim | Binary mode | 二进制模式 |
| vim | Compatible with Vi: 'compatible' | 与 Vi 兼容：'compatible' |
| vim | Debugging mode | 调试模式 |
| vim | Diff mode (like 'vimdiff') | 差异模式（类似 'vimdiff'） |
| vim | Don't load plugin scripts | 不加载插件脚本 |
| vim | Easy mode (like 'evim', modeless) | 简易模式（类似 'evim'，无模式） |
| vim | Edit encrypted files | 编辑加密文件 |
| vim | Enable silent mode (when in ex mode), or Read Normal mode commands from file | 启用静默模式（在 Ex 模式下），或从文件读取普通模式命令 |
| vim | Ex mode (like 'ex') | Ex 模式（类似 'ex'） |
| vim | Execute <command> after loading the first file | 在加载第一个文件后执行 <command> |
| vim | Execute <command> before loading any vimrc file | 在加载任何 vimrc 文件前执行 <command> |
| vim | Exit if input or output is not a terminal | 输入或输出不是终端时退出 |
| vim | Improved Ex mode | 改进的 Ex 模式 |
| vim | Like -o but split vertically | 类似 -o，但垂直分割 |
| vim | Lisp mode | Lisp 模式 |
| vim | Modifications (writing files) not allowed | 不允许修改（写入文件） |
| vim | Modifications in text not allowed | 不允许修改文本 |
| vim | No swap file, use memory only | 不使用交换文件，仅使用内存 |
| vim | Not fully Vi compatible: 'nocompatible' | 不完全兼容 Vi：'nocompatible' |
| vim | Open N tab pages (default: one for each file) | 打开 N 个标签页（默认：每个文件一个） |
| vim | Open N windows (default: one for each file) | 打开 N 个窗口（默认：每个文件一个） |
| vim | Print Help message and exit | 显示帮助信息并退出 |
| vim | Readonly mode (like 'view') | 只读模式（类似 'view'） |
| vim | Recover crashed session if filename is specified, otherwise list swap files and exit | 若指定文件名则恢复崩溃的会话，否则列出交换文件并退出 |
| vim | Restricted mode (like 'rvim') | 受限模式（类似 'rvim'） |
| vim | Same as -r | 与 -r 相同 |
| vim | Set terminal type to <terminal> | 将终端类型设为 <terminal> |
| vim | Skip warning for input/output not being a terminal | 跳过输入/输出不是终端的警告 |
| vim | Source file <session> after loading the first file | 在加载第一个文件后执行会话文件 <session> |
| vim | Start at end of file, if line number is specified, start at that line | 从文件末尾开始；若指定行号，则从该行开始 |
| vim | Use <viminfo> instead of .viminfo | 使用 <viminfo> 代替 .viminfo |
| vim | Use <vimrc> instead of any .vimrc | 使用 <vimrc> 代替任何 .vimrc |
| vim | Vi IMproved, a programmer's text editor | Vi IMproved，程序员的文本编辑器 |
| vim | Vi mode (like 'vi') | Vi 模式（类似 'vi'） |
| vim | Write all typed commands to file <scriptout> | 将所有输入的命令写入文件 <scriptout> |
| vim | Write startup timing messages to <file> | 将启动计时消息写入 <file> |

`zh-TW` is generated from these values with
`node scripts/generate-autocomplete-descriptions-zh-TW.mjs` (OpenCC s2twp), not
edited by hand.

## License notices

The English description strings are derived from `@withfig/autocomplete`, and
the terminology review used `jaywcjlove/linux-command` where available. Both are
MIT licensed: Copyright (c) 2021 Hercules Labs Inc. (Fig); Copyright © 2019
小弟调调™. The full MIT text is preserved in
`docs/research/autocomplete-descriptions-touch.md#license-notices`.
