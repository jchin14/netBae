# NixOS VM test (nix flake check, and .github/workflows/nix.yml): the service starts, serves the dashboard
# and Chart.js, doesn't update itself, and the netbae command works. Two machines: one configured with
# settings (as through the flake), one with an editable /etc/netbae/config.toml (as install.sh sets it up).
{ pkgs, module }:

pkgs.testers.runNixOSTest {
  name = "netbae";

  nodes.managed = {
    imports = [ module ];
    services.netbae = {
      enable = true;
      openFirewall = true;
      settings.speedtest.enabled = false; # no internet in the test VMs
    };
    environment.systemPackages = [ pkgs.curl ];
  };

  nodes.installer = {
    imports = [ module ];
    environment.etc."netbae/config.toml".text = ''
      [web]
      port = 8080
      auto_update = "off"
      [storage]
      database = "/var/lib/netbae/netbae.db"
      [speedtest]
      enabled = false
    '';
    services.netbae = {
      enable = true;
      configFile = "/etc/netbae/config.toml";
      port = 8080;
      openFirewall = true;
    };
    environment.systemPackages = [ pkgs.curl ];
  };

  testScript = ''
    import json

    start_all()
    for machine, port in ((managed, 80), (installer, 8080)):
        machine.wait_for_unit("netbae.service")
        machine.wait_for_open_port(port)
        url = f"http://localhost:{port}"
        # (output is checked in Python: piping curl into grep -q fails under pipefail once grep stops reading)
        assert "netBae" in machine.succeed(f"curl -fsS {url}/")
        machine.succeed(f"curl -fsS -o /dev/null {url}/vendor/chart.umd.min.js")
        assert json.loads(machine.succeed(f"curl -fsS {url}/api/update"))["method"] == "nix"
        assert "ping" in json.loads(machine.succeed(f"curl -fsS {url}/api/summary"))
        assert "(Nix)" in machine.succeed("netbae version")
        machine.succeed("netbae status")
        machine.succeed("netbae check")
        # runs as its own user with a state directory, not as root
        assert machine.succeed("systemctl show netbae -p DynamicUser --value").strip() == "yes"
        machine.succeed("test -f /var/lib/netbae/netbae.db")

    assert "services.netbae.settings" in managed.succeed("netbae config")
    # the other machine reaches the dashboard through the firewall
    installer.succeed("curl -fsS -o /dev/null http://managed/")
  '';
}
