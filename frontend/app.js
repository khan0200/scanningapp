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

        if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
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

  static applyFiltersDataUrl(dataUrl, rotationAngle, brightness, contrast) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // 1. Rotate the image first by arbitrary rotationAngle (in degrees)
        const rad = (rotationAngle * Math.PI) / 180;
        const absCos = Math.abs(Math.cos(rad));
        const absSin = Math.abs(Math.sin(rad));

        const rotW = Math.ceil(img.width * absCos + img.height * absSin);
        const rotH = Math.ceil(img.width * absSin + img.height * absCos);

        canvas.width = rotW;
        canvas.height = rotH;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, rotW, rotH);
        ctx.translate(rotW / 2, rotH / 2);
        ctx.rotate(rad);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);

        // Reset transform
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        // 2. Apply Brightness and Contrast
        if (brightness !== 0 || contrast !== 0) {
          const imgData = ctx.getImageData(0, 0, rotW, rotH);
          const pixels = imgData.data;

          // Contrast factor
          const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

          for (let i = 0; i < pixels.length; i += 4) {
            // Brightness + Contrast for Red
            let r = pixels[i] + brightness;
            r = factor * (r - 128) + 128;
            pixels[i] = Math.max(0, Math.min(255, r));

            // Green
            let g = pixels[i+1] + brightness;
            g = factor * (g - 128) + 128;
            pixels[i+1] = Math.max(0, Math.min(255, g));

            // Blue
            let b = pixels[i+2] + brightness;
            b = factor * (b - 128) + 128;
            pixels[i+2] = Math.max(0, Math.min(255, b));
          }

          ctx.putImageData(imgData, 0, 0);
        }

        resolve({
          dataUrl: canvas.toDataURL('image/jpeg', 0.94),
          width: rotW,
          height: rotH
        });
      };
      img.src = dataUrl;
    });
  }

  static getProcessedBarcodeDataUrl(img, conf) {
    const canvas = document.createElement('canvas');
    const w = Math.round(img.width * conf.scale);
    const h = Math.round(img.height * conf.scale);

    canvas.width = w + conf.border * 2;
    canvas.height = h + conf.border * 2;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, conf.border, conf.border, w, h);

    if (conf.threshold || conf.contrast !== 0) {
      const imgData = ctx.getImageData(conf.border, conf.border, w, h);
      const pixels = imgData.data;

      if (conf.threshold) {
        let sum = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const v = 0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2];
          sum += v;
        }
        const avg = sum / (pixels.length / 4);
        const th = avg * (conf.thMultiplier !== undefined ? conf.thMultiplier : 0.9);

        for (let i = 0; i < pixels.length; i += 4) {
          const v = 0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2];
          let color = v < th ? 0 : 255;
          if (conf.inverse) {
            color = color === 0 ? 255 : 0;
          }
          pixels[i] = color;
          pixels[i+1] = color;
          pixels[i+2] = color;
        }
      } else if (conf.contrast !== 0) {
        const factor = (259 * (conf.contrast + 255)) / (255 * (259 - conf.contrast));
        for (let i = 0; i < pixels.length; i += 4) {
          const v = 0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2];
          let nv = factor * (v - 128) + 128;
          nv = Math.max(0, Math.min(255, nv));
          pixels[i] = nv;
          pixels[i+1] = nv;
          pixels[i+2] = nv;
        }
      }
      ctx.putImageData(imgData, conf.border, conf.border);
    }
    return canvas.toDataURL('image/jpeg', 0.9);
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

  static detectSubject(canvas) {
    const origW = canvas.width;
    const origH = canvas.height;

    // First, let's detect the outer page border (backing sheet) using the standard detectBorders method
    const pageBox = ImageProcessor.detectBorders(canvas);
    if (!pageBox) return null;

    // Downsample for analysis
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

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    tempCtx.drawImage(canvas, 0, 0, w, h);

    const imgData = tempCtx.getImageData(0, 0, w, h);
    const pixels = imgData.data;

    // Scale pageBox coordinates to downsampled coordinates
    const scaleX = w / origW;
    const scaleY = h / origH;

    const pageMinX = Math.max(0, Math.floor(pageBox.x * scaleX));
    const pageMinY = Math.max(0, Math.floor(pageBox.y * scaleY));
    const pageMaxX = Math.min(w - 1, Math.ceil((pageBox.x + pageBox.w) * scaleX));
    const pageMaxY = Math.min(h - 1, Math.ceil((pageBox.y + pageBox.h) * scaleY));

    // 1. Sample the backing paper color near the margins of the detected pageBox
    // We sample a margin-thick band inside the borders of pageBox
    let sumR = 0, sumG = 0, sumB = 0, sampleCount = 0;
    const margin = 8;
    for (let y = pageMinY; y <= pageMaxY; y++) {
      for (let x = pageMinX; x <= pageMaxX; x++) {
        const isNearBorder = (y < pageMinY + margin || y > pageMaxY - margin || x < pageMinX + margin || x > pageMaxX - margin);
        if (isNearBorder) {
          const idx = (y * w + x) * 4;
          sumR += pixels[idx];
          sumG += pixels[idx + 1];
          sumB += pixels[idx + 2];
          sampleCount++;
        }
      }
    }

    const bgR = sampleCount > 0 ? (sumR / sampleCount) : 230;
    const bgG = sampleCount > 0 ? (sumG / sampleCount) : 235;
    const bgB = sampleCount > 0 ? (sumB / sampleCount) : 240;

    // 2. Perform delta-thresholding against this backing page background color inside pageBox
    const thresholded = new Uint8Array(w * h);
    const colorDistThreshold = 35; // Manhattan distance threshold in RGB space

    for (let y = pageMinY; y <= pageMaxY; y++) {
      for (let x = pageMinX; x <= pageMaxX; x++) {
        const idx = (y * w + x) * 4;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];

        const dist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
        if (dist > colorDistThreshold) {
          thresholded[y * w + x] = 255;
        } else {
          thresholded[y * w + x] = 0;
        }
      }
    }

    // 3. Morphological close/dilation to fill holes inside the subject
    const closed = new Uint8Array(w * h);
    for (let y = pageMinY + 1; y < pageMaxY - 1; y++) {
      for (let x = pageMinX + 1; x < pageMaxX - 1; x++) {
        let maxVal = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = thresholded[(y + dy) * w + (x + dx)];
            if (v > maxVal) maxVal = v;
          }
        }
        closed[y * w + x] = maxVal;
      }
    }

    // 4. Connected Component Labeling on the thresholded interior subject pixels
    const labels = new Int32Array(w * h);
    let nextLabel = 1;
    const parent = [0];
    const find = (i) => {
      let root = i;
      while (parent[root] !== root) root = parent[root];
      let curr = i;
      while (curr !== root) {
        let nxt = parent[curr];
        parent[curr] = root;
        curr = nxt;
      }
      return root;
    };
    const union = (i, j) => {
      const rI = find(i);
      const rJ = find(j);
      if (rI !== rJ) parent[rI] = rJ;
    };

    for (let y = pageMinY; y <= pageMaxY; y++) {
      for (let x = pageMinX; x <= pageMaxX; x++) {
        if (closed[y * w + x] === 255) {
          const left = (x > pageMinX) ? labels[y * w + (x - 1)] : 0;
          const top = (y > pageMinY) ? labels[(y - 1) * w + x] : 0;

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
            if (left !== top) union(left, top);
          }
        }
      }
    }

    const components = {};
    for (let y = pageMinY; y <= pageMaxY; y++) {
      for (let x = pageMinX; x <= pageMaxX; x++) {
        const l = labels[y * w + x];
        if (l !== 0) {
          const rL = find(l);
          labels[y * w + x] = rL;
          if (!components[rL]) {
            components[rL] = { minX: x, maxX: x, minY: y, maxY: y, count: 0 };
          }
          const c = components[rL];
          c.count++;
          if (x < c.minX) c.minX = x;
          if (x > c.maxX) c.maxX = x;
          if (y < c.minY) c.minY = y;
          if (y > c.maxY) c.maxY = y;
        }
      }
    }

    // 5. Select the best subject component
    let bestComp = null;
    let bestScore = -1;
    const pageArea = (pageMaxX - pageMinX) * (pageMaxY - pageMinY);

    for (const label in components) {
      const c = components[label];
      const compW = c.maxX - c.minX + 1;
      const compH = c.maxY - c.minY + 1;

      // Filter A: Ignore very small specs (must be at least 1% of the page area)
      if (c.count < pageArea * 0.01) continue;

      // Filter B: If it covers basically the entire backing sheet, it's just the backing sheet border or a shadow, ignore
      if (compW >= (pageMaxX - pageMinX) - 5 && compH >= (pageMaxY - pageMinY) - 5) continue;

      let score = c.count;
      const aspect = compW / compH;
      if (aspect > 0.4 && aspect < 2.5) {
        score *= 1.3;
      }

      if (score > bestScore) {
        bestScore = score;
        bestComp = c;
      }
    }

    // Fallback: If no distinct subject is found inside the backing sheet, return pageBox (the backing page itself)
    if (!bestComp) {
      return pageBox;
    }

    const invScaleX = origW / w;
    const invScaleY = origH / h;

    let finalMinX = Math.round(bestComp.minX * invScaleX);
    let finalMaxX = Math.round((bestComp.maxX + 1) * invScaleX);
    let finalMinY = Math.round(bestComp.minY * invScaleY);
    let finalMaxY = Math.round((bestComp.maxY + 1) * invScaleY);

    // Add padding
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

  static processSubjectBW(dataUrl, cropX, cropY, cropW, cropH) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropW;
        cropCanvas.height = cropH;
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        const imgData = cropCtx.getImageData(0, 0, cropW, cropH);
        const pixels = imgData.data;

        const gray = new Uint8Array(cropW * cropH);
        const histogram = new Int32Array(256);
        for (let i = 0; i < cropW * cropH; i++) {
          const r = pixels[i * 4];
          const g = pixels[i * 4 + 1];
          const b = pixels[i * 4 + 2];
          const val = (r * 77 + g * 150 + b * 29) >> 8;
          gray[i] = val;
          histogram[val]++;
        }

        let total = cropW * cropH;
        let sum = 0;
        for (let t = 0; t < 256; t++) sum += t * histogram[t];

        let sumB = 0;
        let wB = 0;
        let wF = 0;
        let varMax = 0;
        let threshold = 127;

        for (let t = 0; t < 256; t++) {
          wB += histogram[t];
          if (wB === 0) continue;
          wF = total - wB;
          if (wF === 0) break;

          sumB += t * histogram[t];
          let mB = sumB / wB;
          let mF = (sum - sumB) / wF;

          let varBetween = wB * wF * (mB - mF) * (mB - mF);
          if (varBetween > varMax) {
            varMax = varBetween;
            threshold = t;
          }
        }

        let minBlackX = cropW;
        let maxBlackX = 0;
        let minBlackY = cropH;
        let maxBlackY = 0;
        let blackCount = 0;

        for (let y = 0; y < cropH; y++) {
          for (let x = 0; x < cropW; x++) {
            const idx = y * cropW + x;
            const isBlack = gray[idx] < threshold;
            const pIdx = idx * 4;

            if (isBlack) {
              pixels[pIdx] = 0;
              pixels[pIdx + 1] = 0;
              pixels[pIdx + 2] = 0;
              if (x < minBlackX) minBlackX = x;
              if (x > maxBlackX) maxBlackX = x;
              if (y < minBlackY) minBlackY = y;
              if (y > maxBlackY) maxBlackY = y;
              blackCount++;
            } else {
              pixels[pIdx] = 255;
              pixels[pIdx + 1] = 255;
              pixels[pIdx + 2] = 255;
            }
            pixels[pIdx + 3] = 255;
          }
        }

        cropCtx.putImageData(imgData, 0, 0);

        if (blackCount > 100 && minBlackX < maxBlackX && minBlackY < maxBlackY) {
          const padding = 3;
          const tightX = Math.max(0, minBlackX - padding);
          const tightY = Math.max(0, minBlackY - padding);
          const tightW = Math.min(cropW - tightX, (maxBlackX - minBlackX + 1) + padding * 2);
          const tightH = Math.min(cropH - tightY, (maxBlackY - minBlackY + 1) + padding * 2);

          const finalCanvas = document.createElement('canvas');
          finalCanvas.width = tightW;
          finalCanvas.height = tightH;
          const finalCtx = finalCanvas.getContext('2d');
          finalCtx.drawImage(cropCanvas, tightX, tightY, tightW, tightH, 0, 0, tightW, tightH);

          resolve({
            dataUrl: finalCanvas.toDataURL('image/jpeg', 0.90),
            width: tightW,
            height: tightH
          });
        } else {
          resolve({
            dataUrl: cropCanvas.toDataURL('image/jpeg', 0.90),
            width: cropW,
            height: cropH
          });
        }
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
    this.selectedIndices = new Set();
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
    this.btnDuplicate = document.getElementById('btnDuplicate');
    this.btnRotateLeft = document.getElementById('btnRotateLeft');
    this.btnRotateRight = document.getElementById('btnRotateRight');
    this.btnDelete = document.getElementById('btnDelete');
    this.btnExportMenu = document.getElementById('btnExportMenu');
    this.btnSavePdfCurrent = document.getElementById('btnSavePdfCurrent');
    this.btnSavePdfSelected = document.getElementById('btnSavePdfSelected');
    this.btnSavePdfAll = document.getElementById('btnSavePdfAll');
    this.btnSaveJpgCurrent = document.getElementById('btnSaveJpgCurrent');
    this.btnSaveJpgSelected = document.getElementById('btnSaveJpgSelected');
    this.btnSaveJpgAll = document.getElementById('btnSaveJpgAll');
    this.selectAllPages = document.getElementById('selectAllPages');
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
    this.cropMagnifier = document.getElementById('cropMagnifier');
    this.cropBox = document.getElementById('cropBox');
    this.cropDimensions = document.getElementById('cropDimensions');
    this.btnAutoDetect = document.getElementById('btnAutoDetect');
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

    // New Features & Modals elements
    this.btnAdjust = document.getElementById('btnAdjust');
    this.btnBarcode = document.getElementById('btnBarcode');

    this.adjustModalEl = document.getElementById('adjustModal');
    this.adjustCanvas = document.getElementById('adjustCanvas');
    this.adjustBrightness = document.getElementById('adjustBrightness');
    this.adjustContrast = document.getElementById('adjustContrast');
    this.adjustRotate = document.getElementById('adjustRotate');
    this.btnResetAdjust = document.getElementById('btnResetAdjust');
    this.btnApplyAdjust = document.getElementById('btnApplyAdjust');

    this.barcodeModalEl = document.getElementById('barcodeModal');
    this.barcodeContainer = document.getElementById('barcodeContainer');

    // PDF Preview Modal elements
    this.pdfPreviewModalEl = document.getElementById('pdfPreviewModal');
    this.pdfPreviewGrid = document.getElementById('pdfPreviewGrid');
    this.pdfTotalPagesText = document.getElementById('pdfTotalPagesText');
    this.pdfSelectedCountText = document.getElementById('pdfSelectedCountText');
    this.btnPdfSelectAll = document.getElementById('btnPdfSelectAll');
    this.btnPdfDeselectAll = document.getElementById('btnPdfDeselectAll');
    this.btnConfirmPdfImport = document.getElementById('btnConfirmPdfImport');
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
      this.updateMagnifier();
    });

    window.addEventListener('mouseup', () => {
      this.cropState.isDragging = false;
      this.cropState.activeHandle = null;
      this.cropBox.style.cursor = 'move';
      this.hideMagnifier();
    });

    if (this.btnResetCrop) {
      this.btnResetCrop.addEventListener('click', () => this.resetCropBox());
    }
    if (this.btnAutoDetect) {
      this.btnAutoDetect.addEventListener('click', () => this.autoDetectSubject());
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

  updateMagnifier() {
    if (!this.cropMagnifier || !this.cropCanvas) return;

    const h = this.cropState.activeHandle;
    if (!h || h === 'move' || !this.cropState.isDragging) {
      this.hideMagnifier();
      return;
    }

    const canvasW = this.cropState.canvasW;
    const canvasH = this.cropState.canvasH;
    const boxX = this.cropState.boxX;
    const boxY = this.cropState.boxY;
    const boxW = this.cropState.boxW;
    const boxH = this.cropState.boxH;

    // Calculate focus point on the display canvas
    let focusX = 0;
    let focusY = 0;

    if (h === 'handle-nw') {
      focusX = boxX;
      focusY = boxY;
    } else if (h === 'handle-ne') {
      focusX = boxX + boxW;
      focusY = boxY;
    } else if (h === 'handle-se') {
      focusX = boxX + boxW;
      focusY = boxY + boxH;
    } else if (h === 'handle-sw') {
      focusX = boxX;
      focusY = boxY + boxH;
    } else if (h === 'handle-n') {
      focusX = boxX + boxW / 2;
      focusY = boxY;
    } else if (h === 'handle-s') {
      focusX = boxX + boxW / 2;
      focusY = boxY + boxH;
    } else if (h === 'handle-e') {
      focusX = boxX + boxW;
      focusY = boxY + boxH / 2;
    } else if (h === 'handle-w') {
      focusX = boxX;
      focusY = boxY + boxH / 2;
    } else {
      this.hideMagnifier();
      return;
    }

    // Determine target location for the floating magnifier (opposite quadrant)
    let posX = 10;
    let posY = 10;
    if (focusX < canvasW / 2) {
      posX = canvasW - 130;
    }
    if (focusY < canvasH / 2) {
      posY = canvasH - 130;
    }

    // Set position and show magnifier
    this.cropMagnifier.style.left = `${posX}px`;
    this.cropMagnifier.style.top = `${posY}px`;
    this.cropMagnifier.style.display = 'block';

    const ctx = this.cropMagnifier.getContext('2d');
    if (!ctx) return;

    const magSize = 120;
    const zoom = 3;
    const srcSize = magSize / zoom; // 40px

    const sx = focusX - srcSize / 2;
    const sy = focusY - srcSize / 2;

    // Fill white background in case selection goes out of image bounds
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, magSize, magSize);

    // Draw the zoomed region from the image canvas
    ctx.drawImage(this.cropCanvas, sx, sy, srcSize, srcSize, 0, 0, magSize, magSize);

    // Draw crop boundaries in high-contrast dashed lines
    const mx1 = (boxX - sx) * zoom;
    const my1 = (boxY - sy) * zoom;
    const mx2 = (boxX + boxW - sx) * zoom;
    const my2 = (boxY + boxH - sy) * zoom;

    ctx.strokeStyle = '#0d6efd';
    ctx.lineWidth = 2 * zoom; // 6px thick line for high visibility at 3x zoom
    ctx.setLineDash([4 * zoom, 4 * zoom]); // 12px dashes
    ctx.strokeRect(mx1, my1, mx2 - mx1, my2 - my1);

    // Draw the active handle indicator (solid blue circle with white border) in the center of the magnifier
    ctx.fillStyle = '#0d6efd';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(magSize / 2, magSize / 2, 6, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }

  hideMagnifier() {
    if (this.cropMagnifier) {
      this.cropMagnifier.style.display = 'none';
    }
  }

  openAdjustModal() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.pages.length) return;

    const page = this.pages[this.selectedIndex];
    
    // Reset sliders
    this.adjustBrightness.value = 0;
    this.adjustContrast.value = 0;
    this.adjustRotate.value = 0;
    
    document.getElementById('brightnessVal').textContent = '0';
    document.getElementById('contrastVal').textContent = '0';
    document.getElementById('rotateVal').textContent = '0°';

    // Store the original image
    this.adjustOriginalImage = new Image();
    this.adjustOriginalImage.onload = () => {
      // Downsample for fast real-time preview adjustments
      const maxW = 700;
      const maxH = 450;
      const img = this.adjustOriginalImage;
      let scale = Math.min(1.0, Math.min(maxW / img.width, maxH / img.height));

      this.adjustPreviewW = Math.round(img.width * scale);
      this.adjustPreviewH = Math.round(img.height * scale);

      // Create a downsampled cache image for 60fps rendering during slider adjustments
      const cacheCanvas = document.createElement('canvas');
      cacheCanvas.width = this.adjustPreviewW;
      cacheCanvas.height = this.adjustPreviewH;
      const cacheCtx = cacheCanvas.getContext('2d');
      cacheCtx.drawImage(img, 0, 0, this.adjustPreviewW, this.adjustPreviewH);

      this.adjustPreviewCache = new Image();
      this.adjustPreviewCache.onload = () => {
        this.updateAdjustPreview();
        
        if (window.bootstrap && this.adjustModalEl) {
          if (!this.adjustModalInstance) {
            this.adjustModalInstance = new bootstrap.Modal(this.adjustModalEl);
          }
          this.adjustModalInstance.show();
        }
      };
      this.adjustPreviewCache.src = cacheCanvas.toDataURL('image/jpeg', 0.9);
    };
    
    // Use the image rotated by its standard 90deg steps as base if any
    ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation).then((rotatedDataUrl) => {
      this.adjustOriginalImage.src = rotatedDataUrl;
    });
  }

  updateAdjustPreview() {
    if (!this.adjustPreviewCache || !this.adjustCanvas) return;

    const brightness = parseInt(this.adjustBrightness.value, 10);
    const contrast = parseInt(this.adjustContrast.value, 10);
    const angle = parseInt(this.adjustRotate.value, 10);

    document.getElementById('brightnessVal').textContent = brightness > 0 ? `+${brightness}` : brightness;
    document.getElementById('contrastVal').textContent = contrast > 0 ? `+${contrast}` : contrast;
    document.getElementById('rotateVal').textContent = `${angle}°`;

    const img = this.adjustPreviewCache;
    const canvas = this.adjustCanvas;
    const ctx = canvas.getContext('2d');

    // 1. Calculate rotated size
    const rad = (angle * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(rad));
    const absSin = Math.abs(Math.sin(rad));

    const rotW = Math.ceil(img.width * absCos + img.height * absSin);
    const rotH = Math.ceil(img.width * absSin + img.height * absCos);

    canvas.width = rotW;
    canvas.height = rotH;

    // 2. Draw rotated image
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rotW, rotH);
    ctx.translate(rotW / 2, rotH / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset

    // 3. Apply Brightness and Contrast
    if (brightness !== 0 || contrast !== 0) {
      const imgData = ctx.getImageData(0, 0, rotW, rotH);
      const pixels = imgData.data;

      const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

      for (let i = 0; i < pixels.length; i += 4) {
        let r = pixels[i] + brightness;
        r = factor * (r - 128) + 128;
        pixels[i] = Math.max(0, Math.min(255, r));

        let g = pixels[i+1] + brightness;
        g = factor * (g - 128) + 128;
        pixels[i+1] = Math.max(0, Math.min(255, g));

        let b = pixels[i+2] + brightness;
        b = factor * (b - 128) + 128;
        pixels[i+2] = Math.max(0, Math.min(255, b));
      }
      ctx.putImageData(imgData, 0, 0);
    }
  }

  async applyAdjustments() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.pages.length) return;

    const page = this.pages[this.selectedIndex];
    const brightness = parseInt(this.adjustBrightness.value, 10);
    const contrast = parseInt(this.adjustContrast.value, 10);
    const angle = parseInt(this.adjustRotate.value, 10);

    if (brightness === 0 && contrast === 0 && angle === 0) {
      if (this.adjustModalInstance) this.adjustModalInstance.hide();
      return;
    }

    const btn = document.getElementById('btnApplyAdjust');
    const oldText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Applying...';

    // Run in setTimeout to prevent blocking the UI thread spinner
    setTimeout(async () => {
      try {
        const result = await ImageProcessor.applyFiltersDataUrl(
          this.adjustOriginalImage.src,
          angle,
          brightness,
          contrast
        );

        if (result && result.dataUrl) {
          this.saveHistoryState();
          page.dataUrl = result.dataUrl;
          page.width = result.width;
          page.height = result.height;
          page.rotation = 0; // reset rotation since it's baked in

          this.renderThumbnails();
          this.updateUI();
          this.syncSession();

          if (this.adjustModalInstance) {
            this.adjustModalInstance.hide();
          }
          this.showAlert('Adjustments applied successfully.', false);
        }
      } catch (err) {
        console.warn('Adjustments apply error:', err);
        this.showAlert('Failed to apply image adjustments.', true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldText;
      }
    }, 50);
  }

  async detectBarcodes() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.pages.length) return;

    if (typeof ZXing === 'undefined') {
      this.showAlert('Barcode detection library is still loading. Please try again in a moment.', true);
      return;
    }

    const btn = document.getElementById('btnBarcode');
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Detecting...';

    const page = this.pages[this.selectedIndex];
    
    // Draw page on a full resolution canvas
    const img = new Image();
    img.onload = async () => {
      try {
        // Multi-pass intelligent pre-processing configuration list
        const configs = [
          { name: 'Original', border: 0, threshold: false, contrast: 0, scale: 1.0 },
          { name: 'Quiet Zone Helper', border: 40, threshold: false, contrast: 0, scale: 1.0 },
          { name: 'Contrast + Border', border: 40, threshold: false, contrast: 60, scale: 1.0 },
          { name: 'Binarized + Border', border: 40, threshold: true, thMultiplier: 0.9, scale: 1.0 },
          { name: 'Inverse Binarized', border: 40, threshold: true, inverse: true, thMultiplier: 0.9, scale: 1.0 },
          { name: 'Downscaled + Border', border: 30, threshold: false, contrast: 0, scale: 0.5 },
          { name: 'Upscaled + Binarized', border: 40, threshold: true, thMultiplier: 0.9, scale: 1.5 }
        ];

        let result = null;
        let lastErr = null;

        for (const conf of configs) {
          // Skip downscaling if image is already small
          if (conf.scale < 1.0 && img.width < 800 && img.height < 800) continue;
          // Skip upscaling if image is already large
          if (conf.scale > 1.0 && (img.width > 1200 || img.height > 1200)) continue;

          try {
            const dataUrl = ImageProcessor.getProcessedBarcodeDataUrl(img, conf);
            const candidateImg = new Image();
            
            result = await new Promise((resolve, reject) => {
              candidateImg.onload = async () => {
                try {
                  const hints = new Map();
                  hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
                  const reader = new window.ZXing.BrowserMultiFormatReader(hints);
                  const res = await reader.decodeFromImageElement(candidateImg);
                  resolve(res);
                } catch (e) {
                  reject(e);
                }
              };
              candidateImg.onerror = () => reject(new Error('Failed to load preprocessed candidate image'));
              candidateImg.src = dataUrl;
            });

            console.log(`Barcode scanned successfully using pass: "${conf.name}"`, conf);
            break; // Succeeded! Exit the loop.
          } catch (e) {
            lastErr = e;
          }
        }

        if (!result) {
          throw lastErr || new Error('No barcode or QR code detected.');
        }

        // Decode successful!
        const text = result.getText();
        const format = result.getBarcodeFormat();
        
        let formatName = 'Barcode';
        if (format === 11) formatName = 'QR Code';
        else if (format === 0) formatName = 'Aztec';
        else if (format === 2) formatName = 'Codabar';
        else if (format === 3) formatName = 'Code 39';
        else if (format === 4) formatName = 'Code 93';
        else if (format === 5) formatName = 'Code 128';
        else if (format === 6) formatName = 'Data Matrix';
        else if (format === 7) formatName = 'EAN-8';
        else if (format === 8) formatName = 'EAN-13';
        else if (format === 9) formatName = 'ITF';
        else if (format === 10) formatName = 'MaxiCode';
        else if (format === 12) formatName = 'PDF417';
        else if (format === 13) formatName = 'RSS 14';
        else if (format === 14) formatName = 'RSS Expanded';
        else if (format === 15) formatName = 'UPC-A';
        else if (format === 16) formatName = 'UPC-E';
        else if (format === 17) formatName = 'UPC/EAN Extension';

        // Display results in the modal
        const container = document.getElementById('barcodeContainer');
        container.innerHTML = `
          <div class="alert alert-success d-flex align-items-center gap-2 py-2 px-3 mb-3">
            <i class="bi bi-check-circle-fill fs-5 text-success"></i>
            <div><strong>Success!</strong> Detected 1 barcode/QR code on the document.</div>
          </div>
          <div class="card shadow-sm border border-success-subtle mb-0">
            <div class="card-header py-2 bg-success bg-opacity-10 fw-bold small text-success-emphasis text-uppercase d-flex justify-content-between align-items-center">
              <span>Code Type: ${formatName}</span>
              <span class="badge bg-success bg-opacity-70">${format}</span>
            </div>
            <div class="card-body p-3 bg-white">
              <pre class="bg-light p-2 border rounded text-wrap word-break" style="font-family: monospace; max-height: 200px; overflow-y: auto;">${this.escapeHtml(text)}</pre>
              <button class="btn btn-outline-success btn-sm w-100 fw-semibold mt-2 d-flex align-items-center justify-content-center gap-1" id="btnCopyBarcode">
                <i class="bi bi-clipboard"></i> Copy Contents
              </button>
            </div>
          </div>
        `;

        // Bind copy button
        document.getElementById('btnCopyBarcode').addEventListener('click', () => {
          navigator.clipboard.writeText(text).then(() => {
            const btnCopy = document.getElementById('btnCopyBarcode');
            btnCopy.innerHTML = '<i class="bi bi-check2"></i> Copied!';
            btnCopy.className = 'btn btn-success btn-sm w-100 fw-semibold mt-2';
            setTimeout(() => {
              btnCopy.innerHTML = '<i class="bi bi-clipboard"></i> Copy Contents';
              btnCopy.className = 'btn btn-outline-success btn-sm w-100 fw-semibold mt-2';
            }, 1500);
          });
        });

        // Show the results modal
        if (window.bootstrap) {
          const modalEl = document.getElementById('barcodeModal');
          const inst = new bootstrap.Modal(modalEl);
          inst.show();
        }

      } catch (err) {
        if (err.name === 'NotFoundException' || err.message?.includes('No MultiFormatReader')) {
          this.showAlert('No barcodes or QR codes detected on the current page. Ensure it is clear and correctly oriented.', true);
        } else {
          console.warn('Barcode error:', err);
          this.showAlert('Barcode detection failed: ' + err.message, true);
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    };
    img.src = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);
  }

  escapeHtml(unsafe) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
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

  autoDetectSubject() {
    // Internally perform B&W Otsu thresholding on the current canvas
    // to find the tightest bounding box of black (document) pixels,
    // then update the crop box WITHOUT modifying the page image.
    if (this.btnAutoDetect) {
      this.btnAutoDetect.disabled = true;
      this.btnAutoDetect.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Detecting...';
    }

    setTimeout(() => {
      try {
        const canvas = this.cropCanvas;
        const cW = canvas.width;
        const cH = canvas.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const imgData = ctx.getImageData(0, 0, cW, cH);
        const pixels = imgData.data;

        // Step 1: Convert to grayscale
        const gray = new Uint8Array(cW * cH);
        const histogram = new Int32Array(256);
        for (let i = 0; i < cW * cH; i++) {
          const r = pixels[i * 4];
          const g = pixels[i * 4 + 1];
          const b = pixels[i * 4 + 2];
          const v = (r * 77 + g * 150 + b * 29) >> 8;
          gray[i] = v;
          histogram[v]++;
        }

        // Step 2: Otsu's threshold
        const total = cW * cH;
        let sum = 0;
        for (let t = 0; t < 256; t++) sum += t * histogram[t];
        let sumB = 0, wB = 0, varMax = 0, threshold = 127;
        for (let t = 0; t < 256; t++) {
          wB += histogram[t];
          if (wB === 0) continue;
          const wF = total - wB;
          if (wF === 0) break;
          sumB += t * histogram[t];
          const mB = sumB / wB;
          const mF = (sum - sumB) / wF;
          const varBetween = wB * wF * (mB - mF) * (mB - mF);
          if (varBetween > varMax) { varMax = varBetween; threshold = t; }
        }

        // Step 3: Build binary image (1 = dark/subject, 0 = light/background)
        const binary = new Uint8Array(cW * cH);
        for (let i = 0; i < cW * cH; i++) {
          binary[i] = gray[i] < threshold ? 1 : 0;
        }

        // Step 4: Connected Component Labeling (union-find) to find the LARGEST black blob
        const labels = new Int32Array(cW * cH);
        const parent = [0];
        let nextLabel = 1;

        const find = (x) => {
          while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
          return x;
        };
        const union = (a, b) => {
          const ra = find(a), rb = find(b);
          if (ra !== rb) parent[ra] = rb;
        };

        for (let y = 0; y < cH; y++) {
          for (let x = 0; x < cW; x++) {
            if (!binary[y * cW + x]) continue;
            const left  = x > 0 ? labels[y * cW + (x - 1)] : 0;
            const top   = y > 0 ? labels[(y - 1) * cW + x] : 0;
            if (left === 0 && top === 0) {
              labels[y * cW + x] = nextLabel;
              parent[nextLabel] = nextLabel;
              nextLabel++;
            } else if (left !== 0 && top === 0) {
              labels[y * cW + x] = left;
            } else if (left === 0 && top !== 0) {
              labels[y * cW + x] = top;
            } else {
              labels[y * cW + x] = left;
              union(left, top);
            }
          }
        }

        // Step 5: Collect component stats
        const comps = {}; // { root: { count, minX, maxX, minY, maxY } }
        for (let y = 0; y < cH; y++) {
          for (let x = 0; x < cW; x++) {
            const l = labels[y * cW + x];
            if (l === 0) continue;
            const root = find(l);
            if (!comps[root]) comps[root] = { count: 0, minX: cW, maxX: 0, minY: cH, maxY: 0 };
            const c = comps[root];
            c.count++;
            if (x < c.minX) c.minX = x;
            if (x > c.maxX) c.maxX = x;
            if (y < c.minY) c.minY = y;
            if (y > c.maxY) c.maxY = y;
          }
        }

        // Step 6: Find the LARGEST component (by pixel count), ignoring components
        // that fill the entire canvas (those are page background/shadow)
        let best = null;
        for (const root in comps) {
          const c = comps[root];
          const bW = c.maxX - c.minX + 1;
          const bH = c.maxY - c.minY + 1;
          // Reject components that span nearly the full canvas (backing paper shadow)
          if (bW >= cW - 5 && bH >= cH - 5) continue;
          // Reject tiny specks (less than 0.5% of canvas)
          if (c.count < total * 0.005) continue;
          if (!best || c.count > best.count) best = c;
        }

        if (best) {
          const padding = 6;
          this.cropState.boxX = Math.max(0, best.minX - padding);
          this.cropState.boxY = Math.max(0, best.minY - padding);
          this.cropState.boxW = Math.min(cW - this.cropState.boxX, (best.maxX - best.minX + 1) + padding * 2);
          this.cropState.boxH = Math.min(cH - this.cropState.boxY, (best.maxY - best.minY + 1) + padding * 2);
          this.updateCropBoxDOM();
        } else {
          // Fallback to page border detection
          this.autoDetectCropBox();
        }
      } catch (e) {
        console.warn('Auto detect error:', e);
        this.autoDetectCropBox();
      } finally {
        if (this.btnAutoDetect) {
          this.btnAutoDetect.disabled = false;
          this.btnAutoDetect.innerHTML = '<i class="bi bi-stars me-1"></i>Auto Detect';
        }
      }
    }, 10);
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
    if (this.btnDuplicate) {
      this.btnDuplicate.addEventListener('click', () => this.duplicateSelected());
    }
    this.btnRotateLeft.addEventListener('click', () => this.rotateSelected(-90));
    this.btnRotateRight.addEventListener('click', () => this.rotateSelected(90));
    if (this.btnDelete) {
      this.btnDelete.addEventListener('click', () => this.deleteSelected());
    }
    if (this.btnSavePdfCurrent) this.btnSavePdfCurrent.addEventListener('click', () => this.exportPdf('current'));
    if (this.btnSavePdfSelected) this.btnSavePdfSelected.addEventListener('click', () => this.exportPdf('selected'));
    if (this.btnSavePdfAll) this.btnSavePdfAll.addEventListener('click', () => this.exportPdf('all'));

    if (this.btnSaveJpgCurrent) this.btnSaveJpgCurrent.addEventListener('click', () => this.exportJpg('current'));
    if (this.btnSaveJpgSelected) this.btnSaveJpgSelected.addEventListener('click', () => this.exportJpg('selected'));
    if (this.btnSaveJpgAll) this.btnSaveJpgAll.addEventListener('click', () => this.exportJpg('all'));

    if (this.selectAllPages) {
      this.selectAllPages.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.pages.forEach((_, i) => this.selectedIndices.add(i));
        } else {
          this.selectedIndices.clear();
        }
        this.renderThumbnails();
        this.updateUI();
      });
    }

    // Zoom events
    this.btnZoomIn.addEventListener('click', () => this.setZoom(this.zoomScale + 0.25));
    this.btnZoomOut.addEventListener('click', () => this.setZoom(this.zoomScale - 0.25));
    this.btnZoomReset.addEventListener('click', () => this.setZoom(1.0));

    // Alert dismissal
    this.btnCloseAlert.addEventListener('click', () => this.hideAlert());

    // Adjustments triggers
    if (this.btnAdjust) {
      this.btnAdjust.addEventListener('click', () => this.openAdjustModal());
    }
    if (this.btnResetAdjust) {
      this.btnResetAdjust.addEventListener('click', () => {
        this.adjustBrightness.value = 0;
        this.adjustContrast.value = 0;
        this.adjustRotate.value = 0;
        this.updateAdjustPreview();
      });
    }
    if (this.btnApplyAdjust) {
      this.btnApplyAdjust.addEventListener('click', () => this.applyAdjustments());
    }

    // Sliders real-time update
    const updatePreviewOnInput = () => this.updateAdjustPreview();
    if (this.adjustBrightness) {
      this.adjustBrightness.addEventListener('input', updatePreviewOnInput);
    }
    if (this.adjustContrast) {
      this.adjustContrast.addEventListener('input', updatePreviewOnInput);
    }
    if (this.adjustRotate) {
      this.adjustRotate.addEventListener('input', updatePreviewOnInput);
    }

    // Barcode trigger
    if (this.btnBarcode) {
      this.btnBarcode.addEventListener('click', () => this.detectBarcodes());
    }

    // PDF Preview selection events
    if (this.btnPdfSelectAll) {
      this.btnPdfSelectAll.addEventListener('click', () => this.toggleAllPdfPages(true));
    }
    if (this.btnPdfDeselectAll) {
      this.btnPdfDeselectAll.addEventListener('click', () => this.toggleAllPdfPages(false));
    }
    if (this.btnConfirmPdfImport) {
      this.btnConfirmPdfImport.addEventListener('click', () => this.confirmPdfImport());
    }

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

    // Clipboard Paste listener
    window.addEventListener('paste', (e) => {
      const active = document.activeElement;
      const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
      if (isInput) return;

      if (e.clipboardData && e.clipboardData.items) {
        const items = Array.from(e.clipboardData.items);
        const files = Array.from(e.clipboardData.files || []);
        let hasImported = false;

        items.forEach((item) => {
          if (item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            if (blob) {
              hasImported = true;
              this.saveHistoryState();
              const reader = new FileReader();
              reader.onload = (event) => {
                this.addPage(event.target.result, true, 300);
                this.showAlert('Image pasted from clipboard.', false);
              };
              reader.readAsDataURL(blob);
            }
          } else if (item.type === 'application/pdf') {
            const blob = item.getAsFile();
            if (blob) {
              hasImported = true;
              const reader = new FileReader();
              reader.onload = (event) => {
                this.importPdfFromArrayBuffer(event.target.result);
              };
              reader.readAsArrayBuffer(blob);
            }
          }
        });

        if (!hasImported && files.length > 0) {
          const imgFiles = files.filter((f) => f.type.startsWith('image/'));
          const pdfFiles = files.filter((f) => f.type === 'application/pdf');

          if (imgFiles.length > 0) {
            hasImported = true;
            this.saveHistoryState();
            imgFiles.forEach((file) => {
              const reader = new FileReader();
              reader.onload = (event) => this.addPage(event.target.result, true, 300);
              reader.readAsDataURL(file);
            });
            this.showAlert(`${imgFiles.length} image(s) pasted from clipboard.`, false);
          }

          pdfFiles.forEach((file) => {
            hasImported = true;
            const reader = new FileReader();
            reader.onload = (event) => this.importPdfFromArrayBuffer(event.target.result);
            reader.readAsArrayBuffer(file);
          });
        }
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
        } else if (key === 'd') {
          e.preventDefault();
          this.duplicateSelected();
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

    const selectedScanner = this.scanners.find(s => s.id === this.scannerSelect.value);
    const scannerName = selectedScanner ? selectedScanner.name : (this.scannerSelect.options[this.scannerSelect.selectedIndex]?.textContent || '');

    const payload = {
      scannerId: this.scannerSelect.value,
      scannerName: scannerName,
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
    if (!isError) {
      // Suppress success notifications
      return;
    }
    this.alertText.textContent = msg;
    this.alertBanner.className = 'alert alert-danger alert-dismissible fade show mb-0 rounded-0';
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

  async rotateSelected(delta) {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
      this.saveHistoryState();
      const page = this.pages[this.selectedIndex];
      
      this.btnRotateLeft.disabled = true;
      this.btnRotateRight.disabled = true;

      try {
        const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, delta);
        page.dataUrl = rotatedDataUrl;

        // Swap width and height for 90/270 deg rotation
        if (delta === 90 || delta === -90 || delta === 270 || delta === -270) {
          const temp = page.width;
          page.width = page.height;
          page.height = temp;
        }

        // Visual rotation is now baked into the image data
        page.rotation = 0;

        this.renderThumbnails();
        this.updatePreview();
        this.syncSession();
      } catch (err) {
        console.warn('Rotation error:', err);
      } finally {
        this.btnRotateLeft.disabled = false;
        this.btnRotateRight.disabled = false;
        this.updateUI();
      }
    }
  }

  duplicateSelected() {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
      this.duplicatePage(this.selectedIndex);
    }
  }

  duplicatePage(index) {
    if (index >= 0 && index < this.pages.length) {
      this.saveHistoryState();
      const src = this.pages[index];
      const copy = new DocumentPage(null, src.dataUrl, src.width, src.height, src.dpi);
      copy.rotation = src.rotation || 0;
      this.pages.splice(index + 1, 0, copy);
      this.selectedIndices.clear();
      this.selectedIndex = index + 1;
      this.renderThumbnails();
      this.updateUI();
      this.syncSession();
      this.showAlert(`Page ${index + 1} duplicated.`, false);
    }
  }

  deleteSelected() {
    if (this.selectedIndices.size > 0) {
      this.saveHistoryState();
      // Sort indices descending to splice safely from the back
      const indices = Array.from(this.selectedIndices).sort((a, b) => b - a);
      indices.forEach((idx) => {
        if (idx >= 0 && idx < this.pages.length) {
          this.pages.splice(idx, 1);
        }
      });
      this.selectedIndices.clear();
      // Adjust selected index
      if (this.pages.length === 0) {
        this.selectedIndex = -1;
      } else if (this.selectedIndex >= this.pages.length) {
        this.selectedIndex = this.pages.length - 1;
      } else {
        this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.pages.length - 1));
      }
      this.renderThumbnails();
      this.updateUI();
      this.syncSession();
      this.showAlert(`${indices.length} pages deleted.`, false);
    } else if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
      this.saveHistoryState();
      this.pages.splice(this.selectedIndex, 1);
      this.selectedIndices.clear();
      if (this.selectedIndex >= this.pages.length) {
        this.selectedIndex = this.pages.length - 1;
      }
      this.renderThumbnails();
      this.updateUI();
      this.syncSession();
      this.showAlert(`Page deleted.`, false);
    }
  }

  deletePage(index) {
    if (index >= 0 && index < this.pages.length) {
      this.saveHistoryState();
      this.pages.splice(index, 1);
      this.selectedIndices.clear();
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
      this.showAlert(`Page ${index + 1} deleted. Click Undo to restore.`, false);
    }
  }

  clearAll() {
    if (this.pages.length === 0) return;
    if (confirm('Are you sure you want to clear all document pages?')) {
      this.saveHistoryState();
      this.pages = [];
      this.selectedIndex = -1;
      this.selectedIndices.clear();
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
      const isChecked = this.selectedIndices.has(idx);
      const item = document.createElement('div');
      item.className = `card thumbnail-item mb-2 p-2 shadow-sm ${idx === this.selectedIndex ? 'active border-primary' : ''}`;
      item.addEventListener('click', () => this.selectPage(idx));

      item.innerHTML = `
        <div class="d-flex align-items-center gap-2 w-100">
          <input type="checkbox" class="form-check-input page-checkbox m-0" data-index="${idx}" ${isChecked ? 'checked' : ''} title="Select page for saving" style="cursor: pointer;">
          <div class="thumbnail-drag-handle px-1" title="Drag to reorder">
            <i class="bi bi-grip-vertical fs-5"></i>
          </div>
          <span class="badge ${idx === this.selectedIndex ? 'bg-primary' : 'bg-secondary'} rounded-circle p-2" style="width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-size: 10px;">${idx + 1}</span>
          <div class="thumbnail-img-box">
            <img class="thumbnail-img" src="${page.dataUrl}" style="transform: rotate(${page.rotation}deg)">
          </div>
          <div class="d-flex flex-column text-truncate" style="flex: 1;">
            <span class="fw-bold small text-dark">Page ${idx + 1}</span>
            <span class="text-muted thumbnail-meta-text" style="font-size: 10px;">
              ${((page.width / (page.dpi || 300)) * 25.4).toFixed(1)} × ${((page.height / (page.dpi || 300)) * 25.4).toFixed(1)} mm ${page.rotation ? `(${page.rotation}°)` : ''}
            </span>
          </div>
          <button class="btn btn-sm btn-link text-primary p-1 btn-duplicate-thumbnail me-1" title="Duplicate Page" style="text-decoration: none;">
            <i class="bi bi-copy fs-6" style="pointer-events: none;"></i>
          </button>
          <button class="btn btn-sm btn-link text-danger p-1 btn-delete-thumbnail" title="Delete Page" style="text-decoration: none;">
            <i class="bi bi-trash fs-6" style="pointer-events: none;"></i>
          </button>
        </div>
      `;

      const chk = item.querySelector('.page-checkbox');
      if (chk) {
        chk.addEventListener('click', (e) => {
          e.stopPropagation();
          if (chk.checked) {
            this.selectedIndices.add(idx);
          } else {
            this.selectedIndices.delete(idx);
          }
          this.syncSelectAllCheckbox();
          this.updateUI();
        });
      }

      const dupBtn = item.querySelector('.btn-duplicate-thumbnail');
      if (dupBtn) {
        dupBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.duplicatePage(idx);
        });
      }

      const delBtn = item.querySelector('.btn-delete-thumbnail');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deletePage(idx);
        });
      }

      this.thumbnailList.appendChild(item);
    });

    this.syncSelectAllCheckbox();
    this.thumbnailCount.textContent = `${this.pages.length} item${this.pages.length === 1 ? '' : 's'}`;
    this.pageCounter.textContent = `${this.pages.length} Page${this.pages.length === 1 ? '' : 's'}`;
  }

  syncSelectAllCheckbox() {
    if (!this.selectAllPages) return;
    if (this.pages.length === 0) {
      this.selectAllPages.checked = false;
      this.selectAllPages.indeterminate = false;
    } else if (this.selectedIndices.size === this.pages.length) {
      this.selectAllPages.checked = true;
      this.selectAllPages.indeterminate = false;
    } else if (this.selectedIndices.size > 0) {
      this.selectAllPages.checked = false;
      this.selectAllPages.indeterminate = true;
    } else {
      this.selectAllPages.checked = false;
      this.selectAllPages.indeterminate = false;
    }
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
    const hasCheckedOrSelected = this.selectedIndices.size > 0 || hasSelection;

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
    if (this.btnAdjust) this.btnAdjust.disabled = !hasSelection;
    if (this.btnBarcode) this.btnBarcode.disabled = !hasSelection;
    if (this.btnDuplicate) this.btnDuplicate.disabled = !hasSelection;
    this.btnRotateLeft.disabled = !hasSelection;
    this.btnRotateRight.disabled = !hasSelection;
    if (this.btnDelete) this.btnDelete.disabled = !hasSelection;
    if (this.btnExportMenu) this.btnExportMenu.disabled = !hasPages;

    if (this.btnSavePdfCurrent) this.btnSavePdfCurrent.disabled = !hasSelection;
    if (this.btnSavePdfSelected) this.btnSavePdfSelected.disabled = !hasCheckedOrSelected;
    if (this.btnSavePdfAll) this.btnSavePdfAll.disabled = !hasPages;

    if (this.btnSaveJpgCurrent) this.btnSaveJpgCurrent.disabled = !hasSelection;
    if (this.btnSaveJpgSelected) this.btnSaveJpgSelected.disabled = !hasCheckedOrSelected;
    if (this.btnSaveJpgAll) this.btnSaveJpgAll.disabled = !hasPages;

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

  async exportPdf(scope = 'all') {
    if (!this.pages.length) return;

    let pagesToExport = [];
    if (scope === 'current') {
      if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
        pagesToExport = [this.pages[this.selectedIndex]];
      }
    } else if (scope === 'selected') {
      const indices = Array.from(this.selectedIndices).sort((a, b) => a - b);
      if (indices.length > 0) {
        pagesToExport = indices.map((i) => this.pages[i]).filter(Boolean);
      } else if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
        pagesToExport = [this.pages[this.selectedIndex]];
      }
    } else {
      pagesToExport = [...this.pages];
    }

    if (!pagesToExport.length) {
      this.showAlert('No pages selected to save as PDF.', true);
      return;
    }

    const { jsPDF } = window.jspdf;
    let pdf = null;

    this.showAlert(`Generating PDF (${pagesToExport.length} page${pagesToExport.length === 1 ? '' : 's'})...`, false);

    for (let i = 0; i < pagesToExport.length; i++) {
      const page = pagesToExport[i];
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

    const suffix = scope === 'current' ? `_Page_${this.selectedIndex + 1}` : (scope === 'selected' ? '_Selected' : '_All');
    pdf.save(`Scanned_Document${suffix}_${new Date().toISOString().slice(0, 10)}.pdf`);
    this.showAlert(`PDF saved successfully (${pagesToExport.length} page${pagesToExport.length === 1 ? '' : 's'}).`, false);
  }

  async exportJpg(scope = 'current') {
    if (!this.pages.length) return;

    let pagesToExport = [];
    let pageIndices = [];
    if (scope === 'current') {
      if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
        pagesToExport = [this.pages[this.selectedIndex]];
        pageIndices = [this.selectedIndex];
      }
    } else if (scope === 'selected') {
      const indices = Array.from(this.selectedIndices).sort((a, b) => a - b);
      if (indices.length > 0) {
        pageIndices = indices;
        pagesToExport = indices.map((i) => this.pages[i]).filter(Boolean);
      } else if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
        pagesToExport = [this.pages[this.selectedIndex]];
        pageIndices = [this.selectedIndex];
      }
    } else {
      pagesToExport = [...this.pages];
      pageIndices = this.pages.map((_, i) => i);
    }

    if (!pagesToExport.length) {
      this.showAlert('No pages selected to save as JPG.', true);
      return;
    }

    this.showAlert(`Preparing JPG export (${pagesToExport.length} page${pagesToExport.length === 1 ? '' : 's'})...`, false);

    if (pagesToExport.length === 1) {
      const page = pagesToExport[0];
      const idx = pageIndices[0];
      const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);

      const a = document.createElement('a');
      a.href = rotatedDataUrl;
      a.download = `Scanned_Page_${idx + 1}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      this.showAlert(`Page ${idx + 1} saved as JPG.`, false);
    } else {
      if (window.JSZip) {
        const zip = new window.JSZip();
        for (let i = 0; i < pagesToExport.length; i++) {
          const page = pagesToExport[i];
          const idx = pageIndices[i];
          const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);
          const base64Data = rotatedDataUrl.replace(/^data:image\/jpeg;base64,/, '');
          zip.file(`Scanned_Page_${idx + 1}.jpg`, base64Data, { base64: true });
        }
        const content = await zip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        const suffix = scope === 'selected' ? 'Selected' : 'All';
        a.href = URL.createObjectURL(content);
        a.download = `Scanned_Pages_${suffix}_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        this.showAlert(`${pagesToExport.length} JPG pages saved as ZIP archive.`, false);
      } else {
        for (let i = 0; i < pagesToExport.length; i++) {
          const page = pagesToExport[i];
          const idx = pageIndices[i];
          const rotatedDataUrl = await ImageProcessor.getRotatedDataUrl(page.dataUrl, page.rotation);
          const a = document.createElement('a');
          a.href = rotatedDataUrl;
          a.download = `Scanned_Page_${idx + 1}.jpg`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          await new Promise((r) => setTimeout(r, 200));
        }
        this.showAlert(`${pagesToExport.length} JPG files exported.`, false);
      }
    }
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
      this.pdfDocToImport = await pdfjsLib.getDocument({ data: typedArray }).promise;
      const totalPages = this.pdfDocToImport.numPages;

      // Select all pages by default
      this.pdfSelectedPages = new Set();
      for (let i = 1; i <= totalPages; i++) {
        this.pdfSelectedPages.add(i);
      }

      this.pdfTotalPagesText.textContent = `Total: ${totalPages} page${totalPages === 1 ? '' : 's'}`;
      this.pdfPreviewGrid.innerHTML = '';
      this.updatePdfSelectionUI();

      // Show the preview modal
      if (window.bootstrap && this.pdfPreviewModalEl) {
        if (!this.pdfPreviewModalInstance) {
          this.pdfPreviewModalInstance = new bootstrap.Modal(this.pdfPreviewModalEl);
        }
        this.pdfPreviewModalInstance.show();
      }

      // Render the thumbnails sequentially
      await this.renderPdfPreviews();

    } catch (err) {
      console.error('PDF load error:', err);
      this.showAlert(`PDF loading failed: ${err.message}`, true);
    }
  }

  async renderPdfPreviews() {
    if (!this.pdfDocToImport) return;
    const doc = this.pdfDocToImport;
    const totalPages = doc.numPages;

    const PREVIEW_SCALE = 0.45; // lightweight rendering for speed

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      // Check if another PDF was loaded in the meantime
      if (this.pdfDocToImport !== doc) return;

      const pageCol = document.createElement('div');
      pageCol.className = 'col';
      pageCol.dataset.pageNum = pageNum;

      pageCol.innerHTML = `
        <div class="card h-100 pdf-page-card" id="pdfCard-${pageNum}" style="cursor: pointer;">
          <div class="position-absolute top-0 start-0 m-2 z-3">
            <input class="form-check-input border-secondary shadow-sm pdf-page-checkbox" type="checkbox" id="pdfCheck-${pageNum}" checked style="width: 20px; height: 20px;">
          </div>
          <div class="card-body p-2 bg-dark-subtle d-flex align-items-center justify-content-center" style="height: 160px;">
            <canvas id="pdfCanvas-${pageNum}" class="pdf-page-canvas img-fluid border rounded" style="max-height: 100%; max-width: 100%; object-fit: contain; background: #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></canvas>
          </div>
          <div class="card-footer py-1 px-2 text-center bg-white border-top-0">
            <span class="small fw-semibold text-secondary">Page ${pageNum}</span>
          </div>
        </div>
      `;

      this.pdfPreviewGrid.appendChild(pageCol);

      const card = document.getElementById(`pdfCard-${pageNum}`);
      const checkbox = document.getElementById(`pdfCheck-${pageNum}`);

      const togglePage = (e) => {
        // Prevent event loop when clicking checkbox itself
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
        }
        if (checkbox.checked) {
          this.pdfSelectedPages.add(pageNum);
          card.classList.remove('deselected');
        } else {
          this.pdfSelectedPages.delete(pageNum);
          card.classList.add('deselected');
        }
        this.updatePdfSelectionUI();
      };

      card.addEventListener('click', togglePage);

      // Render the page on canvas
      try {
        const pdfPage = await doc.getPage(pageNum);
        const viewport = pdfPage.getViewport({ scale: PREVIEW_SCALE });
        const canvas = document.getElementById(`pdfCanvas-${pageNum}`);
        if (canvas) {
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          await pdfPage.render({
            canvasContext: canvas.getContext('2d'),
            viewport
          }).promise;
        }
      } catch (err) {
        console.warn(`Failed to render thumbnail for PDF page ${pageNum}:`, err);
      }
    }
  }

  toggleAllPdfPages(select) {
    if (!this.pdfDocToImport) return;
    const totalPages = this.pdfDocToImport.numPages;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const checkbox = document.getElementById(`pdfCheck-${pageNum}`);
      const card = document.getElementById(`pdfCard-${pageNum}`);
      if (checkbox) checkbox.checked = select;
      if (card) {
        if (select) {
          card.classList.remove('deselected');
          this.pdfSelectedPages.add(pageNum);
        } else {
          card.classList.add('deselected');
          this.pdfSelectedPages.delete(pageNum);
        }
      }
    }
    this.updatePdfSelectionUI();
  }

  updatePdfSelectionUI() {
    const selectedCount = this.pdfSelectedPages.size;
    this.pdfSelectedCountText.textContent = `${selectedCount} page${selectedCount === 1 ? '' : 's'} selected`;
    
    if (this.btnConfirmPdfImport) {
      this.btnConfirmPdfImport.disabled = (selectedCount === 0);
    }
  }

  async confirmPdfImport() {
    if (!this.pdfDocToImport || this.pdfSelectedPages.size === 0) return;

    const btn = this.btnConfirmPdfImport;
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Importing...';

    const pagesToImport = Array.from(this.pdfSelectedPages).sort((a, b) => a - b);
    const totalSelected = pagesToImport.length;

    this.showAlert(`Rendering ${totalSelected} selected PDF page${totalSelected === 1 ? '' : 's'} at full quality...`, false);
    
    setTimeout(async () => {
      try {
        this.saveHistoryState();
        const SCALE = 2.0; // High quality render scale

        for (let i = 0; i < pagesToImport.length; i++) {
          const pageNum = pagesToImport[i];
          const pdfPage = await this.pdfDocToImport.getPage(pageNum);
          const viewport = pdfPage.getViewport({ scale: SCALE });

          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);

          await pdfPage.render({
            canvasContext: canvas.getContext('2d'),
            viewport
          }).promise;

          const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
          this.addPage(dataUrl, true, 150);
        }

        this.showAlert(`Successfully imported ${totalSelected} PDF page${totalSelected === 1 ? '' : 's'}.`, false);
        
        if (this.pdfPreviewModalInstance) {
          this.pdfPreviewModalInstance.hide();
        }
        
        this.pdfDocToImport = null;
        this.pdfSelectedPages.clear();

      } catch (err) {
        console.error('PDF import execution error:', err);
        this.showAlert(`Import failed: ${err.message}`, true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    }, 50);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.scannerApp = new ScannerApp();
});
