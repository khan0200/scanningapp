const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Discover installed TWAIN data sources from Windows registry & system folders
 */
async function getTwainScanners() {
  return new Promise((resolve) => {
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$twainDir = "C:\\Windows\\twain_32"
$scanners = @()

if (Test-Path $twainDir) {
    $folders = Get-ChildItem $twainDir -Directory
    foreach ($f in $folders) {
        $scanners += [PSCustomObject]@{
            id = "twain:" + $f.Name
            name = $f.Name + " (TWAIN)"
            type = "TWAIN"
        }
    }
}

if ($scanners.Count -eq 0) {
    Write-Output "[]"
} else {
    $scanners | ConvertTo-Json -Compress
}
`;

    const encodedPs = Buffer.from(psScript, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedPs}`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout) => {
      try {
        const output = stdout ? stdout.trim() : '[]';
        const parsed = JSON.parse(output);
        const scanners = Array.isArray(parsed) ? parsed : [parsed];
        resolve(scanners.filter(s => s && s.id));
      } catch (err) {
        resolve([]);
      }
    });
  });
}

/**
 * Scan via TWAIN fallback interface
 */
async function scanTwain(params = {}) {
  return new Promise((resolve) => {
    // TWAIN execution dialog fallback via Windows CommonDialog
    const psScript = `
$ErrorActionPreference = 'Stop'
$tempPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "twain_scan_" + [Guid]::NewGuid().ToString() + ".jpg")

try {
    $wia = New-Object -ComObject WIA.CommonDialog
    # ShowAcquireImage(DeviceType=1 (Scanner), Intent=1, Bias=0)
    $file = $wia.ShowAcquireImage(1, 1, 0, "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}", $true, $false, $false)
    if ($null -ne $file) {
        if (Test-Path $tempPath) { Remove-Item $tempPath -Force }
        $file.SaveFile($tempPath)
        $bytes = [System.IO.File]::ReadAllBytes($tempPath)
        $base64 = [Convert]::ToBase64String($bytes)
        Remove-Item $tempPath -Force -ErrorAction SilentlyContinue

        $outObj = [PSCustomObject]@{
            success = $true
            method = "TWAIN"
            pages = @("data:image/jpeg;base64," + $base64)
        }
        $outObj | ConvertTo-Json -Compress
    } else {
        Write-Output "CANCELLED"
    }
} catch {
    Write-Output ("ERROR:TWAIN_FAILED: " + $_.Exception.Message)
}
`;

    const encodedPs = Buffer.from(psScript, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedPs}`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout) => {
      const output = stdout ? stdout.trim() : '';

      if (output.startsWith('CANCELLED')) {
        resolve({ success: false, cancelled: true });
        return;
      }

      if (output.startsWith('ERROR:')) {
        resolve({ success: false, error: output.replace('ERROR:', '') });
        return;
      }

      try {
        const jsonStart = output.indexOf('{');
        if (jsonStart >= 0) {
          resolve(JSON.parse(output.substring(jsonStart)));
        } else {
          resolve({ success: false, error: 'Failed TWAIN scan acquisition.' });
        }
      } catch (err) {
        resolve({ success: false, error: 'TWAIN parse error: ' + output });
      }
    });
  });
}

module.exports = {
  getTwainScanners,
  scanTwain
};
