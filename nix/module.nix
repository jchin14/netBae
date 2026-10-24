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
  cf = cfg.tunnel.cloudflare;
  tunnelOn = cf.enable || cfg.tunnel.tailscale;
  # your settings on top of what the module needs; everything else uses netBae's own defaults
  settings = lib.recursiveUpdate {
    web = {
      port = cfg.port;
      auto_update = "off"; # updates come from your Nix config, not from netBae itself
    };
    storage.database = "${dataDir}/netbae.db";
    # a tunnel shares the read-only public dashboard, which then only listens on this machine
    public = lib.optionalAttrs tunnelOn { enabled = true; host = "127.0.0.1"; };
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

    startAtBoot = lib.mkOption {
      type = lib.types.bool;
      default = cfg.settings.web.start_at_boot or true;
      defaultText = lib.literalExpression "settings.web.start_at_boot or true";
      description = "Start netBae at boot. Off: it only runs after `netbae start` (or `systemctl start netbae`).";
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

    tunnel = {
      cloudflare = {
        enable = lib.mkEnableOption ''
          a Cloudflare Tunnel to the read-only public dashboard (netbae-tunnel.service). Give either
          `tokenFile` (a tunnel made in the Cloudflare dashboard) or `configFile` and `credentialsFile`
          (a tunnel on your own domain, as `netbae tunnel cloudflare <hostname>` sets up)'';
        tokenFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "/etc/netbae/cloudflared/token";
          description = "File with the tunnel token (a path string, so the secret stays out of the Nix store).";
        };
        configFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "/etc/netbae/cloudflared/config.yml";
          description = "cloudflared's config.yml: the tunnel id and the hostnames that reach the public dashboard.";
        };
        credentialsFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "/etc/netbae/cloudflared/credentials.json";
          description = "The tunnel's credentials.json (a path string, so the secret stays out of the Nix store).";
        };
        package = lib.mkPackageOption pkgs "cloudflared" { };
      };
      tailscale = lib.mkEnableOption ''
        Tailscale, for sharing the public dashboard with Tailscale Funnel (`netbae tunnel tailscale` turns
        the Funnel on)'';
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
    assertions = [{
      assertion = !cf.enable || cf.tokenFile != null || (cf.configFile != null && cf.credentialsFile != null);
      message = "services.netbae.tunnel.cloudflare needs tokenFile, or configFile and credentialsFile";
    }];

    services.tailscale.enable = lib.mkIf cfg.tunnel.tailscale true;

    # the tunnel runs as its own unprivileged user; systemd hands it the secret file
    systemd.services.netbae-tunnel = lib.mkIf cf.enable {
      description = "netBae public dashboard tunnel (Cloudflare)";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" "netbae.service" ];
      serviceConfig = {
        ExecStart = if cf.tokenFile != null
          then "${lib.getExe cf.package} tunnel --no-autoupdate run --token-file %d/token"
          else "${lib.getExe cf.package} tunnel --no-autoupdate --config ${cf.configFile} run --credentials-file %d/credentials.json";
        LoadCredential = if cf.tokenFile != null
          then [ "token:${cf.tokenFile}" ]
          else [ "credentials.json:${cf.credentialsFile}" ];
        DynamicUser = true;
        Restart = "always";
        RestartSec = 5;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" "AF_NETLINK" ];
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
    environment.systemPackages = [ cfg.package ]; # the netbae command

    systemd.services.netbae = {
      description = "netBae internet connection monitor";
      wantedBy = lib.optional cfg.startAtBoot "multi-user.target";
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      path = [ pkgs.iputils pkgs.traceroute ] ++ lib.optional (cfg.speedtestPackage != null) cfg.speedtestPackage
        ++ lib.optional cfg.tunnel.tailscale config.services.tailscale.package; # to see the Funnel's status
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
