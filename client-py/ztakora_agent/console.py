"""Hiding the resident agent's console window.

The agent's discovery surfaces are the named scheduled task, the plaintext ``config.json``,
``agent.log`` and ``what-collects`` -- none of which is a window -- and the consent gate still
needs the device user's own name. A console-subsystem binary also titles its window with the
command line, so on this program the collector's PIN would sit in a title bar on a shared desktop
all day. ``node.exe`` is an ordinary process name on a developer machine, so the box conveys
nothing a user could act on even when they do notice it.

Only the scheduled task asks for this, through ``--resident``. A person who runs ``run`` by hand
keeps their window, because that window is the terminal they are typing in. ``check``, ``status``,
``what-collects``, ``--interactive``, ``--verbose`` and ``--acknowledge-by`` never get it either:
each of those prints its answer at a keyboard, and the notice and its prompt would become
invisible.
"""

import ctypes
import sys

SW_HIDE = 0


def hide_resident_console(log=lambda message: None):
    """Hide the console this process is attached to. Returns False when there is none to hide."""
    if sys.platform != "win32":
        return False
    try:
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if not hwnd:
            # No console at all: nothing was launched from a window, so there is nothing to hide.
            return False
        # ShowWindow reports whether the window *was* visible, which says nothing about whether
        # hiding it took, so the state is read back.
        ctypes.windll.user32.ShowWindow(hwnd, SW_HIDE)
        if ctypes.windll.user32.IsWindowVisible(hwnd):
            log("console window left as it was: the shell refused to hide it")
            return False
        return True
    except Exception as err:  # a window that will not hide must never stop collection
        log(f"console window left as it was: could not hide it ({err})")
        return False
