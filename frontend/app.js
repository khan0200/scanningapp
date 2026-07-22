/**
 * NAPS2 Web Document Scanner - Bootstrap 5 Edition Controller
 */

class DocumentPage {
  constructor(id, dataUrl, width, height, dpi) {
    this.id = id || 'page_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    this.dataUrl = dataUrl;
    this.width = width || 800;
    this.height = height || 1130;
    this.rotation = 0; // 0, 90, 180, 270 degrees
    this.dpi = dpi || 300; // Default to 300 DPI
  }

  rotate(delta) {
    this.rotation = (this.rotation + delta + 360) % 360;
  }
}

class ImageProcessor {
  static getRotatedDataUrl(dataUrl, rotation) {
    return new Promise((resolve) => {
      if (rotation === 0) {
        resolve(dataUrl);
        return;
      }

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (rotation === 90 || rotation === 270) {
          canvas.width = img.height;
          canvas.height = img.width;
        } else {
          canvas.width = img.width;
          canvas.height = img.height;
        }

        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);

        resolve(canvas.toDataURL('image/jpeg', 0.92));
      };
      img.src = dataUrl;
    });
  }

  /**
   * Automatic Document Deskew Algorithm
   * Uses Sobel edge detection + Hough line voting to find the dominant
   * rotation angle of content (works for text pages AND objects on white bg).
   */
  static deskewDataUrl(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Work at a capped resolution for speed
        const maxDim = 900;
        const scale = Math.min(1.0, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        const imgData = ctx.getImageData(0, 0, w, h);
        const pixels = imgData.data;

        // --- Step 1: Sobel edge detection (full Gx + Gy magnitude) ---
        const lum = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
          lum[i] = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2];
        }

        const edgeX = [];   // edge pixel X coords
        const edgeY = [];   // edge pixel Y coords

        const EDGE_THRESHOLD = 30;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const gx =
              -lum[(y - 1) * w + (x - 1)] - 2 * lum[y * w + (x - 1)] - lum[(y + 1) * w + (x - 1)] +
               lum[(y - 1) * w + (x + 1)] + 2 * lum[y * w + (x + 1)] + lum[(y + 1) * w + (x + 1)];
            const gy =
              -lum[(y - 1) * w + (x - 1)] - 2 * lum[(y - 1) * w + x] - lum[(y - 1) * w + (x + 1)] +
               lum[(y + 1) * w + (x - 1)] + 2 * lum[(y + 1) * w + x] + lum[(y + 1) * w + (x + 1)];
            const mag = Math.sqrt(gx * gx + gy * gy);
            if (mag > EDGE_THRESHOLD) {
              edgeX.push(x);
              edgeY.push(y);
            }
          }
        }

        if (edgeX.length < 20) {
          // Not enough edges — return original unchanged
          resolve({ dataUrl, width: img.width, height: img.height, angle: 0 });
          return;
        }

        // --- Step 2: Hough accumulator over angles -20° to +20° ---
        // For each candidate angle θ, project every edge pixel onto the axis
        // perpendicular to θ and accumulate. The angle whose projection profile
        // has the HIGHEST variance has the most aligned edges = the skew angle.
        const ANGLE_MIN  = -20;
        const ANGLE_MAX  =  20;
        const ANGLE_STEP =  0.25;

        const cx = w / 2;
        const cy = h / 2;

        let bestAngle = 0;
        let bestScore = -1;

        // Subsample edges so we don't blow up on large images
        const MAX_EDGES = 3000;
        let step = Math.max(1, Math.floor(edgeX.length / MAX_EDGES));

        for (let angleDeg = ANGLE_MIN; angleDeg <= ANGLE_MAX; angleDeg += ANGLE_STEP) {
          const rad = (angleDeg * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);

          // Project edge pixels along the direction perpendicular to this angle
          // i.e. accumulate into "horizontal bands" rotated by angleDeg
          const bins = new Float32Array(h + 2);

          for (let i = 0; i < edgeX.length; i += step) {
            const dx = edgeX[i] - cx;
            const dy = edgeY[i] - cy;
            // y-coordinate in the rotated frame (this is the "row" after deskew)
            const projY = Math.round(-dx * sin + dy * cos + cy);
            if (projY >= 0 && projY < bins.length) bins[projY]++;
          }

          // Score = variance of the bin counts (sharp lines → high variance)
          let sum = 0, cnt = 0;
          for (let b = 0; b < bins.length; b++) { sum += bins[b]; cnt++; }
          const mean = sum / cnt;
          let variance = 0;
          for (let b = 0; b < bins.length; b++) {
            const d = bins[b] - mean;
            variance += d * d;
          }

          if (variance > bestScore) {
            bestScore = variance;
            bestAngle = angleDeg;
          }
        }

        // bestAngle is the detected skew; correction = -bestAngle
        const correctionDeg = -bestAngle;

        if (Math.abs(correctionDeg) < 0.15) {
          resolve({ dataUrl, width: img.width, height: img.height, angle: 0 });
          return;
        }

        // --- Step 3: Rotate the ORIGINAL full-resolution image ---
        const rad = (correctionDeg * Math.PI) / 180;
        const absCos = Math.abs(Math.cos(rad));
        const absSin = Math.abs(Math.sin(rad));

        // Bounding box that fully contains the rotated image (no clipping)
        const rotW = Math.ceil(img.width * absCos + img.height * absSin);
        const rotH = Math.ceil(img.width * absSin + img.height * absCos);

        const rotCanvas = document.createElement('canvas');
        rotCanvas.width  = rotW;
        rotCanvas.height = rotH;
        const rotCtx = rotCanvas.getContext('2d');

        rotCtx.fillStyle = '#ffffff';
        rotCtx.fillRect(0, 0, rotW, rotH);
        rotCtx.translate(rotW / 2, rotH / 2);
        rotCtx.rotate(rad);
        rotCtx.drawImage(img, -img.width / 2, -img.height / 2);

        resolve({
          dataUrl: rotCanvas.toDataURL('image/jpeg', 0.94),
          width: rotW,
          height: rotH,
          angle: correctionDeg
        });
      };
      img.src = dataUrl;
    });
  }


  /**
   * Crop image canvas to pixel coordinates
   */
  static cropDataUrl(dataUrl, cropX, cropY, cropW, cropH) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = cropW;
        canvas.height = cropH;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cropW, cropH);
        ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        resolve({
          dataUrl: canvas.toDataURL('image/jpeg', 0.92),
          width: cropW,
          height: cropH
        });
      };
      img.src = dataUrl;
    });
  }

  static detectBorders(canvas) {
    const origW = canvas.width;
    const origH = canvas.height;

    // 1. Downsample to max 400px for high performance (< 30ms processing time)
    const maxDim = 400;
    let w = origW;
    let h = origH;
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }

    // Create offscreen canvas for downsampling
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    tempCtx.drawImage(canvas, 0, 0, w, h);

    const imgData = tempCtx.getImageData(0, 0, w, h);
    const pixels = imgData.data;

    // 2. Grayscale conversion
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
    }

    // 3. Gaussian/Box Blur (5x5 neighborhood)
    const blurred = new Uint8Array(w * h);
    const blurRadius = 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -blurRadius; dy <= blurRadius; dy++) {
          const ny = y + dy;
          if (ny >= 0 && ny < h) {
            for (let dx = -blurRadius; dx <= blurRadius; dx++) {
              const nx = x + dx;
              if (nx >= 0 && nx < w) {
                sum += gray[ny * w + nx];
                count++;
              }
            }
          }
        }
        blurred[y * w + x] = Math.round(sum / count);
      }
    }

    // 4. Sample the scanner bed background color from the extreme borders (first 4 rows/cols)
    let borderSum = 0;
    let borderCount = 0;
    const borderThickness = 4;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (y < borderThickness || y >= h - borderThickness || x < borderThickness || x >= w - borderThickness) {
          borderSum += blurred[y * w + x];
          borderCount++;
        }
      }
    }
    const scannerBedLuminance = borderCount > 0 ? (borderSum / borderCount) : 240;

    // 5. Integral Image for Adaptive Thresholding
    const integral = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += blurred[y * w + x];
        if (y === 0) {
          integral[y * w + x] = rowSum;
        } else {
          integral[y * w + x] = integral[(y - 1) * w + x] + rowSum;
        }
      }
    }

    // 6. Hybrid Thresholding
    const thresholded = new Uint8Array(w * h);
    const S = Math.round(Math.min(w, h) / 8) | 1; // local neighborhood window size
    const halfS = (S - 1) >> 1;
    const localEdgeC = 8; // threshold constant for local edges
    const bgDiffThreshold = 25; // threshold constant for difference from scanner bed

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - halfS);
        const y1 = Math.max(0, y - halfS);
        const x2 = Math.min(w - 1, x + halfS);
        const y2 = Math.min(h - 1, y + halfS);

        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        let sum = integral[y2 * w + x2];
        if (x1 > 0) sum -= integral[y2 * w + (x1 - 1)];
        if (y1 > 0) sum -= integral[(y1 - 1) * w + x2];
        if (x1 > 0 && y1 > 0) sum += integral[(y1 - 1) * w + (x1 - 1)];

        const localAvg = sum / count;
        const val = blurred[y * w + x];

        // Pixel is classified as object if:
        // A. It differs significantly from scanner bed background
        // B. It is a local edge/shadow transition
        const diffFromBg = Math.abs(val - scannerBedLuminance);
        const diffFromLocal = Math.abs(val - localAvg);

        if (diffFromBg > bgDiffThreshold || diffFromLocal > localEdgeC) {
          thresholded[y * w + x] = 255;
        } else {
          thresholded[y * w + x] = 0;
        }
      }
    }

    // 7. Morphological Close (Dilation followed by Erosion with 3x3 window)
    const dilated = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let maxVal = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = thresholded[(y + dy) * w + (x + dx)];
            if (v > maxVal) maxVal = v;
          }
        }
        dilated[y * w + x] = maxVal;
      }
    }

    const closed = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let minVal = 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = dilated[(y + dy) * w + (x + dx)];
            if (v < minVal) minVal = v;
          }
        }
        closed[y * w + x] = minVal;
      }
    }

    // 8. Connected Component Labeling (CCL)
    const labels = new Int32Array(w * h);
    let nextLabel = 1;
    const parent = [];
    
    const find = (i) => {
      let root = i;
      while (parent[root] !== root) {
        root = parent[root];
      }
      let curr = i;
      while (curr !== root) {
        let nxt = parent[curr];
        parent[curr] = root;
        curr = nxt;
      }
      return root;
    };

    const union = (i, j) => {
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) {
        parent[rootI] = rootJ;
      }
    };

    parent[0] = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (closed[y * w + x] === 255) {
          const left = (x > 0) ? labels[y * w + (x - 1)] : 0;
          const top = (y > 0) ? labels[(y - 1) * w + x] : 0;

          if (left === 0 && top === 0) {
            labels[y * w + x] = nextLabel;
            parent[nextLabel] = nextLabel;
            nextLabel++;
          } else if (left !== 0 && top === 0) {
            labels[y * w + x] = left;
          } else if (left === 0 && top !== 0) {
            labels[y * w + x] = top;
          } else {
            labels[y * w + x] = Math.min(left, top);
            if (left !== top) {
              union(left, top);
            }
          }
        }
      }
    }

    // Consolidate components statistics
    const components = {};
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = labels[y * w + x];
        if (l !== 0) {
          const rootLabel = find(l);
          labels[y * w + x] = rootLabel;

          if (!components[rootLabel]) {
            components[rootLabel] = {
              minX: x, maxX: x,
              minY: y, maxY: y,
              pixelCount: 0
            };
          }
          const cData = components[rootLabel];
          cData.pixelCount++;
          if (x < cData.minX) cData.minX = x;
          if (x > cData.maxX) cData.maxX = x;
          if (y < cData.minY) cData.minY = y;
          if (y > cData.maxY) cData.maxY = y;
        }
      }
    }

    // 9. Filter Candidates & Select Best Document Bounding Box
    let bestComp = null;
    let bestScore = -1;
    const totalArea = w * h;

    for (const label in components) {
      const comp = components[label];
      const compW = comp.maxX - comp.minX + 1;
      const compH = comp.maxY - comp.minY + 1;
      const compArea = compW * compH;

      // Filter A: Minimum area check (must be at least 1.5% of scan size)
      if (comp.pixelCount < totalArea * 0.015) continue;

      // Filter B: Reject components that take up literally 100% of the canvas border
      // (which is likely the outer scan border/shadow itself)
      if (compW >= w - 4 && compH >= h - 4) {
        // If it fills the entire screen, verify if it's extremely hollow
        const fill = comp.pixelCount / totalArea;
        if (fill < 0.35) continue; // Hollow frame border rejection
      }

      // Filter C: Aspect Ratio check (receipts, banknotes, passports range between 0.2 and 5.0)
      const aspect = compW / compH;
      if (aspect < 0.18 || aspect > 5.5) continue;

      // Filter D: Solidity/Fill ratio check
      const fillRatio = comp.pixelCount / compArea;
      if (fillRatio < 0.35) continue; // Reject highly disjointed/hollow frame fragments

      // Score computation: we prefer larger, solid components matching typical document sizes
      let score = comp.pixelCount;

      // Aspect ratio weight (banknotes, IDs, A4 have ratios around 0.5 - 2.0)
      if (aspect > 0.4 && aspect < 2.5) {
        score *= 1.4;
      }

      // Solidity weight
      if (fillRatio > 0.6) {
        score *= 1.3;
      }

      if (score > bestScore) {
        bestScore = score;
        bestComp = comp;
      }
    }

    // 10. Fallback and Final Box Scaling with Padding
    if (!bestComp) {
      // Default to 10px margins if no valid document detected
      return { x: 10, y: 10, w: origW - 20, h: origH - 20 };
    }

    const scaleX = origW / w;
    const scaleY = origH / h;

    let finalMinX = Math.round(bestComp.minX * scaleX);
    let finalMaxX = Math.round((bestComp.maxX + 1) * scaleX);
    let finalMinY = Math.round(bestComp.minY * scaleY);
    let finalMaxY = Math.round((bestComp.maxY + 1) * scaleY);

    // Add approximately 5-10 pixels of padding
    const padding = 8;
    finalMinX = Math.max(0, finalMinX - padding);
    finalMaxX = Math.min(origW - 1, finalMaxX + padding);
    finalMinY = Math.max(0, finalMinY - padding);
    finalMaxY = Math.min(origH - 1, finalMaxY + padding);

    return {
      x: finalMinX,
      y: finalMinY,
      w: finalMaxX - finalMinX,
      h: finalMaxY - finalMinY
    };
  }
}

class ScannerApp {
  constructor() {
    this.pages = [];
    this.selectedIndex = -1;
    this.zoomScale = 1.0;
    this.sortable = null;
    this.scanners = [];
    this.scanModalInstance = null;
    this.cropModalInstance = null;
    this.historyStack = [];
    this.redoStack = [];
    this.maxHistory = 30;

    const isNativeHost = window.location.port === '3000';
    this.apiUrl = isNativeHost ? '' : 'http://localhost:3000';

    this.initDOM();
    this.initEvents();
    this.initSortable();
    this.initCropTool();
    this.loadScanners();
    this.restoreSession();
    this.updateUI();
  }

  initDOM() {
    // Toolbar elements
    this.scannerSelect = document.getElementById('scannerSelect');
    this.btnRefreshScanners = document.getElementById('btnRefreshScanners');
    this.btnScan = document.getElementById('btnScan');
    this.btnStopScan = document.getElementById('btnStopScan');
    this.dpiSelect = document.getElementById('dpiSelect');
    this.colorSelect = document.getElementById('colorSelect');
    this.sourceSelect = document.getElementById('sourceSelect');
    this.paperSelect = document.getElementById('paperSelect');

    // Page editing & history buttons
    this.btnUndo = document.getElementById('btnUndo');
    this.btnRedo = document.getElementById('btnRedo');
    this.btnAddImage = document.getElementById('btnAddImage');
    this.btnImportPdf = document.getElementById('btnImportPdf');
    this.btnDeskew = document.getElementById('btnDeskew');
    this.btnCrop = document.getElementById('btnCrop');
    this.btnRotateLeft = document.getElementById('btnRotateLeft');
    this.btnRotateRight = document.getElementById('btnRotateRight');
    this.btnDelete = document.getElementById('btnDelete');
    this.btnExportMenu = document.getElementById('btnExportMenu');
    this.btnSavePdf = document.getElementById('btnSavePdf');
    this.btnSaveJpg = document.getElementById('btnSaveJpg');
    this.btnClearAll = document.getElementById('btnClearAll');

    // Display & Viewport
    this.thumbnailList = document.getElementById('thumbnailList');
    this.emptyState = document.getElementById('emptyState');
    this.previewViewport = document.getElementById('previewViewport');
    this.previewControls = document.getElementById('previewControls');
    this.previewImg = document.getElementById('previewImg');
    this.pageCard = document.getElementById('pageCard');
    this.pageCounter = document.getElementById('pageCounter');
    this.thumbnailCount = document.getElementById('thumbnailCount');
    this.fileInput = document.getElementById('fileInput');

    // Overlay Modal elements
    this.scanProgressModalEl = document.getElementById('scanProgressModal');
    this.scanProgressSubtitle = document.getElementById('scanProgressSubtitle');
    this.btnModalStopScan = document.getElementById('btnModalStopScan');

    // Crop Modal elements
    this.cropModalEl = document.getElementById('cropModal');
    this.cropCanvas = document.getElementById('cropCanvas');
    this.cropBox = document.getElementById('cropBox');
    this.cropDimensions = document.getElementById('cropDimensions');
    this.btnAutoDetectCrop = document.getElementById('btnAutoDetectCrop');
    this.btnResetCrop = document.getElementById('btnResetCrop');
    this.btnApplyCrop = document.getElementById('btnApplyCrop');

    // Alert Banner
    this.alertBanner = document.getElementById('alertBanner');
    this.alertText = document.getElementById('alertText');
    this.btnCloseAlert = document.getElementById('btnCloseAlert');

    // Zoom
    this.btnZoomIn = document.getElementById('btnZoomIn');
    this.btnZoomOut = document.getElementById('btnZoomOut');
    this.btnZoomReset = document.getElementById('btnZoomReset');
    this.zoomLevelText = document.getElementById('zoomLevelText');
  }

  initSortable() {
    this.sortable = Sortable.create(this.thumbnailList, {
      animation: 150,
      handle: '.thumbnail-drag-handle',
      ghostClass: 'thumbnail-ghost',
      onEnd: (evt) => {
        if (evt.oldIndex !== evt.newIndex) {
          this.saveHistoryState();
          const movedItem = this.pages.splice(evt.oldIndex, 1)[0];
          this.pages.splice(evt.newIndex, 0, movedItem);
          this.selectedIndex = evt.newIndex;
          this.renderThumbnails();
          this.updatePreview();
          this.syncSession();
        }
      }
    });
  }

  createSnapshot() {
    return {
      pages: this.pages.map((p) => {
        const page = new DocumentPage(p.id, p.dataUrl, p.width, p.height, p.dpi);
        page.rotation = p.rotation || 0;
        return page;
      }),
      selectedIndex: this.selectedIndex
    };
  }

  saveHistoryState() {
    const snapshot = this.createSnapshot();
    this.historyStack.push(snapshot);
    if (this.historyStack.length > this.maxHistory) {
      this.historyStack.shift();
    }
    this.redoStack = [];
    this.updateUndoRedoUI();
  }

  undo() {
    if (this.historyStack.length === 0) return;
    const currentSnapshot = this.createSnapshot();
    this.redoStack.push(currentSnapshot);

    const previousState = this.historyStack.pop();
    this.pages = previousState.pages.map((p) => {
      const page = new DocumentPage(p.id, p.dataUrl, p.width, p.height, p.dpi);
      page.rotation = p.rotation || 0;
      return page;
    });
    this.selectedIndex = previousState.selectedIndex;
    if (this.selectedIndex >= this.pages.length) {
      this.selectedIndex = this.pages.length - 1;
    }

    this.renderThumbnails();
    this.updateUI();
    this.syncSession();
    this.updateUndoRedoUI();
    this.showAlert('Undo performed.', false);
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const currentSnapshot = this.createSnapshot();
    this.historyStack.push(currentSnapshot);

    const nextState = this.redoStack.pop();
    this.pages = nextState.pages.map((p) => {
      const page = new DocumentPage(p.id, p.dataUrl, p.width, p.height, p.dpi);
      page.rotation = p.rotation || 0;
      return page;
    });
    this.selectedIndex = nextState.selectedIndex;
    if (this.selectedIndex >= this.pages.length) {
      this.selectedIndex = this.pages.length - 1;
    }

    this.renderThumbnails();
    this.updateUI();
    this.syncSession();
    this.updateUndoRedoUI();
    this.showAlert('Redo performed.', false);
  }

  updateUndoRedoUI() {
    if (this.btnUndo) this.btnUndo.disabled = this.historyStack.length === 0;
    if (this.btnRedo) this.btnRedo.disabled = this.redoStack.length === 0;
  }

  initCropTool() {
    if (!this.cropBox || !this.cropCanvas) return;

    this.cropState = {
      isDragging: false,
      activeHandle: null,
      startX: 0,
      startY: 0,
      boxX: 0,
      boxY: 0,
      boxW: 0,
      boxH: 0,
      imgW: 0,
      imgH: 0,
      canvasW: 0,
      canvasH: 0
    };

    const BORDER_HIT = 10; // px tolerance for grabbing the border line itself

    // Determine what zone of the crop box a mouse event lands in.
    // Returns a handle class name string (matching .handle-XX) or 'move'.
    const getZone = (e) => {
      const rect = this.cropBox.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const W  = rect.width;
      const H  = rect.height;

      const onTop    = my >= -BORDER_HIT && my <= BORDER_HIT;
      const onBottom = my >= H - BORDER_HIT && my <= H + BORDER_HIT;
      const onLeft   = mx >= -BORDER_HIT && mx <= BORDER_HIT;
      const onRight  = mx >= W - BORDER_HIT && mx <= W + BORDER_HIT;

      // Corners first (wider priority zone)
      if (onTop    && onLeft)  return 'handle-nw';
      if (onTop    && onRight) return 'handle-ne';
      if (onBottom && onRight) return 'handle-se';
      if (onBottom && onLeft)  return 'handle-sw';
      // Edges
      if (onTop)    return 'handle-n';
      if (onBottom) return 'handle-s';
      if (onRight)  return 'handle-e';
      if (onLeft)   return 'handle-w';
      // Interior
      return 'move';
    };

    const cursorFor = (zone) => {
      switch (zone) {
        case 'handle-nw': case 'handle-se': return 'nwse-resize';
        case 'handle-ne': case 'handle-sw': return 'nesw-resize';
        case 'handle-n':  case 'handle-s':  return 'ns-resize';
        case 'handle-e':  case 'handle-w':  return 'ew-resize';
        default: return 'move';
      }
    };

    // Update cursor on hover over the cropBox itself
    this.cropBox.addEventListener('mousemove', (e) => {
      if (this.cropState.isDragging) return;
      if (e.target.classList.contains('crop-handle')) return;
      const zone = getZone(e);
      this.cropBox.style.cursor = cursorFor(zone);
    });

    // Corner & edge handle mousedown
    const handles = this.cropBox.querySelectorAll('.crop-handle');
    handles.forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        // Derive the zone from the handle class list (e.g. "crop-handle handle-se")
        const cls = Array.from(handle.classList).find((c) => c.startsWith('handle-'));
        this.cropState.isDragging = true;
        this.cropState.activeHandle = cls || 'move';
        this.cropState.startX = e.clientX;
        this.cropState.startY = e.clientY;
      });
    });

    // Border hit-test mousedown (fires when clicking the box body, not a handle)
    this.cropBox.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('crop-handle')) return;
      const zone = getZone(e);
      this.cropState.isDragging = true;
      this.cropState.activeHandle = zone;
      this.cropState.startX = e.clientX;
      this.cropState.startY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.cropState.isDragging) return;

      const dx = e.clientX - this.cropState.startX;
      const dy = e.clientY - this.cropState.startY;
      const maxW = this.cropState.canvasW;
      const maxH = this.cropState.canvasH;
      const h    = this.cropState.activeHandle;

      if (h === 'move') {
        this.cropState.boxX = Math.max(0, Math.min(maxW - this.cropState.boxW, this.cropState.boxX + dx));
        this.cropState.boxY = Math.max(0, Math.min(maxH - this.cropState.boxH, this.cropState.boxY + dy));

      } else if (h === 'handle-se') {
        this.cropState.boxW = Math.max(20, Math.min(maxW - this.cropState.boxX, this.cropState.boxW + dx));
        this.cropState.boxH = Math.max(20, Math.min(maxH - this.cropState.boxY, this.cropState.boxH + dy));

      } else if (h === 'handle-sw') {
        const newW = Math.max(20, this.cropState.boxW - dx);
        this.cropState.boxX = Math.max(0, this.cropState.boxX + (this.cropState.boxW - newW));
        this.cropState.boxW = newW;
        this.cropState.boxH = Math.max(20, Math.min(maxH - this.cropState.boxY, this.cropState.boxH + dy));

      } else if (h === 'handle-ne') {
        this.cropState.boxW = Math.max(20, Math.min(maxW - this.cropState.boxX, this.cropState.boxW + dx));
        const newH = Math.max(20, this.cropState.boxH - dy);
        this.cropState.boxY = Math.max(0, this.cropState.boxY + (this.cropState.boxH - newH));
        this.cropState.boxH = newH;

      } else if (h === 'handle-nw') {
        const newW = Math.max(20, this.cropState.boxW - dx);
        this.cropState.boxX = Math.max(0, this.cropState.boxX + (this.cropState.boxW - newW));
        this.cropState.boxW = newW;
        const newH = Math.max(20, this.cropState.boxH - dy);
        this.cropState.boxY = Math.max(0, this.cropState.boxY + (this.cropState.boxH - newH));
        this.cropState.boxH = newH;

      } else if (h === 'handle-n') {
        const newH = Math.max(20, this.cropState.boxH - dy);
        this.cropState.boxY = Math.max(0, this.cropState.boxY + (this.cropState.boxH - newH));
        this.cropState.boxH = newH;

      } else if (h === 'handle-s') {
        this.cropState.boxH = Math.max(20, Math.min(maxH - this.cropState.boxY, this.cropState.boxH + dy));

      } else if (h === 'handle-e') {
        this.cropState.boxW = Math.max(20, Math.min(maxW - this.cropState.boxX, this.cropState.boxW + dx));

      } else if (h === 'handle-w') {
        const newW = Math.max(20, this.cropState.boxW - dx);
        this.cropState.boxX = Math.max(0, this.cropState.boxX + (this.cropState.boxW - newW));
        this.cropState.boxW = newW;
      }

      this.cropState.startX = e.clientX;
      this.cropState.startY = e.clientY;
      this.updateCropBoxDOM();
    });

    window.addEventListener('mouseup', () => {
      this.cropState.isDragging = false;
      this.cropState.activeHandle = null;
      this.cropBox.style.cursor = 'move';
    });

    if (this.btnResetCrop) {
      this.btnResetCrop.addEventListener('click', () => this.resetCropBox());
    }
    if (this.btnAutoDetectCrop) {
      this.btnAutoDetectCrop.addEventListener('click', () => this.autoDetectCropBox());
    }
    if (this.btnApplyCrop) {
      this.btnApplyCrop.addEventListener('click', () => this.applyCrop());
    }
  }

  updateCropBoxDOM() {
    this.cropBox.style.left = `${this.cropState.boxX}px`;
    this.cropBox.style.top = `${this.cropState.boxY}px`;
    this.cropBox.style.width = `${this.cropState.boxW}px`;
    this.cropBox.style.height = `${this.cropState.boxH}px`;

    const scaleX = this.cropState.imgW / this.cropState.canvasW;
    const scaleY = this.cropState.imgH / this.cropState.canvasH;

    const realW = Math.round(this.cropState.boxW * scaleX);
    const realH = Math.round(this.cropState.boxH * scaleY);

    const dpi = this.cropState.dpi || 300;
    const realW_mm = ((realW / dpi) * 25.4).toFixed(1);
    const realH_mm = ((realH / dpi) * 25.4).toFixed(1);

    if (this.cropDimensions) {
      this.cropDimensions.textContent = `Selection: ${realW_mm} × ${realH_mm} mm`;
    }
  }

  resetCropBox() {
    const margin = 10;
    this.cropState.boxX = margin;
    this.cropState.boxY = margin;
    this.cropState.boxW = Math.max(40, this.cropState.canvasW - margin * 2);
    this.cropState.boxH = Math.max(40, this.cropState.canvasH - margin * 2);
    this.updateCropBoxDOM();
  }

  autoDetectCropBox() {
    const box = ImageProcessor.detectBorders(this.cropCanvas);
    this.cropState.boxX = box.x;
    this.cropState.boxY = box.y;
    this.cropState.boxW = box.w;
    this.cropState.boxH = box.h;
    this.updateCropBoxDOM();
  }

  async openCropModal() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.pages.length) return;

    const page = this.pages[this.selectedIndex];
    const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);

    const img = new Image();
    img.onload = () => {
      const maxW = 700;
      const maxH = 450;
      let scale = Math.min(1.0, Math.min(maxW / img.width, maxH / img.height));

      const cW = Math.round(img.width * scale);
      const cH = Math.round(img.height * scale);

      this.cropCanvas.width = cW;
      this.cropCanvas.height = cH;

      const ctx = this.cropCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cW, cH);

      this.cropState.imgW = img.width;
      this.cropState.imgH = img.height;
      this.cropState.canvasW = cW;
      this.cropState.canvasH = cH;
      this.cropState.dpi = page.dpi || 300;

      this.autoDetectCropBox();

      if (window.bootstrap && this.cropModalEl) {
        if (!this.cropModalInstance) {
          this.cropModalInstance = new bootstrap.Modal(this.cropModalEl);
        }
        this.cropModalInstance.show();
      }
    };
    img.src = rotatedDataUrl;
  }

  async applyCrop() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.pages.length) return;

    const page = this.pages[this.selectedIndex];
    const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);

    const scaleX = this.cropState.imgW / this.cropState.canvasW;
    const scaleY = this.cropState.imgH / this.cropState.canvasH;

    const cropX = Math.round(this.cropState.boxX * scaleX);
    const cropY = Math.round(this.cropState.boxY * scaleY);
    const cropW = Math.round(this.cropState.boxW * scaleX);
    const cropH = Math.round(this.cropState.boxH * scaleY);

    try {
      const result = await ImageProcessor.cropDataUrl(rotatedDataUrl, cropX, cropY, cropW, cropH);
      if (result && result.dataUrl) {
        this.saveHistoryState();
        page.dataUrl = result.dataUrl;
        page.width = result.width;
        page.height = result.height;
        page.rotation = 0; // Reset rotation after baking into crop

        this.renderThumbnails();
        this.updatePreview();
        this.syncSession();

        if (this.cropModalInstance) {
          this.cropModalInstance.hide();
        }

        const w_mm = ((result.width / (page.dpi || 300)) * 25.4).toFixed(1);
        const h_mm = ((result.height / (page.dpi || 300)) * 25.4).toFixed(1);
        this.showAlert(`Document cropped to ${w_mm} × ${h_mm} mm`, false);
      }
    } catch (err) {
      console.warn('Crop error:', err);
    }
  }

  initEvents() {
    // Toolbar events
    if (this.btnUndo) {
      this.btnUndo.addEventListener('click', () => this.undo());
    }
    if (this.btnRedo) {
      this.btnRedo.addEventListener('click', () => this.redo());
    }

    this.btnRefreshScanners.addEventListener('click', () => this.loadScanners());
    this.btnScan.addEventListener('click', () => this.triggerHardwareScan());
    this.btnStopScan.addEventListener('click', () => this.abortScan());
    if (this.btnModalStopScan) {
      this.btnModalStopScan.addEventListener('click', () => this.abortScan());
    }
    this.btnAddImage.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

    if (this.btnImportPdf) {
      this.btnImportPdf.addEventListener('click', () => this.importPdf());
    }

    this.scannerSelect.addEventListener('change', () => {
      localStorage.setItem('naps2_selected_scanner', this.scannerSelect.value);
    });

    if (this.btnDeskew) {
      this.btnDeskew.addEventListener('click', () => this.deskewSelected());
    }
    if (this.btnCrop) {
      this.btnCrop.addEventListener('click', () => this.openCropModal());
    }
    this.btnRotateLeft.addEventListener('click', () => this.rotateSelected(-90));
    this.btnRotateRight.addEventListener('click', () => this.rotateSelected(90));
    if (this.btnDelete) {
      this.btnDelete.addEventListener('click', () => this.deleteSelected());
    }
    this.btnClearAll.addEventListener('click', () => this.clearAll());

    this.btnSavePdf.addEventListener('click', () => this.exportPdf());
    this.btnSaveJpg.addEventListener('click', () => this.exportJpg());

    // Zoom events
    this.btnZoomIn.addEventListener('click', () => this.setZoom(this.zoomScale + 0.25));
    this.btnZoomOut.addEventListener('click', () => this.setZoom(this.zoomScale - 0.25));
    this.btnZoomReset.addEventListener('click', () => this.setZoom(1.0));

    // Alert dismissal
    this.btnCloseAlert.addEventListener('click', () => this.hideAlert());

    // Drag and Drop files onto workspace
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) {
        const allFiles = Array.from(e.dataTransfer.files);
        const imgFiles = allFiles.filter((f) => f.type.startsWith('image/'));
        const pdfFiles = allFiles.filter((f) => f.type === 'application/pdf');
        if (imgFiles.length > 0) {
          this.saveHistoryState();
          imgFiles.forEach((file) => {
            const reader = new FileReader();
            reader.onload = (event) => this.addPage(event.target.result, true, 300);
            reader.readAsDataURL(file);
          });
        }
        pdfFiles.forEach((file) => {
          const reader = new FileReader();
          reader.onload = (event) => this.importPdfFromArrayBuffer(event.target.result);
          reader.readAsArrayBuffer(file);
        });
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const active = document.activeElement;
      const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');

      if ((e.ctrlKey || e.metaKey) && !isInput) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            this.redo();
          } else {
            this.undo();
          }
        } else if (key === 'y') {
          e.preventDefault();
          this.redo();
        }
      } else if (e.key === 'Delete' && this.selectedIndex >= 0 && !isInput) {
        this.deleteSelected();
      } else if (e.key === 'ArrowUp' && this.selectedIndex > 0 && !isInput) {
        this.selectPage(this.selectedIndex - 1);
      } else if (e.key === 'ArrowDown' && this.selectedIndex < this.pages.length - 1 && !isInput) {
        this.selectPage(this.selectedIndex + 1);
      }
    });
  }

  async loadScanners() {
    this.scannerSelect.innerHTML = '<option value="">Searching for scanners...</option>';
    this.hideAlert();

    try {
      const res = await fetch(`${this.apiUrl}/scanners`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.scanners = data || [];

      this.scannerSelect.innerHTML = '';

      if (this.scanners.length === 0) {
        this.scannerSelect.innerHTML = '<option value="wia:canon_g3410">Canon PIXMA G3410 (WIA Auto)</option>';
      } else {
        this.scanners.forEach((sc) => {
          const opt = document.createElement('option');
          opt.value = sc.id;
          opt.textContent = `${sc.name} [${sc.type}]`;
          this.scannerSelect.appendChild(opt);
        });
      }

      const saved = localStorage.getItem('naps2_selected_scanner');
      if (saved && Array.from(this.scannerSelect.options).some(o => o.value === saved)) {
        this.scannerSelect.value = saved;
      }
    } catch (err) {
      console.warn('Scanner enumeration fallback:', err);
      this.scannerSelect.innerHTML = '<option value="wia:canon_g3410">Canon PIXMA G3410 (WIA Auto)</option>';
    }
  }

  async restoreSession() {
    try {
      const res = await fetch(`${this.apiUrl}/session/pages`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.pages && data.pages.length > 0) {
        this.pages = data.pages.map((p) => {
          const page = new DocumentPage(p.id, p.dataUrl, p.width, p.height, p.dpi);
          page.rotation = p.rotation || 0;
          return page;
        });
        this.selectedIndex = 0;
        this.renderThumbnails();
        this.updateUI();
      }
    } catch (err) {
      console.warn('[Session Recovery Error]:', err);
    }
  }

  async syncSession() {
    try {
      await fetch(`${this.apiUrl}/session/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages: this.pages })
      });
    } catch (err) {
      console.warn('[Session Sync Error]:', err);
    }
  }

  async clearSession() {
    try {
      await fetch(`${this.apiUrl}/session/clear`, { method: 'POST' });
    } catch (err) {}
  }

  async triggerHardwareScan() {
    this.hideAlert();
    this.btnScan.classList.add('hidden-input');
    this.btnStopScan.classList.remove('hidden-input');

    const selectedName = this.scannerSelect.options[this.scannerSelect.selectedIndex]?.textContent || 'Canon G3410';
    if (this.scanProgressSubtitle) {
      this.scanProgressSubtitle.textContent = `Acquiring page from ${selectedName} (${this.dpiSelect.value} DPI ${this.colorSelect.value})...`;
    }

    if (window.bootstrap && this.scanProgressModalEl) {
      if (!this.scanModalInstance) {
        this.scanModalInstance = new bootstrap.Modal(this.scanProgressModalEl);
      }
      this.scanModalInstance.show();
    }

    this.scanAbortController = new AbortController();

    const payload = {
      scannerId: this.scannerSelect.value,
      dpi: parseInt(this.dpiSelect.value, 10),
      colorMode: this.colorSelect.value,
      source: this.sourceSelect.value,
      paperSize: this.paperSelect.value
    };

    try {
      const res = await fetch(`${this.apiUrl}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this.scanAbortController.signal
      });

      const data = await res.json();

      this.resetScanUI();

      if (data.success && data.pages && data.pages.length > 0) {
        this.saveHistoryState();
        data.pages.forEach((dataUrl) => this.addPage(dataUrl, true, payload.dpi));
      } else if (data.cancelled) {
        // User cancelled scan dialog
      } else {
        const errorMsg = data.error || 'Failed to scan from Canon G3410. Check printer power & cable.';
        this.showAlert(errorMsg, true);
      }
    } catch (err) {
      this.resetScanUI();
      if (err.name === 'AbortError') {
        this.showAlert('Scan operation stopped by user.', false);
      } else {
        this.showAlert(`Scanner Communication Error: ${err.message}. Ensure backend server is running at http://localhost:3000.`, true);
      }
    }
  }

  async abortScan() {
    if (this.scanAbortController) {
      this.scanAbortController.abort();
    }

    this.resetScanUI();

    try {
      await fetch(`${this.apiUrl}/scan/cancel`, { method: 'POST' });
    } catch (e) {}

    this.showAlert('Scan stopped by user.', false);
  }

  resetScanUI() {
    if (this.scanModalInstance) {
      this.scanModalInstance.hide();
    }
    this.btnScan.classList.remove('hidden-input');
    this.btnStopScan.classList.add('hidden-input');
    this.btnScan.disabled = false;
  }

  showAlert(msg, isError = true) {
    this.alertText.textContent = msg;
    if (isError) {
      this.alertBanner.className = 'alert alert-danger alert-dismissible fade show mb-0 rounded-0';
    } else {
      this.alertBanner.className = 'alert alert-success alert-dismissible fade show mb-0 rounded-0';
    }
    this.alertBanner.classList.remove('hidden-input');
  }

  hideAlert() {
    this.alertBanner.classList.add('hidden-input');
  }

  addPage(dataUrl, skipHistory = false, dpi = null) {
    if (!skipHistory) {
      this.saveHistoryState();
    }
    const img = new Image();
    img.onload = () => {
      const page = new DocumentPage(null, dataUrl, img.width, img.height, dpi);
      this.pages.push(page);
      this.selectedIndex = this.pages.length - 1;
      this.renderThumbnails();
      this.updateUI();
      this.syncSession();
    };
    img.src = dataUrl;
  }

  selectPage(index) {
    if (index >= 0 && index < this.pages.length) {
      if (this.selectedIndex >= 0 && this.thumbnailList.children[this.selectedIndex]) {
        this.thumbnailList.children[this.selectedIndex].classList.remove('active', 'border-primary');
        const oldBadge = this.thumbnailList.children[this.selectedIndex].querySelector('.badge');
        if (oldBadge) {
          oldBadge.classList.remove('bg-primary');
          oldBadge.classList.add('bg-secondary');
        }
      }

      this.selectedIndex = index;

      if (this.thumbnailList.children[this.selectedIndex]) {
        this.thumbnailList.children[this.selectedIndex].classList.add('active', 'border-primary');
        const newBadge = this.thumbnailList.children[this.selectedIndex].querySelector('.badge');
        if (newBadge) {
          newBadge.classList.remove('bg-secondary');
          newBadge.classList.add('bg-primary');
        }
      }

      this.updatePreview();
      this.updateUI();
    }
  }

  async deskewSelected() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.pages.length) return;

    const page = this.pages[this.selectedIndex];
    if (this.btnDeskew) {
      this.btnDeskew.disabled = true;
      this.btnDeskew.innerHTML = `<i class="bi bi-arrow-repeat spin-icon me-1"></i>Aligning...`;
    }

    try {
      const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);
      const result = await ImageProcessor.deskewDataUrl(rotatedDataUrl);
      if (result && result.dataUrl) {
        this.saveHistoryState();
        page.dataUrl = result.dataUrl;
        page.width = result.width;
        page.height = result.height;
        page.rotation = 0; // Reset visual rotation since it's now baked into dataUrl
        this.renderThumbnails();
        this.updatePreview();
        this.syncSession();
        if (result.angle !== 0) {
          this.showAlert(`Document straightened by ${result.angle.toFixed(1)}°`, false);
        } else {
          this.showAlert('Document is already perfectly aligned.', false);
        }
      }
    } catch (err) {
      console.warn('Deskew error:', err);
    } finally {
      if (this.btnDeskew) {
        this.btnDeskew.disabled = false;
        this.btnDeskew.innerHTML = `<i class="bi bi-magic me-1"></i>Auto Deskew`;
      }
    }
  }

  rotateSelected(delta) {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
      this.saveHistoryState();
      const page = this.pages[this.selectedIndex];
      page.rotate(delta);

      const activeCard = this.thumbnailList.children[this.selectedIndex];
      if (activeCard) {
        const thumbImg = activeCard.querySelector('.thumbnail-img');
        const metaText = activeCard.querySelector('.thumbnail-meta-text');
        if (thumbImg) thumbImg.style.transform = `rotate(${page.rotation}deg)`;
        if (metaText) {
          const w_mm = ((page.width / (page.dpi || 300)) * 25.4).toFixed(1);
          const h_mm = ((page.height / (page.dpi || 300)) * 25.4).toFixed(1);
          metaText.textContent = `${w_mm} × ${h_mm} mm ${page.rotation ? `(${page.rotation}°)` : ''}`;
        }
      }

      this.updatePreview();
      this.syncSession();
    }
  }

  deleteSelected() {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
      this.saveHistoryState();
      this.pages.splice(this.selectedIndex, 1);
      if (this.selectedIndex >= this.pages.length) {
        this.selectedIndex = this.pages.length - 1;
      }
      this.renderThumbnails();
      this.updateUI();
      this.syncSession();
    }
  }

  deletePage(index) {
    if (index >= 0 && index < this.pages.length) {
      if (confirm(`Are you sure you want to delete Page ${index + 1}?`)) {
        this.saveHistoryState();
        this.pages.splice(index, 1);
        if (this.selectedIndex === index) {
          if (this.selectedIndex >= this.pages.length) {
            this.selectedIndex = this.pages.length - 1;
          }
        } else if (this.selectedIndex > index) {
          this.selectedIndex--;
        }
        this.renderThumbnails();
        this.updateUI();
        this.syncSession();
      }
    }
  }

  clearAll() {
    if (this.pages.length === 0) return;
    if (confirm('Are you sure you want to clear all document pages?')) {
      this.saveHistoryState();
      this.pages = [];
      this.selectedIndex = -1;
      this.renderThumbnails();
      this.updateUI();
      this.clearSession();
    }
  }

  setZoom(scale) {
    this.zoomScale = Math.max(0.25, Math.min(3.0, scale));
    this.zoomLevelText.textContent = `${Math.round(this.zoomScale * 100)}%`;
    this.pageCard.style.transform = `scale(${this.zoomScale})`;
  }

  renderThumbnails() {
    this.thumbnailList.innerHTML = '';

    this.pages.forEach((page, idx) => {
      const item = document.createElement('div');
      item.className = `card thumbnail-item mb-2 p-2 shadow-sm ${idx === this.selectedIndex ? 'active border-primary' : ''}`;
      item.addEventListener('click', () => this.selectPage(idx));

      item.innerHTML = `
        <div class="d-flex align-items-center gap-2 w-100">
          <div class="thumbnail-drag-handle px-1" title="Drag to reorder">
            <i class="bi bi-grip-vertical fs-5"></i>
          </div>
          <span class="badge ${idx === this.selectedIndex ? 'bg-primary' : 'bg-secondary'} rounded-circle p-2" style="width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 11px;">${idx + 1}</span>
          <div class="thumbnail-img-box">
            <img class="thumbnail-img" src="${page.dataUrl}" style="transform: rotate(${page.rotation}deg)">
          </div>
          <div class="d-flex flex-column text-truncate" style="flex: 1;">
            <span class="fw-bold small text-dark">Page ${idx + 1}</span>
            <span class="text-muted thumbnail-meta-text" style="font-size: 10px;">
              ${((page.width / (page.dpi || 300)) * 25.4).toFixed(1)} × ${((page.height / (page.dpi || 300)) * 25.4).toFixed(1)} mm ${page.rotation ? `(${page.rotation}°)` : ''}
            </span>
          </div>
          <button class="btn btn-sm btn-link text-danger p-1 btn-delete-thumbnail" title="Delete Page" style="text-decoration: none;">
            <i class="bi bi-trash fs-6"></i>
          </button>
        </div>
      `;

      const delBtn = item.querySelector('.btn-delete-thumbnail');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deletePage(idx);
        });
      }

      this.thumbnailList.appendChild(item);
    });

    this.thumbnailCount.textContent = `${this.pages.length} item${this.pages.length === 1 ? '' : 's'}`;
    this.pageCounter.textContent = `${this.pages.length} Page${this.pages.length === 1 ? '' : 's'}`;
  }

  updatePreview() {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
      const page = this.pages[this.selectedIndex];
      this.previewImg.src = page.dataUrl;
      this.previewImg.style.transform = `rotate(${page.rotation}deg)`;
    }
  }

  updateUI() {
    const hasPages = this.pages.length > 0;
    const hasSelection = this.selectedIndex >= 0;

    if (hasPages && hasSelection) {
      this.emptyState.classList.add('hidden-input');
      this.previewViewport.classList.remove('hidden-input');
      this.previewControls.classList.remove('hidden-input');
      this.updatePreview();
    } else {
      this.emptyState.classList.remove('hidden-input');
      this.previewViewport.classList.add('hidden-input');
      this.previewControls.classList.add('hidden-input');
    }

    if (this.btnDeskew) this.btnDeskew.disabled = !hasSelection;
    if (this.btnCrop) this.btnCrop.disabled = !hasSelection;
    this.btnRotateLeft.disabled = !hasSelection;
    this.btnRotateRight.disabled = !hasSelection;
    if (this.btnDelete) this.btnDelete.disabled = !hasSelection;
    if (this.btnExportMenu) this.btnExportMenu.disabled = !hasPages;
    if (this.btnSavePdf) this.btnSavePdf.disabled = !hasPages;
    if (this.btnSaveJpg) this.btnSaveJpg.disabled = !hasSelection;
    this.btnClearAll.disabled = !hasPages;

    this.updateUndoRedoUI();
  }

  handleFileSelect(e) {
    const files = Array.from(e.target.files).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;

    this.saveHistoryState();
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        this.addPage(event.target.result, true, 300);
      };
      reader.readAsDataURL(file);
    });

    this.fileInput.value = '';
  }

  async exportPdf() {
    if (!this.pages.length) return;

    const { jsPDF } = window.jspdf;
    let pdf = null;

    this.btnSavePdf.disabled = true;
    this.btnSavePdf.textContent = 'Generating PDF...';

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);

      let imgW = page.width;
      let imgH = page.height;
      if (page.rotation === 90 || page.rotation === 270) {
        imgW = page.height;
        imgH = page.width;
      }

      const orientation = imgW > imgH ? 'landscape' : 'portrait';

      if (i === 0) {
        pdf = new jsPDF({
          orientation: orientation,
          unit: 'px',
          format: [imgW, imgH]
        });
      } else {
        pdf.addPage([imgW, imgH], orientation);
      }

      pdf.addImage(rotatedDataUrl, 'JPEG', 0, 0, imgW, imgH);
    }

    pdf.save('Scanned_Document_' + new Date().toISOString().slice(0, 10) + '.pdf');

    if (this.btnSavePdf) {
      this.btnSavePdf.disabled = false;
      this.btnSavePdf.innerHTML = `<i class="bi bi-file-earmark-pdf text-danger"></i> <span>Save PDF</span> <small class="text-muted ms-auto">All pages</small>`;
    }
  }

  async exportJpg() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.pages.length) return;

    const page = this.pages[this.selectedIndex];
    const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);

    const a = document.createElement('a');
    a.href = rotatedDataUrl;
    a.download = `Scanned_Page_${this.selectedIndex + 1}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /**
   * Let the user pick a PDF file and import all its pages as images.
   * Uses PDF.js (loaded via CDN) to render each page to a canvas.
   */
  importPdf() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.multiple = true;
    input.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        await this.importPdfFromArrayBuffer(buffer);
      }
    });
    input.click();
  }

  async importPdfFromArrayBuffer(buffer) {
    // Dynamically load PDF.js if not already present
    if (!window.pdfjsLib) {
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
          script.onload = () => {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
              'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            resolve();
          };
          script.onerror = reject;
          document.head.appendChild(script);
        });
      } catch (e) {
        this.showAlert('PDF.js library failed to load. Cannot import PDF.', true);
        return;
      }
    }

    try {
      const pdfjsLib = window.pdfjsLib;
      const typedArray = new Uint8Array(buffer);
      const pdfDoc = await pdfjsLib.getDocument({ data: typedArray }).promise;
      const totalPages = pdfDoc.numPages;

      this.showAlert(`Importing PDF — ${totalPages} page${totalPages === 1 ? '' : 's'}...`, false);
      this.saveHistoryState();

      const SCALE = 2.0; // 2× gives ~150–200 DPI equivalent
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const pdfPage = await pdfDoc.getPage(pageNum);
        const viewport = pdfPage.getViewport({ scale: SCALE });

        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);

        await pdfPage.render({
          canvasContext: canvas.getContext('2d'),
          viewport
        }).promise;

        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        this.addPage(dataUrl, true, 150);
      }

      this.showAlert(`PDF imported — ${totalPages} page${totalPages === 1 ? '' : 's'} added.`, false);
    } catch (err) {
      console.error('PDF import error:', err);
      this.showAlert(`PDF import failed: ${err.message}`, true);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.scannerApp = new ScannerApp();
});
