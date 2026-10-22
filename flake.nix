{
  description = "netBae: a self-hosted dashboard for your home internet connection";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      # netBae (personal-use licence) and the Ookla Speedtest CLI aren't free software: using this flake's
      # packages allows those two, and nothing else, in the package set they're built with
      pkgsFor = system: import nixpkgs {
        inherit system;
        config.allowUnfreePredicate = p: builtins.elem (lib.getName p) [ "netbae" "ookla-speedtest" ];
      };
      forAllSystems = f: lib.genAttrs systems (system: f (pkgsFor system));
    in
    {
      packages = forAllSystems (pkgs: rec {
        netbae = pkgs.callPackage ./nix/package.nix { };
        ookla-speedtest = pkgs.ookla-speedtest;
        default = netbae;
      });

      # services.netbae, using this flake's packages
      nixosModules.default = { pkgs, lib, ... }:
        let p = self.packages.${pkgs.stdenv.hostPlatform.system}; in {
          imports = [ ./nix/module.nix ];
          services.netbae.package = lib.mkDefault p.netbae;
          services.netbae.speedtestPackage = lib.mkDefault p.ookla-speedtest;
        };
      nixosModules.netbae = self.nixosModules.default;

      overlays.default = final: prev: { netbae = final.callPackage ./nix/package.nix { }; };

      # nix flake check: the package, and a NixOS VM test of the service (needs KVM)
      checks = lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
        netbae = self.packages.${system}.netbae;
        nixos = import ./nix/test.nix { pkgs = pkgsFor system; module = self.nixosModules.default; };
      });
    };
}
