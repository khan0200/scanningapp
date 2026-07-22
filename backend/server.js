const express = require('express');
const cors = require('cors');
const path = require('path');
const { getWiaScanners, scanWia } = require('./services/wiaScanner');
const { getTwainScanners, scanTwain } = require('./services/twainScanner');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));
app.use(express.static(path.join(__dirname, '..')));

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
  const { scannerId, dpi, colorMode, source, paperSize } = req.body || {};

  console.log(`[Scan Request] Scanner: ${scannerId || 'Default'}, DPI: ${dpi}, Mode: ${colorMode}, Source: ${source}, Paper: ${paperSize}`);

  try {
    // 1. Try WIA First
    let result = await scanWia({ scannerId, dpi, colorMode, source, paperSize });

    // 2. If WIA failed or returned no scanner, automatically try TWAIN fallback
    if (!result.success && !result.cancelled) {
      console.log('[Scan] WIA failed or unavailable. Attempting TWAIN fallback...');
      const twainResult = await scanTwain({ scannerId, dpi, colorMode, source, paperSize });
      if (twainResult.success) {
        result = twainResult;
      }
    }

    if (result.success) {
      res.json({
        success: true,
        method: result.method || 'WIA',
        pages: result.pages || []
      });
    } else if (result.cancelled) {
      res.json({
        success: false,
        cancelled: true,
        message: 'Scan cancelled by user.'
      });
    } else {
      res.json({
        success: false,
        error: result.error || 'Failed to scan document. Make sure Canon PIXMA G3410 is powered on and connected via USB/Wi-Fi.'
      });
    }
  } catch (err) {
    console.error('[Scan Server Error]:', err);
    res.status(500).json({
      success: false,
      error: 'Hardware scan failed: ' + err.message
    });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` NAPS2 Web Document Scanner Native Server`);
  console.log(` Server URL: http://localhost:${PORT}`);
  console.log(` API Endpoint: http://localhost:${PORT}/scan`);
  console.log(` Hardware Engine: WIA Primary + TWAIN Fallback`);
  console.log(`====================================================`);
});
