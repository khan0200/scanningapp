const express = require('express');
const cors = require('cors');
const path = require('path');
const { getWiaScanners, scanWia, abortWiaScan } = require('./services/wiaScanner');
const { getTwainScanners, scanTwain } = require('./services/twainScanner');
const { saveSession, loadSession, clearSession } = require('./services/sessionManager');
const { hasNaps2, scanNaps2 } = require('./services/naps2Scanner');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ limit: '150mb', extended: true }));

// Serve frontend static files with no-cache headers for reliable development updates
app.use(express.static(path.join(__dirname, '../frontend'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

/**
 * GET /session/pages
 * Returns temporary session pages for refresh recovery
 */
app.get('/session/pages', (req, res) => {
  const pages = loadSession();
  res.json({ success: true, pages });
});

/**
 * POST /session/pages
 * Saves current pages to temporary disk cache
 */
app.post('/session/pages', (req, res) => {
  const pages = req.body.pages || [];
  saveSession(pages);
  res.json({ success: true, count: pages.length });
});

/**
 * POST /session/clear
 * Clears temporary disk session cache
 */
app.post('/session/clear', (req, res) => {
  clearSession();
  res.json({ success: true, message: 'Temporary session cache cleared.' });
});

/**
 * GET /scanners
 * Enumerates all installed WIA and TWAIN scanners
 */
app.get('/scanners', async (req, res) => {
  try {
    const wiaScanners = await getWiaScanners();
    const twainScanners = await getTwainScanners();

    let combined = [...wiaScanners, ...twainScanners];

    // Ensure Canon PIXMA G3410 entry is present if no devices detected yet
    if (combined.length === 0) {
      combined = [
        {
          id: 'wia:canon_g3410_default',
          name: 'Canon PIXMA G3410 (WIA Auto)',
          type: 'WIA'
        }
      ];
    }

    res.json(combined);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /scan
 * Initiates document scan with parameters: { scannerId, dpi, colorMode, source, paperSize }
 * Automatically tries WIA first, then falls back to TWAIN
 */
app.post('/scan', async (req, res) => {
  const { scannerId, scannerName, dpi, colorMode, source, paperSize } = req.body;

  console.log(`[Scan Request] Scanner: ${scannerId} (${scannerName}), DPI: ${dpi}, Mode: ${colorMode}, Source: ${source}, Paper: ${paperSize}`);

  // 1. High-Performance Scan Engine: NAPS2 (if available)
  if (hasNaps2()) {
    try {
      console.log('[Scan] NAPS2 is installed. Executing scan via NAPS2.Console.exe...');
      const napsResult = await scanNaps2({ scannerId, scannerName, dpi, colorMode, source, paperSize });
      if (napsResult && (napsResult.success || napsResult.cancelled)) {
        return res.json(napsResult);
      } else {
        console.warn('[Scan] NAPS2 scan returned failure, falling back:', napsResult?.error);
      }
    } catch (err) {
      console.warn('[Scan] NAPS2 scan failed to execute:', err.message);
    }
  }

  // 2. Fallback 1: Native C# WIA
  try {
    const wiaResult = await scanWia({ scannerId, dpi, colorMode, source, paperSize });
    if (wiaResult && wiaResult.success && wiaResult.pages && wiaResult.pages.length > 0) {
      return res.json(wiaResult);
    }
  } catch (err) {
    console.warn('[Scan] WIA primary scan failed:', err.message);
  }

  // Fallback Scan Engine: TWAIN
  try {
    console.log('[Scan] WIA failed or unavailable. Attempting TWAIN fallback...');
    const twainResult = await scanTwain({ scannerId, dpi, colorMode, source, paperSize });
    return res.json(twainResult);
  } catch (twainErr) {
    return res.status(500).json({
      success: false,
      error: `Hardware Scan Failure: ${twainErr.message}. Check Canon printer USB connection & power.`
    });
  }
});

/**
 * POST /scan/cancel
 * Aborts active scanner process
 */
app.post('/scan/cancel', (req, res) => {
  console.log('[Scan Cancel] Received scan abort request...');
  try {
    abortWiaScan();
  } catch (e) {}
  res.json({ success: true, message: 'Scan abort signal sent.' });
});

// Start Node Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` NAPS2 Web Document Scanner Native Server`);
  console.log(` Server URL: http://localhost:${PORT}`);
  console.log(` API Endpoint: http://localhost:${PORT}/scan`);
  console.log(` Session Recovery: Enabled (backend/temp_session)`);
  console.log(` Hardware Engine: WIA Primary + TWAIN Fallback`);
  console.log(`====================================================`);
});
