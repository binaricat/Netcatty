export const OSC7_MARKER = "Netcatty OSC 7 cwd tracking";

export const OSC7_SETUP_TARGETS = [
  "~/.bashrc",
  "${ZDOTDIR:-~}/.zshrc",
  "~/.config/fish/config.fish",
] as const;

export type Osc7SetupActionContext = {
  protocol?: string;
  isLocalConnection?: boolean;
  isSerialConnection?: boolean;
  isNetworkDevice?: boolean;
};

export const shouldOfferOsc7SetupAction = ({
  protocol,
  isLocalConnection,
  isSerialConnection,
  isNetworkDevice,
}: Osc7SetupActionContext): boolean =>
  !isLocalConnection
  && !isSerialConnection
  && !isNetworkDevice
  && protocol !== "telnet";

const DOLLAR = "$";

const URL_PATH_AWK_SCRIPT = String.raw`BEGIN {
  for (i = 0; i < 256; i++) {
    c = sprintf("%c", i)
    ord[c] = i
  }
}
{
  if (NR > 1) encode("\n")
  for (i = 1; i <= length($0); i++) {
    encode(substr($0, i, 1))
  }
}
function encode(c, o) {
  o = ord[c]
  if ((o >= 48 && o <= 57) || (o >= 65 && o <= 90) || (o >= 97 && o <= 122) || c == "/" || c == "-" || c == "." || c == "_" || c == "~") {
    printf "%s", c
  } else {
    printf "%%%02X", o
  }
}`;

const quoteForSingleQuotedShellString = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

const URL_PATH_AWK_SCRIPT_QUOTED = quoteForSingleQuotedShellString(URL_PATH_AWK_SCRIPT);

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
  zsh) config="${DOLLAR}{NETCATTY_ZDOTDIR:-$HOME}/.zshrc" ;;
  fish) config="${DOLLAR}{NETCATTY_XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
  *)
    printf "Netcatty OSC 7 setup: unsupported shell %s\n" "$shell_name" >&2
    printf "Supported shells: bash, zsh, fish\n" >&2
    exit 2
    ;;
esac

__netcatty_osc7_url_path() {
  printf "%s" "$1" | LC_ALL=C awk ${URL_PATH_AWK_SCRIPT_QUOTED}
}

mkdir -p "$(dirname "$config")"
touch "$config"
if grep -F "$marker" "$config" >/dev/null 2>&1; then
  printf "Netcatty OSC 7 cwd tracking is already configured in %s\n" "$config"
else
  case "$shell_name" in
    bash)
      cat >> "$config" <<'NETCATTY_OSC7_BASH'

# >>> Netcatty OSC 7 cwd tracking >>>
__netcatty_osc7_url_path() {
  printf "%s" "$1" | LC_ALL=C awk '${URL_PATH_AWK_SCRIPT}'
}
osc7_cwd() {
  printf '\033]7;file://%s%s\a' "${DOLLAR}{HOSTNAME:-localhost}" "$(__netcatty_osc7_url_path "$PWD")"
}
case "${DOLLAR}{PROMPT_COMMAND:-}" in
  *osc7_cwd*) ;;
  *)
    if [ -n "${DOLLAR}{PROMPT_COMMAND:-}" ]; then
      PROMPT_COMMAND="${DOLLAR}{PROMPT_COMMAND}
osc7_cwd"
    else
      PROMPT_COMMAND="osc7_cwd"
    fi
    ;;
esac
# <<< Netcatty OSC 7 cwd tracking <<<
NETCATTY_OSC7_BASH
      ;;
    zsh)
      cat >> "$config" <<'NETCATTY_OSC7_ZSH'

# >>> Netcatty OSC 7 cwd tracking >>>
__netcatty_osc7_url_path() {
  printf "%s" "$1" | LC_ALL=C awk '${URL_PATH_AWK_SCRIPT}'
}
osc7_cwd() {
  printf '\033]7;file://%s%s\a' "${DOLLAR}{HOST:-${DOLLAR}{HOSTNAME:-localhost}}" "$(__netcatty_osc7_url_path "$PWD")"
}
if (( ${DOLLAR}{+precmd_functions} )); then
  case " ${DOLLAR}{precmd_functions[*]} " in
    *" osc7_cwd "*) ;;
    *) precmd_functions+=(osc7_cwd) ;;
  esac
else
  precmd_functions=(osc7_cwd)
fi
# <<< Netcatty OSC 7 cwd tracking <<<
NETCATTY_OSC7_ZSH
      ;;
    fish)
      cat >> "$config" <<'NETCATTY_OSC7_FISH'

# >>> Netcatty OSC 7 cwd tracking >>>
function __netcatty_osc7_url_path
    printf "%s" "$argv[1]" | LC_ALL=C awk '${URL_PATH_AWK_SCRIPT}'
end
function __netcatty_osc7_cwd --on-event fish_prompt
    printf '\033]7;file://%s%s\a' (hostname 2>/dev/null; or printf localhost) (__netcatty_osc7_url_path "$PWD")
end
# <<< Netcatty OSC 7 cwd tracking <<<
NETCATTY_OSC7_FISH
      ;;
  esac
  printf "Netcatty OSC 7 cwd tracking configured in %s\n" "$config"
fi

host=$(hostname 2>/dev/null || printf localhost)
printf '\033]7;file://%s%s\a' "$host" "$(__netcatty_osc7_url_path "$PWD")"
printf "\nRestart this shell, or open a new one, to keep tracking future directory changes.\n"`;

export const buildOsc7SetupCommand = (): string =>
  `{ set +u 2>/dev/null || true; printf "%s\\n" ${quoteForSingleQuotedShellString(POSIX_SETUP_SCRIPT)} | env NETCATTY_ZDOTDIR="$ZDOTDIR" NETCATTY_XDG_CONFIG_HOME="$XDG_CONFIG_HOME" sh; }\n`;
