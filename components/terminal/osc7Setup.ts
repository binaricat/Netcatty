export const OSC7_MARKER = "Netcatty OSC 7 cwd tracking";

export const OSC7_SETUP_TARGETS = [
  "~/.bashrc",
  "${ZDOTDIR:-~}/.zshrc",
  "~/.config/fish/config.fish",
] as const;

const DOLLAR = "$";

const POSIX_SETUP_SCRIPT = String.raw`set -eu
marker="# >>> Netcatty OSC 7 cwd tracking >>>"
parent_shell=$(ps -p "$PPID" -o comm= 2>/dev/null | sed "s/^-//" | tr -d "[:space:]")
login_shell=$(basename "${DOLLAR}{SHELL:-sh}" | sed "s/^-//")
shell_name="$login_shell"
case "$parent_shell" in
  bash|zsh|fish) shell_name="$parent_shell" ;;
esac

case "$shell_name" in
  bash) config="$HOME/.bashrc" ;;
  zsh) config="${DOLLAR}{ZDOTDIR:-$HOME}/.zshrc" ;;
  fish) config="${DOLLAR}{XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
  *)
    printf "Netcatty OSC 7 setup: unsupported shell %s\n" "$shell_name" >&2
    printf "Supported shells: bash, zsh, fish\n" >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$config")"
touch "$config"
if grep -F "$marker" "$config" >/dev/null 2>&1; then
  printf "Netcatty OSC 7 cwd tracking is already configured in %s\n" "$config"
else
  case "$shell_name" in
    bash)
      printf "%s\n" \
        "" \
        "# >>> Netcatty OSC 7 cwd tracking >>>" \
        "osc7_cwd() {" \
        '  printf "\033]7;file://%s%s\033\\" "${DOLLAR}{HOSTNAME:-localhost}" "$PWD"' \
        "}" \
        'case ";${DOLLAR}{PROMPT_COMMAND:-};" in' \
        '  *";osc7_cwd;"*) ;;' \
        "  *)" \
        '    if [ -n "${DOLLAR}{PROMPT_COMMAND:-}" ]; then' \
        '      PROMPT_COMMAND="${DOLLAR}{PROMPT_COMMAND}' \
        'osc7_cwd"' \
        "    else" \
        '      PROMPT_COMMAND="osc7_cwd"' \
        "    fi" \
        "    ;;" \
        "esac" \
        "# <<< Netcatty OSC 7 cwd tracking <<<" >> "$config"
      ;;
    zsh)
      printf "%s\n" \
        "" \
        "# >>> Netcatty OSC 7 cwd tracking >>>" \
        "osc7_cwd() {" \
        '  printf "\033]7;file://%s%s\033\\" "${DOLLAR}{HOST:-${DOLLAR}{HOSTNAME:-localhost}}" "$PWD"' \
        "}" \
        'case " ${DOLLAR}{precmd_functions[*]} " in' \
        '  *" osc7_cwd "*) ;;' \
        '  *) precmd_functions+=(osc7_cwd) ;;' \
        "esac" \
        "# <<< Netcatty OSC 7 cwd tracking <<<" >> "$config"
      ;;
    fish)
      printf "%s\n" \
        "" \
        "# >>> Netcatty OSC 7 cwd tracking >>>" \
        "function __netcatty_osc7_cwd --on-event fish_prompt" \
        '    printf "\033]7;file://%s%s\033\\" (hostname 2>/dev/null; or printf localhost) "$PWD"' \
        "end" \
        "# <<< Netcatty OSC 7 cwd tracking <<<" >> "$config"
      ;;
  esac
  printf "Netcatty OSC 7 cwd tracking configured in %s\n" "$config"
fi

host=$(hostname 2>/dev/null || printf localhost)
printf "\033]7;file://%s%s\033\\" "$host" "$PWD"
printf "\nRestart this shell, or open a new one, to keep tracking future directory changes.\n"`;

const quoteForSingleQuotedShellString = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

export const buildOsc7SetupCommand = (): string =>
  `printf "%s\\n" ${quoteForSingleQuotedShellString(POSIX_SETUP_SCRIPT)} | sh\n`;
