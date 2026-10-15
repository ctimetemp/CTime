"""Run the agent as a plain directory: python client-py <command> [options].

Also the entry point the packaged executable is built from (client-py/build-exe.py), because
PyInstaller needs a script rather than a package name.
"""
import sys

from CTTIme_agent.__main__ import entry

if __name__ == "__main__":
    entry()
