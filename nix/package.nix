{
  appimageTools,
  fetchurl,
  lib,
  release ? import ./release.nix,
  stdenv,
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
in
appimageTools.wrapType2 {
  inherit pname version src;

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
