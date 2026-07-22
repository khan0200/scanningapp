const http = require('http');
const { exec } = require('child_process');
const path = require('path');

const PORT = 8181;

// PowerShell script to execute WIA scan from connected hardware scanner (Canon G3410)
const psScript = `
$ErrorActionPreference = 'Stop'
try {
    $wia = New-Object -ComObject WIA.CommonDialog
    # ShowAcquireImage(DeviceType=1 (Scanner), Intent=1 (Color), Bias=0, Format=JPEG)
    $file = $wia.ShowAcquireImage(1, 1, 0, "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}", $true, $false, $false)
    if ($null -ne $file) {
        $tempPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "canon_scan_" + [Guid]::NewGuid().ToString() + ".jpg")
        if (Test-Path $tempPath) { Remove-Item $tempPath -Force }
        $file.SaveFile($tempPath)
        $bytes = [System.IO.File]::ReadAllBytes($tempPath)
        $base64 = [Convert]::ToBase64String($bytes)
        Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
        Write-Output "SUCCESS:$base64"
    } else {
        Write-Output "CANCELLED"
    }
} catch {
    Write-Output ("ERROR:" + $_.Exception.Message)
}
`;

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ready', scanner: 'Windows WIA Canon G3410 Bridge' }));
    return;
  }

  if (req.url === '/scan') {
    console.log('[Scanner Bridge] Initiating hardware scan request via Windows WIA...');

    // Base64 encode PS command to avoid escape issues
    const encodedPs = Buffer.from(psScript, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedPs}`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      const output = stdout ? stdout.trim() : '';

      if (error || output.startsWith('ERROR:')) {
        const errMsg = output.replace('ERROR:', '') || (error ? error.message : 'Unknown scan error');
        console.error('[Scanner Bridge Error]:', errMsg);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: errMsg }));
        return;
      }

      if (output.startsWith('CANCELLED')) {
        console.log('[Scanner Bridge] Scan dialog cancelled by user.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, cancelled: true }));
        return;
      }

      if (output.startsWith('SUCCESS:')) {
        const base64Data = output.replace('SUCCESS:', '');
        const dataUrl = `data:image/jpeg;base64,${base64Data}`;
        console.log('[Scanner Bridge] Scan completed successfully!');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, dataUrl }));
        return;
      }

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unexpected output: ' + output }));
    });

    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` NAPS2 Web Hardware Scanner Bridge Running`);
  console.log(` Port: http://localhost:${PORT}`);
  console.log(` Ready to scan from Canon G3410 / Windows Scanners`);
  console.log(`====================================================`);
});
