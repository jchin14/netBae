# netBae as a Nix package: the app (Python standard library only), its built-in target list and
# Chart.js, plus a `netbae-server` command. Built by flake.nix; the NixOS module in module.nix runs it.
{
  lib,
  stdenvNoCC,
  fetchurl,
  makeWrapper,
  python3,
  iputils,
  traceroute,
  curl,
  # the same pinned files the Linux/macOS installer downloads (install.sh: CHARTJS_URL, ADAPTER_URL)
  chartjs ? fetchurl {
    url = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
    hash = "sha256-0q+JdOlScWOHcunpUk21uab1jW7C1deBQARHtKMcaB4=";
  },
  chartjsAdapter ? fetchurl {
    url = "https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js";
    hash = "sha256-6nqzDSbDjc8fLSa7Q+c6lFN7WPGQb1XhpUbdCTIbVhU=";
  },
}:

let
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [ ../app ../config.toml ../LICENSE ];
  };
  # VERSION = "x.y.z" near the top of app/netbae.py
  versionLine = lib.findFirst (l: lib.hasPrefix "VERSION = " l) ''VERSION = "0"''
    (lib.splitString "\n" (builtins.readFile ../app/netbae.py));
in
stdenvNoCC.mkDerivation {
  pname = "netbae";
  version = builtins.head (builtins.match ''VERSION = "([^"]+)".*'' versionLine);
  inherit src;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/netbae $out/bin
    cp -r app/. $out/share/netbae/
    rm -rf $out/share/netbae/__pycache__
    install -Dm644 ${chartjs} $out/share/netbae/static/vendor/chart.umd.min.js
    install -Dm644 ${chartjsAdapter} $out/share/netbae/static/vendor/chartjs-adapter-date-fns.bundle.min.js
    install -Dm644 config.toml $out/share/netbae/config.default.toml
    # ping and traceroute come last on PATH, so a system's own (e.g. NixOS's capability-wrapped ping) wins
    substitute ${./netbae.sh} $out/bin/netbae --subst-var-by server $out/bin/netbae-server --subst-var version
    chmod +x $out/bin/netbae
    wrapProgram $out/bin/netbae --suffix PATH : ${lib.makeBinPath [ curl ]}  # for netbae update
    makeWrapper ${python3.interpreter} $out/bin/netbae-server \
      --add-flags $out/share/netbae/netbae.py \
      --suffix PATH : ${lib.makeBinPath [ iputils traceroute ]} \
      --set NETBAE_NIX 1
    runHook postInstall
  '';

  meta = {
    description = "Self-hosted dashboard for your home internet connection: ping, DNS, routes and speedtests";
    homepage = "https://github.com/jchin14/netBae";
    license = lib.licenses.unfreeRedistributable; # free for personal use, may be shared (see LICENSE)
    mainProgram = "netbae-server";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
