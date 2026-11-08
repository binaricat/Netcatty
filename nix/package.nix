{
  appimageTools,
  fetchurl,
  lib,
  openssh,
  release ? import ./release.nix,
  stdenv,
  writeShellScriptBin,
}:

let
  pname = "netcatty";
  inherit (release) sources version;

  source =
    sources.${stdenv.hostPlatform.system}
      or (throw "Netcatty AppImage packages are available for x86_64-linux and aarch64-linux only.");

  src = fetchurl {
    url = "https://github.com/binaricat/Netcatty/releases/download/v${version}/Netcatty-${version}-linux-${source.appImageArch}.AppImage";
    inherit (source) hash;
  };

  appimageContents = appimageTools.extractType2 {
    inherit pname version src;
  };

  # home-manager's ~/.ssh/config is a root-owned symlink into the nix store.
  # Unprivileged bwrap (wrapType2 / buildFHSEnv) maps only the caller uid, so
  # that file appears as overflowuid 65534 and OpenSSH refuses the default
  # user config with "Bad owner or permissions". A -F path skips that check.
  # The wrapper is injected via extraPkgs so it lands on the FHS /usr/bin,
  # which buildFHSEnv prepends ahead of any bind-mounted host profile PATH.
  sshWrapped = writeShellScriptBin "ssh" ''
    real_ssh="${openssh}/bin/ssh"
    config="''${HOME}/.ssh/config"
    if [ -e "$config" ]; then
      owner="$(stat -c %u -L "$config" 2>/dev/null || true)"
      me="$(id -u)"
      if [ -n "$owner" ] && [ "$owner" != "$me" ] && [ "$owner" != 0 ]; then
        cache="''${XDG_CACHE_HOME:-$HOME/.cache}/netcatty"
        snap="$cache/ssh_config"
        mkdir -p "$cache"
        # Always refresh: nix store files have frozen old mtimes, so -nt
        # never sees a newer home-manager generation after the first copy.
        # Publish via a unique staging file + mv so a concurrent ssh -F
        # reader never sees a truncated snapshot (cp truncates first).
        snap_tmp="$snap.tmp.$$"
        cp -L "$config" "$snap_tmp"
        chmod 600 "$snap_tmp"
        mv -f "$snap_tmp" "$snap"
        exec "$real_ssh" -F "$snap" "$@"
      fi
    fi
    exec "$real_ssh" "$@"
  '';
in
appimageTools.wrapType2 {
  inherit pname version src;

  extraPkgs = pkgs: [ sshWrapped ];

  extraInstallCommands = ''
    desktopSource="$(find ${appimageContents} -maxdepth 3 -name '*.desktop' -print -quit)"
    if [ -n "$desktopSource" ]; then
      desktopFile="$out/share/applications/netcatty.desktop"
      install -Dm444 "$desktopSource" "$desktopFile"
      substituteInPlace "$desktopFile" \
        --replace "Exec=AppRun" "Exec=netcatty" \
        --replace "Exec=Netcatty" "Exec=netcatty"
    fi

    if [ -d "${appimageContents}/usr/share/icons" ]; then
      mkdir -p "$out/share"
      cp -r "${appimageContents}/usr/share/icons" "$out/share/"
    fi
  '';

  meta = {
    description = "Modern SSH client and terminal manager";
    homepage = "https://github.com/binaricat/Netcatty";
    license = lib.licenses.gpl3Plus;
    mainProgram = "netcatty";
    platforms = builtins.attrNames sources;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
