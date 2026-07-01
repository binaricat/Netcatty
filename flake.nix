{
  description = "Netcatty packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        rec {
          netcatty = pkgs.callPackage ./nix/package.nix { };
          default = netcatty;
        }
      );

      apps = forAllSystems (system: {
        netcatty = {
          type = "app";
          program = "${nixpkgs.lib.getExe self.packages.${system}.netcatty}";
        };
        default = self.apps.${system}.netcatty;
      });
    };
}
