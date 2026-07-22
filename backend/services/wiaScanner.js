const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * List all installed WIA scanners on Windows
 */
async function getWiaScanners() {
  return new Promise((resolve) => {
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
try {
    $devMgr = New-Object -ComObject WIA.DeviceManager
    $list = @()
    foreach ($info in $devMgr.DeviceInfos) {
        if ($info.Type -eq 1) {
            $name = $info.Properties.Item("Name").Value
            $list += [PSCustomObject]@{
                id = "wia:" + $info.DeviceID
                name = $name
                type = "WIA"
                deviceId = $info.DeviceID
            }
        }
    }
    if ($list.Count -eq 0) {
        Write-Output "[]"
    } else {
        $list | ConvertTo-Json -Compress
    }
} catch {
    Write-Output "[]"
}
`;

    const encodedPs = Buffer.from(psScript, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedPs}`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
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
 * Perform WIA Scan with specified parameters
 */
async function scanWia(params = {}) {
  return new Promise((resolve) => {
    const dpi = parseInt(params.dpi, 10) || 300;
    const colorMode = params.colorMode || 'Color'; // Color, Grayscale, Black & White
    const source = params.source || 'Flatbed';     // Flatbed, ADF
    const paperSize = params.paperSize || 'A4';   // A4, Letter, Auto
    const scannerId = (params.scannerId || '').replace('wia:', '');

    // Map intent & parameters
    let intent = 1; // 1 = Color, 2 = Grayscale, 4 = Black & White (Text)
    if (colorMode === 'Grayscale') intent = 2;
    if (colorMode === 'Black & White' || colorMode === 'BW') intent = 4;

    const psScript = `
$ErrorActionPreference = 'Stop'
$tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "wiascan_" + [Guid]::NewGuid().ToString())
[System.IO.Directory]::CreateDirectory($tempDir) | Out-Null

$scannedFiles = @()

try {
    $devMgr = New-Object -ComObject WIA.DeviceManager
    $device = $null

    $targetId = "${scannerId}"
    if ($targetId -ne "") {
        foreach ($info in $devMgr.DeviceInfos) {
            if ($info.DeviceID -eq $targetId) {
                $device = $info.Connect()
                break
            }
        }
    }

    if ($null -eq $device) {
        # Connect to default scanner
        foreach ($info in $devMgr.DeviceInfos) {
            if ($info.Type -eq 1) {
                $device = $info.Connect()
                break
            }
        }
    }

    if ($null -eq $device) {
        Write-Output "ERROR:NO_SCANNER_CONNECTED: No WIA scanner detected. Check Canon PIXMA G3410 USB/Wi-Fi connection."
        exit
    }

    $item = $device.Items.Item(1)

    # Configure DPI (Horizontal=6147, Vertical=6148)
    try { $item.Properties.Item("6147").Value = ${dpi} } catch {}
    try { $item.Properties.Item("6148").Value = ${dpi} } catch {}

    # Configure Color Intent (DataType=4103 / Intent=6146)
    try { $item.Properties.Item("6146").Value = ${intent} } catch {}

    # Paper Source (Document Handling Select = 3088: 1=Flatbed, 2=Feeder)
    if ("${source}" -eq "ADF") {
        try { $device.Properties.Item("3088").Value = 2 } catch {}
    } else {
        try { $device.Properties.Item("3088").Value = 1 } catch {}
    }

    # Acquire image(s)
    $wiaFormatJPEG = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"
    $dialog = New-Object -ComObject WIA.CommonDialog

    $maxPages = if ("${source}" -eq "ADF") { 50 } else { 1 }
    for ($i = 0; $i -lt $maxPages; $i++) {
        try {
            $image = $item.Transfer($wiaFormatJPEG)
            if ($null -ne $image) {
                $outPath = [System.IO.Path]::Combine($tempDir, "page_$($i + 1).jpg")
                $image.SaveFile($outPath)
                $scannedFiles += $outPath
                if ("${source}" -ne "ADF") { break }
            } else {
                break
            }
        } catch {
            $hresult = $_.Exception.HResult
            # 0x80210003 (-2145320957) is WIA_ERROR_PAPER_EMPTY
            if ($hresult -eq -2145320957 -or $_.Exception.Message -like "*paper empty*") {
                if ($scannedFiles.Count -gt 0) { break } # Finished ADF batch cleanly
                Write-Output "ERROR:PAPER_EMPTY: Automatic Document Feeder is empty. Please load pages."
                exit
            } elseif ($hresult -eq -2145320954 -or $_.Exception.Message -like "*busy*") {
                Write-Output "ERROR:DEVICE_BUSY: Canon G3410 scanner is currently busy in another application."
                exit
            } elseif ($hresult -eq -2145320938 -or $_.Exception.Message -like "*cover*") {
                Write-Output "ERROR:COVER_OPEN: Scanner cover is open. Please close scanner lid."
                exit
            } else {
                if ($scannedFiles.Count -gt 0) { break }
                Write-Output ("ERROR:SCAN_FAILED: " + $_.Exception.Message)
                exit
            }
        }
    }

    if ($scannedFiles.Count -eq 0) {
        Write-Output "CANCELLED"
        exit
    }

    # Convert scanned pages to Base64 JSON array
    $base64Pages = @()
    foreach ($f in $scannedFiles) {
        $b = [System.IO.File]::ReadAllBytes($f)
        $base64Pages += "data:image/jpeg;base64," + [Convert]::ToBase64String($b)
    }

    $outObj = [PSCustomObject]@{
        success = $true
        method = "WIA"
        pages = $base64Pages
    }
    $outObj | ConvertTo-Json -Compress

} catch {
    Write-Output ("ERROR:SYSTEM_EX: " + $_.Exception.Message)
} finally {
    if (Test-Path $tempDir) {
        Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
`;

    const encodedPs = Buffer.from(psScript, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedPs}`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      const output = stdout ? stdout.trim() : '';

      if (output.startsWith('CANCELLED')) {
        resolve({ success: false, cancelled: true });
        return;
      }

      if (output.startsWith('ERROR:')) {
        const parts = output.substring(6).split(':');
        const errCode = parts[0] || 'SCAN_ERROR';
        const errMsg = parts.slice(1).join(':') || 'WIA scan failed';
        resolve({ success: false, code: errCode, error: errMsg });
        return;
      }

      try {
        const jsonStart = output.indexOf('{');
        if (jsonStart >= 0) {
          const parsed = JSON.parse(output.substring(jsonStart));
          resolve(parsed);
        } else {
          resolve({ success: false, error: 'Invalid response from WIA scanner service.' });
        }
      } catch (err) {
        resolve({ success: false, error: 'Failed to parse scan output: ' + output });
      }
    });
  });
}

module.exports = {
  getWiaScanners,
  scanWia
};
