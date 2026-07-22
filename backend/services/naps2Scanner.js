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

async function scanNaps2(params = {}) {
  return new Promise((resolve) => {
    const napsPath = getNaps2Path();
    if (!napsPath) {
      resolve({ success: false, error: 'NAPS2 is not installed.' });
      return;
    }

    const sessionDir = path.join(
      process.env.TEMP || 'C:\\Windows\\Temp',
      'naps2_scan_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7)
    );
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const scannerId = params.scannerId || '';
    let driver = 'wia';
    let deviceName = scannerId;

    if (scannerId.startsWith('twain:')) {
      driver = 'twain';
      deviceName = scannerId.replace('twain:', '');
    } else if (scannerId.startsWith('wia:')) {
      driver = 'wia';
      deviceName = scannerId.replace('wia:', '');
    } else {
      if (scannerId.toLowerCase().includes('twain')) {
        driver = 'twain';
      }
    }

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
