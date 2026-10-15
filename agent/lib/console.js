import { spawnSync } from 'node:child_process';

// The resident agent leaves no window on the device user's desktop.
//
// Why this is safe to remove: the window is not one of the discovery surfaces. The named scheduled
// task, plaintext config.json, agent.log and `what-collects` all say the agent is running and are
// untouched here, and the consent gate still cannot be passed without that person's own name. A
// console-subsystem binary also titles its window with the command line, which on this program
// means the collector's PIN sits in a title bar on a shared desktop all day. And `node.exe` is an
// ordinary process name on a machine with a developer on it, so the box tells the user nothing
// they could act on even when they notice it.
//
// Only the scheduled task asks for this, through --resident. A person who runs `run` by hand keeps
// their own window, because hiding it would take over the terminal they are typing in.
//
// `check`, `status`, `what-collects`, `--interactive`, `--verbose` and `--acknowledge-by` never get
// it either: each of those prints its answer at a keyboard, and the notice and its prompt would
// become invisible. Node cannot detach its own console, so the window is hidden through PowerShell,
// the same way the screenshot, clipboard, notifier and DPAPI paths reach the Windows API. The child
// is attached to the console this process already owns, so GetConsoleWindow returns that one window.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace CTTIme -Name ResidentConsole -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
'@
$h = [CTTIme.ResidentConsole]::GetConsoleWindow()
if ($h -eq [IntPtr]::Zero) { 'noconsole'; exit 0 }
# ShowWindow reports whether the window *was* visible, which says nothing about whether hiding it
# took, so the state is read back.
[void][CTTIme.ResidentConsole]::ShowWindow($h, 0)
if ([CTTIme.ResidentConsole]::IsWindowVisible($h)) { 'still-visible'; exit 1 }
'hidden'
`;

export function hideResidentConsole({ log = () => {} } = {}) {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const verdict = String(r.stdout ?? '').trim();
  if (verdict === 'hidden') return true;
  if (verdict === 'noconsole') return false;
  log(`console window left as it was: ${verdict || `powershell exited ${r.status ?? r.error?.message ?? 'unknown'}`}`);
  return false;
}
