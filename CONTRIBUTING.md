# Contributing to netBae

Pull requests are welcome, from bug fixes and new monitoring targets to UI tweaks and docs.

## Getting started

```bash
git clone https://github.com/jchin14/netBae.git
cd netBae
cp config.toml local.toml        # set [storage] database to a writable path and [web] port to e.g. 8099
python3 app/netbae.py -c local.toml -v
```

netBae is plain Python 3 (standard library only) plus a static HTML/JS dashboard. There's no build step and nothing to install. Use Python 3.11+ (or 3.8+ with `tomli`); on macOS that means Homebrew's or python.org's `python3`, since the system one is older.

## Before opening a PR

- Keep it dependency-free: standard-library Python only, and no npm/build tooling for the frontend.
- Check the dashboard at desktop and phone widths.
- If you change the installer, it must keep working on Debian/Ubuntu/Raspberry Pi OS and macOS, and ideally on Fedora/Arch too. Windows has its own installer (`install.ps1`, plus `uninstall.ps1` and `bin/netbae.ps1`/`netbae.cmd`); keep the two in step when you add an install feature. The PowerShell scripts must run in the Windows PowerShell 5.1 that ships with Windows (no `??`, ternaries or other PowerShell 7-only syntax) and stay ASCII-only.
- System stats read `/proc` and `/sys` on Linux, `sysctl`/`vm_stat`/Mach calls on macOS and kernel32/the registry (via `ctypes`/`winreg`) on Windows; keep all three paths working. Anything that shells out (`ping`, `route`) has a Windows variant too.
- Run `bash -n install.sh` and `python3 -m py_compile app/netbae.py` before submitting.

## Licence

netBae is free for personal use but is **not** open source in the OSI sense; see [LICENSE](LICENSE). By opening a pull request, you agree your contribution is licensed under the same terms, including section 5 (the maintainer may relicense contributions, for example when granting commercial permission).

For commercial use, use at an educational institution, or selling netBae, please [open an issue](https://github.com/jchin14/netBae/issues) to ask first.
