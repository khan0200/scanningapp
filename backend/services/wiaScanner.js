const { exec } = require('child_process');
const path = require('path');

const EXECUTABLE = path.join(__dirname, '../bin/wia-scanner.exe');
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
    const scannerId = params.scannerId || '';

    const cmd = `"${EXECUTABLE}" "${scannerId}" ${dpi} "${colorMode}" "${source}"`;

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
