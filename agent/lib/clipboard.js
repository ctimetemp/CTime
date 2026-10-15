import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Clipboard metrics only. The hashing is done INSIDE the PowerShell child process and the only
// thing written to stdout is {char_count, sha256, content_kind}. That is a stronger boundary than
// returning the text to Node and hashing it there: with the hash-first design the clipboard
// content never crosses a process boundary, is never held in the agent's own heap, and cannot be
// logged by an errant console.log in the agent.
//
// There is no code path in this file that can emit clipboard text. If you are tempted to add
// one, see docs/LAWFUL-USE.md and QODER.md non-negotiable 3.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$out = @{ char_count = 0; sha256 = ('0'*64); content_kind = 'empty' }
try {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hex = { param($b) -join ($b | ForEach-Object { $_.ToString('x2') }) }

  if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
    $list = [System.Windows.Forms.Clipboard]::GetFileDropList()
    # -join ([char]10) rather than a backtick-n: this whole script sits inside a JS template
    # literal, and a backtick would terminate it. Join-String is PowerShell 6+ and unavailable.
    $joined = ($list -join ([char]10))
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    $out.content_kind = 'file-list'
    $out.char_count = $joined.Length
    $out.sha256 = (& $hex ($sha.ComputeHash($bytes)))
  }
  elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    $ms = New-Object System.IO.MemoryStream
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose(); $img.Dispose()
    $out.content_kind = 'image'
    $out.char_count = $bytes.Length
    $out.sha256 = (& $hex ($sha.ComputeHash($bytes)))
  }
  elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
    $t = [System.Windows.Forms.Clipboard]::GetText()
    if ([string]::IsNullOrEmpty($t)) {
      $out.content_kind = 'empty'
    } else {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($t)
      $out.content_kind = 'text'
      # char_count is characters, sha256 is over the UTF-8 encoding. Both derive from the same
      # in-memory buffer and neither leaves this process.
      $out.char_count = $t.Length
      $out.sha256 = (& $hex ($sha.ComputeHash($bytes)))
    }
  }
} catch {
  $out.content_kind = 'empty'
}
$out | ConvertTo-Json -Compress
`;

const KINDS = new Set(['text', 'file-list', 'image', 'empty']);

export function createClipboardSampler({ workDir, onWarn = () => {} }) {
  mkdirSync(workDir, { recursive: true });
  const scriptPath = path.join(workDir, 'clipboard-probe.ps1');
  writeFileSync(scriptPath, SCRIPT, 'utf8');

  return async function sample(timeoutMs = 12000) {
    const r = await run(scriptPath, timeoutMs);
    if (!r.ok) {
      onWarn(`clipboard probe failed: ${r.error}`);
      return null;
    }
    const { char_count, sha256, content_kind } = r.value;
    // Belt and braces: the script can only ever output these three fields, but the sampler
    // re-asserts that nothing resembling content survives into the returned object.
    if (r.rawKeys.some((k) => !['char_count', 'sha256', 'content_kind'].includes(k.toLowerCase()))) {
      onWarn('clipboard probe returned unexpected keys; discarding sample');
      return null;
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
    if (!Number.isInteger(char_count) || char_count < 0) return null;
    if (!KINDS.has(content_kind)) return null;
    return { char_count, sha256, content_kind };
  };
}

function run(scriptPath, timeoutMs) {
  return new Promise((resolveP) => {
    const child = spawn('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveP({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (code !== 0 && !text) { resolveP({ ok: false, error: stderr.slice(0, 200) || `exit ${code}` }); return; }
      try {
        const value = JSON.parse(text);
        resolveP({ ok: true, value, rawKeys: Object.keys(value) });
      } catch (err) {
        // Never echo the unparsed output: if the probe ever regressed and printed content, this is
        // exactly the place a leak would appear.
        resolveP({ ok: false, error: `unparseable probe output (${err.message})` });
      }
    });
  });
}

export const EMPTY_HASH = createHash('sha256').update('').digest('hex');
