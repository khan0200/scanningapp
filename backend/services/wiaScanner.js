const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Determine if we are running inside a pkg package
const isPkg = typeof process.pkg !== 'undefined';

let EXECUTABLE = path.join(__dirname, '../bin/wia-scanner.exe');

if (isPkg) {
  // We need to extract the embedded wia-scanner.exe to a temporary directory so Windows can execute it
  const tempDir = path.join(os.tmpdir(), 'scanningapp-bin');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const extractedPath = path.join(tempDir, 'wia-scanner.exe');
  
  try {
    const embeddedPath = path.join(__dirname, '../bin/wia-scanner.exe');
    let copyNeeded = true;
    if (fs.existsSync(extractedPath)) {
      const statExtracted = fs.statSync(extractedPath);
      const statEmbedded = fs.statSync(embeddedPath);
      if (statExtracted.size === statEmbedded.size) {
        copyNeeded = false;
      }
    }
    if (copyNeeded) {
      fs.copyFileSync(embeddedPath, extractedPath);
    }
    EXECUTABLE = extractedPath;
  } catch (err) {
    console.error('Failed to extract wia-scanner.exe:', err);
  }
}

let activeProc = null;

/**
 * List all installed WIA scanners on Windows via native C# engine
 */
async function getWiaScanners() {
  return new Promise((resolve) => {
    exec(`"${EXECUTABLE}" list`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout) => {
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
 * Perform WIA Scan with specified parameters via native C# engine
 */
async function scanWia(params = {}) {
  return new Promise((resolve) => {
    const dpi = parseInt(params.dpi, 10) || 300;
    const colorMode = params.colorMode || 'Color';
    const source = params.source || 'Flatbed';
    const paperSize = params.paperSize || 'A4';
    const scannerId = params.scannerId || '';

    const cmd = `"${EXECUTABLE}" "${scannerId}" ${dpi} "${colorMode}" "${source}" "${paperSize}"`;

    console.log('[Native WIA Scan Executing]:', cmd);

    activeProc = exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      activeProc = null;
      const output = stdout ? stdout.trim() : '';

      try {
        const jsonStart = output.indexOf('{');
        if (jsonStart >= 0) {
          const parsed = JSON.parse(output.substring(jsonStart));
          resolve(parsed);
        } else {
          resolve({ success: false, error: 'Scanner output: ' + (output || error?.message) });
        }
      } catch (err) {
        resolve({ success: false, error: 'Failed to parse scan output: ' + output });
      }
    });
  });
}

/**
 * Abort active scanner process
 */
function abortWiaScan() {
  if (activeProc) {
    try {
      exec(`taskkill /F /PID ${activeProc.pid} /T`);
    } catch (e) {}
    activeProc = null;
  }
}

module.exports = {
  getWiaScanners,
  scanWia,
  abortWiaScan
};
