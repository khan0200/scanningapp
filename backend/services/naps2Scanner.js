const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const NAPS2_PATH = 'C:\\Program Files\\NAPS2\\NAPS2.Console.exe';
const NAPS2_PATH_X86 = 'C:\\Program Files (x86)\\NAPS2\\NAPS2.Console.exe';

function getNaps2Path() {
  if (fs.existsSync(NAPS2_PATH)) return NAPS2_PATH;
  if (fs.existsSync(NAPS2_PATH_X86)) return NAPS2_PATH_X86;
  return null;
}

function hasNaps2() {
  return getNaps2Path() !== null;
}

async function listNaps2Devices(driver) {
  return new Promise((resolve) => {
    const napsPath = getNaps2Path();
    if (!napsPath) return resolve([]);
    exec(`"${napsPath}" --driver ${driver} --listdevices`, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const devices = stdout.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      resolve(devices);
    });
  });
}

async function resolveNaps2DeviceName(driver, scannerId, scannerName) {
  const napsDevices = await listNaps2Devices(driver);
  if (napsDevices.length === 0) {
    return scannerName || scannerId.replace(`${driver}:`, '');
  }

  // Normalize friendly name by removing driver types, auto flags, and brackets/braces
  const cleanScannerName = (scannerName || '')
    .replace(/\s*\[(WIA|TWAIN)\]\s*$/i, '')
    .replace(/\s*\((WIA|TWAIN)\s*Auto\)\s*$/i, '')
    .replace(/\s*\((WIA|TWAIN)\)\s*$/i, '')
    .trim()
    .toLowerCase();

  // 1. Exact case-insensitive match
  let match = napsDevices.find(d => d.toLowerCase() === cleanScannerName);
  if (match) return match;

  // 2. Substring match (either device contains cleanScannerName, or cleanScannerName contains device)
  match = napsDevices.find(d => {
    const dl = d.toLowerCase();
    return cleanScannerName.includes(dl) || dl.includes(cleanScannerName);
  });
  if (match) return match;

  // 3. Cross-driver TWAIN matching (fallback to WIA friendly name lookup if driver is TWAIN)
  if (driver === 'twain') {
    try {
      const { getWiaScanners } = require('./wiaScanner');
      const wiaScanners = await getWiaScanners();
      for (const wiaSc of wiaScanners) {
        const wiaName = wiaSc.name.toLowerCase();
        const twainMatch = napsDevices.find(d => {
          const dl = d.toLowerCase();
          return wiaName.includes(dl) || dl.includes(wiaName);
        });
        if (twainMatch) return twainMatch;
      }
    } catch (e) {
      console.warn('[resolveNaps2DeviceName] Failed to check WIA scanners for TWAIN matching:', e);
    }
  }

  // 4. Default to first NAPS2 device
  return napsDevices[0];
}

async function scanNaps2(params = {}) {
  const napsPath = getNaps2Path();
  if (!napsPath) {
    return { success: false, error: 'NAPS2 is not installed.' };
  }

  const sessionDir = path.join(
    process.env.TEMP || 'C:\\Windows\\Temp',
    'naps2_scan_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7)
  );
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const scannerId = params.scannerId || '';
  const scannerName = params.scannerName || '';
  let driver = 'wia';

  if (scannerId.startsWith('twain:')) {
    driver = 'twain';
  } else if (scannerId.startsWith('wia:')) {
    driver = 'wia';
  } else {
    if (scannerId.toLowerCase().includes('twain')) {
      driver = 'twain';
    }
  }

  const deviceName = await resolveNaps2DeviceName(driver, scannerId, scannerName);

  const dpi = parseInt(params.dpi, 10) || 300;
  
  let bitdepth = 'color';
  if (params.colorMode === 'Grayscale' || params.colorMode === 'Gray') {
    bitdepth = 'gray';
  } else if (params.colorMode === 'Black & White' || params.colorMode === 'BW') {
    bitdepth = 'bw';
  }

  let sourceVal = 'glass';
  if (params.source === 'ADF' || params.source === 'Feeder') {
    sourceVal = 'feeder';
  }

  let paperSizeVal = 'a4';
  if (params.paperSize === 'Letter') {
    paperSizeVal = 'letter';
  } else if (params.paperSize === 'Legal') {
    paperSizeVal = 'legal';
  }

  const outputPattern = path.join(sessionDir, 'page_$(nnnn).jpg');
  
  const args = [
    `--driver ${driver}`,
    `--device "${deviceName}"`,
    `--dpi ${dpi}`,
    `--bitdepth ${bitdepth}`,
    `--source ${sourceVal}`,
    `--pagesize ${paperSizeVal}`,
    `--output "${outputPattern}"`
  ];

  const cmd = `"${napsPath}" ${args.join(' ')}`;
  console.log('[NAPS2 Executing command]:', cmd);

  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      try {
        if (error) {
          console.error('[NAPS2 Scan Error]:', stderr || error.message);
          resolve({ success: false, error: (stderr || error.message).trim() });
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
          return;
        }

        const files = fs.readdirSync(sessionDir).sort();
        const pages = [];
        
        for (const file of files) {
          if (file.endsWith('.jpg')) {
            const filePath = path.join(sessionDir, file);
            const data = fs.readFileSync(filePath);
            const base64 = data.toString('base64');
            pages.push('data:image/jpeg;base64,' + base64);
          }
        }

        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}

        if (pages.length === 0) {
          resolve({ success: false, cancelled: true });
        } else {
          resolve({ success: true, method: 'NAPS2', pages });
        }
      } catch (err) {
        resolve({ success: false, error: 'Failed to process NAPS2 scan output: ' + err.message });
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
      }
    });
  });
}

module.exports = {
  hasNaps2,
  scanNaps2
};
