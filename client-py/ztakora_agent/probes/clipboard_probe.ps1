$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$out = @{ char_count = 0; sha256 = ('0' * 64); content_kind = 'empty' }
try {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hex = { param($b) -join ($b | ForEach-Object { $_.ToString('x2') }) }

  if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
    $list = [System.Windows.Forms.Clipboard]::GetFileDropList()
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
