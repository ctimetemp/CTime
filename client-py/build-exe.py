"""Build a self-contained Windows executable for the Python agent.

    python client-py/build-exe.py
    python client-py/build-exe.py --name CTTImeAgent.exe --out dist

PyInstaller packs the interpreter and this project's modules into one file; the PowerShell probes
(capture, clipboard, DPAPI) are bundled beside the code because they are the audited capture path.
The readable .py and .ps1 sources are bundled too, under _source, so a device user or an antivirus
analyst can open what the binary actually runs instead of taking the build on trust.

The window stays a console window. There is no --noconsole build here: an agent that opens no
window and appears in no task list is the failure mode QODER.md forbids.
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PACKAGE = os.path.join(HERE, "CTTIme_agent")
ENTRY = os.path.join(HERE, "__main__.py")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_files():
    out = [(ENTRY, "__main__.py")]
    for dirpath, dirs, files in os.walk(PACKAGE):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in files:
            if name.endswith((".py", ".ps1")):
                full = os.path.join(dirpath, name)
                out.append((full, os.path.relpath(full, HERE).replace("\\", "/")))
    return sorted(out, key=lambda pair: pair[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=os.path.join(ROOT, "dist"))
    parser.add_argument("--name", default="CTTImeAgent.exe")
    parser.add_argument("--onedir", action="store_true",
                        help="emit a folder instead of one file (faster start, no temp unpacking)")
    args = parser.parse_args()

    try:
        import PyInstaller
    except ImportError:
        sys.stderr.write("! PyInstaller is not installed in this interpreter.\n"
                         "    python -m pip install pyinstaller\n"
                         "  It is a build-time tool only: nothing it installs is needed on a device,\n"
                         "  and the agent itself stays standard-library only.\n")
        return 1

    pair = ";" if os.name == "nt" else ":"
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--console", "--name", args.name,
        "--distpath", args.out,
        "--workpath", os.path.join(ROOT, ".tmp", "pyi-build"),
        "--specpath", os.path.join(ROOT, ".tmp", "pyi-build"),
        "--paths", HERE,
        "--add-data", os.path.join(PACKAGE, "probes") + pair + "CTTIme_agent/probes",
    ]
    for full, rel in source_files():
        cmd += ["--add-data", f"{full}{pair}_source/{os.path.dirname(rel)}"]
    cmd += ["--onedir" if args.onedir else "--onefile", ENTRY]

    print(f"building {os.path.join(args.out, args.name)} "
          f"({len(source_files())} source files bundled)")
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.stderr.write("! PyInstaller failed\n")
        return result.returncode

    exe = os.path.join(args.out, args.name)
    if not os.path.exists(exe):
        sys.stderr.write(f"! build reported success but {exe} is not there\n")
        return 1

    digest = sha256(exe)
    with open(f"{exe}.sha256", "w", encoding="utf8", newline="\n") as handle:
        handle.write(f"{digest}  {args.name}\n")
    manifest = os.path.join(args.out, "PACKAGED-FILES-PYTHON.txt")
    with open(manifest, "w", encoding="utf8", newline="\n") as handle:
        handle.write("CTTIme Python agent build\n")
        handle.write(f"built at   {datetime.now(timezone.utc).isoformat()}\n")
        handle.write(f"python     {sys.version.split()[0]} ({sys.executable})\n")
        handle.write(f"PyInstaller {PyInstaller.__version__}\n")
        handle.write(f"executable {args.name} ({os.path.getsize(exe)} bytes)\n")
        handle.write(f"sha256     {digest}\n\n")
        handle.write("Source bundled inside the executable under _source, readable as written.\n\n")
        for full, rel in source_files():
            handle.write(f"{os.path.getsize(full):>10}  {sha256(full)}  {rel}\n")

    shutil.rmtree(os.path.join(ROOT, ".tmp", "pyi-build"), ignore_errors=True)
    print(f"\nbuilt {args.name}  {os.path.getsize(exe) / 1048576:.1f} MB")
    print(f"  sha256   {digest}")
    print(f"  manifest {manifest}")
    print("\nrun it on a device (no Python needed there):")
    print(f"  {args.name} check --host <collector-ip> --pin <64-hex>")
    print(f"  {args.name} run --host <collector-ip> --pin <64-hex> --interactive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
