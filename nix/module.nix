# NixOS module: services.netbae. Use it through the flake (nixosModules.default), or import this file
# directly (that's what install.sh does on NixOS); see "NixOS" in the README.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.netbae;
  # netBae (personal-use licence) and the Ookla Speedtest CLI aren't free software in Nix's sense: build
  # just these two from a package set that allows them, so the system doesn't need allowUnfree
  unfreePkgs = import pkgs.path {
    inherit (pkgs.stdenv.hostPlatform) system;
    config.allowUnfreePredicate = p: builtins.elem (lib.getName p) [ "netbae" "ookla-speedtest" ];
  };
  toml = pkgs.formats.toml { };
  dataDir = "/var/lib/netbae";
  # your settings on top of what the module needs; everything else uses netBae's own defaults
  settings = lib.recursiveUpdate {
    web = {
      port = cfg.port;
      auto_update = "off"; # updates come from your Nix config, not from netBae itself
    };
    storage.database = "${dataDir}/netbae.db";
  } cfg.settings;
  configFile = if cfg.configFile != null then cfg.configFile else toml.generate "netbae.toml" settings;
in
{
  options.services.netbae = {
    enable = lib.mkEnableOption "netBae, a self-hosted dashboard for your home internet connection";

    package = lib.mkOption {
      type = lib.types.package;
      default = unfreePkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "netbae (built from this repository)";
      description = "The netBae package.";
    };

    speedtestPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = unfreePkgs.ookla-speedtest;
      defaultText = lib.literalExpression "pkgs.ookla-speedtest";
      description = "The Ookla Speedtest CLI that runs the speedtests, or null to run without speedtests.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 80;
      description = "Port of the dashboard (also `settings.web.port`).";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the dashboard's port in the firewall, so other devices on your network can reach it.";
    };

    settings = lib.mkOption {
      type = toml.type;
      default = { };
      example = lib.literalExpression ''
        {
          speedtest.interval_minutes = 120;
          ping.extra_targets = [ { name = "My server"; host = "example.com"; group = "Mine"; } ];
          ping.disable = [ "Streaming AU" ];
        }
      '';
      description = ''
        netBae's config.toml as Nix: the same sections and keys as the commented config.toml in the
        repository (and `share/netbae/config.default.toml` in the package). Anything left out uses
        netBae's default.
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/etc/netbae/config.toml";
      description = ''
        Use this config.toml instead of one made from `settings`, e.g. a file you edit by hand. It should set
        `[storage] database` to a file under ${dataDir} and `[web] auto_update = "off"`.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
    environment.systemPackages = [ cfg.package ]; # the netbae command

    systemd.services.netbae = {
      description = "netBae internet connection monitor";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      path = [ pkgs.iputils pkgs.traceroute ] ++ lib.optional (cfg.speedtestPackage != null) cfg.speedtestPackage;
      environment = {
        HOME = dataDir; # the Ookla CLI keeps its accepted-licence file here
        PYTHONUNBUFFERED = "1";
      };
      restartTriggers = [ configFile ];
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} -c ${configFile}";
        DynamicUser = true;
        StateDirectory = "netbae";
        WorkingDirectory = dataDir;
        Restart = "always";
        RestartSec = 5;
        # CAP_NET_RAW for ping, CAP_NET_BIND_SERVICE for port 80, without running as root
        AmbientCapabilities = [ "CAP_NET_RAW" "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = [ "CAP_NET_RAW" "CAP_NET_BIND_SERVICE" ];
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" "AF_NETLINK" ];
        RestrictNamespaces = true;
        LockPersonality = true;
      };
    };
  };
}
