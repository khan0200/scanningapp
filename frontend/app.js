/**
 * NAPS2 Web Document Scanner - Bootstrap 5 Edition Controller
 */

class DocumentPage {
  constructor(id, dataUrl, width, height) {
    this.id = id || 'page_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    this.dataUrl = dataUrl;
    this.width = width || 800;
    this.height = height || 1130;
    this.rotation = 0; // 0, 90, 180, 270 degrees
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
   * Automatic Document Deskew / Straighten Algorithm (Sobel Edge + Radon Projection)
   */
  static deskewDataUrl(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 800;
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

        // Sobel Horizontal Edge Filter (detects printed text row boundaries)
        const edges = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y += 2) {
          for (let x = 1; x < w - 1; x += 2) {
            const idxAbove = ((y - 1) * w + x) * 4;
            const idxBelow = ((y + 1) * w + x) * 4;

            const lumAbove = 0.299 * pixels[idxAbove] + 0.587 * pixels[idxAbove + 1] + 0.114 * pixels[idxAbove + 2];
            const lumBelow = 0.299 * pixels[idxBelow] + 0.587 * pixels[idxBelow + 1] + 0.114 * pixels[idxBelow + 2];

            const gy = Math.abs(lumBelow - lumAbove);
            edges[y * w + x] = gy > 25 ? 1 : 0;
          }
        }

        // Radon Projection Profile Variance across -15° to +15° in 0.25° steps
        let maxVariance = -1;
        let bestAngle = 0;

        for (let angle = -15.0; angle <= 15.0; angle += 0.25) {
          const rad = (angle * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);

          const profile = new Float32Array(h);

          for (let y = 4; y < h - 4; y += 3) {
            for (let x = 4; x < w - 4; x += 3) {
              if (edges[y * w + x]) {
                const rotY = Math.round(-x * sin + y * cos);
                if (rotY >= 0 && rotY < h) {
                  profile[rotY]++;
                }
              }
            }
          }

          let mean = 0;
          for (let i = 0; i < h; i++) mean += profile[i];
          mean /= h;

          let variance = 0;
          for (let i = 0; i < h; i++) {
            const diff = profile[i] - mean;
            variance += diff * diff;
          }

          if (variance > maxVariance) {
            maxVariance = variance;
            bestAngle = angle;
          }
        }

        const rad = (-bestAngle * Math.PI) / 180;
        const absCos = Math.abs(Math.cos(rad));
        const absSin = Math.abs(Math.sin(rad));

        const rotW = Math.round(img.width * absCos + img.height * absSin);
        const rotH = Math.round(img.width * absSin + img.height * absCos);

        const rotCanvas = document.createElement('canvas');
        rotCanvas.width = rotW;
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
          angle: -bestAngle
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

    // Page editing buttons
    this.btnAddImage = document.getElementById('btnAddImage');
    this.btnDeskew = document.getElementById('btnDeskew');
    this.btnCrop = document.getElementById('btnCrop');
    this.btnRotateLeft = document.getElementById('btnRotateLeft');
    this.btnRotateRight = document.getElementById('btnRotateRight');
    this.btnDelete = document.getElementById('btnDelete');
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
        const movedItem = this.pages.splice(evt.oldIndex, 1)[0];
        this.pages.splice(evt.newIndex, 0, movedItem);
        this.selectedIndex = evt.newIndex;
        this.renderThumbnails();
        this.updatePreview();
        this.syncSession();
      }
    });
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

    const handles = this.cropBox.querySelectorAll('.crop-handle');
    handles.forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.cropState.isDragging = true;
        this.cropState.activeHandle = handle.className;
        this.cropState.startX = e.clientX;
        this.cropState.startY = e.clientY;
      });
    });

    this.cropBox.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('crop-handle')) return;
      this.cropState.isDragging = true;
      this.cropState.activeHandle = 'move';
      this.cropState.startX = e.clientX;
      this.cropState.startY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.cropState.isDragging) return;

      const dx = e.clientX - this.cropState.startX;
      const dy = e.clientY - this.cropState.startY;

      const maxW = this.cropState.canvasW;
      const maxH = this.cropState.canvasH;

      if (this.cropState.activeHandle === 'move') {
        this.cropState.boxX = Math.max(0, Math.min(maxW - this.cropState.boxW, this.cropState.boxX + dx));
        this.cropState.boxY = Math.max(0, Math.min(maxH - this.cropState.boxH, this.cropState.boxY + dy));
      } else if (this.cropState.activeHandle.includes('handle-se')) {
        this.cropState.boxW = Math.max(20, Math.min(maxW - this.cropState.boxX, this.cropState.boxW + dx));
        this.cropState.boxH = Math.max(20, Math.min(maxH - this.cropState.boxY, this.cropState.boxH + dy));
      } else if (this.cropState.activeHandle.includes('handle-sw')) {
        const newW = Math.max(20, this.cropState.boxW - dx);
        this.cropState.boxX = Math.max(0, this.cropState.boxX + (this.cropState.boxW - newW));
        this.cropState.boxW = newW;
        this.cropState.boxH = Math.max(20, Math.min(maxH - this.cropState.boxY, this.cropState.boxH + dy));
      } else if (this.cropState.activeHandle.includes('handle-ne')) {
        this.cropState.boxW = Math.max(20, Math.min(maxW - this.cropState.boxX, this.cropState.boxW + dx));
        const newH = Math.max(20, this.cropState.boxH - dy);
        this.cropState.boxY = Math.max(0, this.cropState.boxY + (this.cropState.boxH - newH));
        this.cropState.boxH = newH;
      } else if (this.cropState.activeHandle.includes('handle-nw')) {
        const newW = Math.max(20, this.cropState.boxW - dx);
        this.cropState.boxX = Math.max(0, this.cropState.boxX + (this.cropState.boxW - newW));
        this.cropState.boxW = newW;
        const newH = Math.max(20, this.cropState.boxH - dy);
        this.cropState.boxY = Math.max(0, this.cropState.boxY + (this.cropState.boxH - newH));
        this.cropState.boxH = newH;
      }

      this.cropState.startX = e.clientX;
      this.cropState.startY = e.clientY;
      this.updateCropBoxDOM();
    });

    window.addEventListener('mouseup', () => {
      this.cropState.isDragging = false;
      this.cropState.activeHandle = null;
    });

    if (this.btnResetCrop) {
      this.btnResetCrop.addEventListener('click', () => this.resetCropBox());
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

    if (this.cropDimensions) {
      this.cropDimensions.textContent = `Selection: ${realW} × ${realH} px`;
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

      this.resetCropBox();

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

        this.showAlert(`Document cropped to ${result.width} × ${result.height} px`, false);
      }
    } catch (err) {
      console.warn('Crop error:', err);
    }
  }

  initEvents() {
    // Toolbar events
    this.btnRefreshScanners.addEventListener('click', () => this.loadScanners());
    this.btnScan.addEventListener('click', () => this.triggerHardwareScan());
    this.btnStopScan.addEventListener('click', () => this.abortScan());
    if (this.btnModalStopScan) {
      this.btnModalStopScan.addEventListener('click', () => this.abortScan());
    }
    this.btnAddImage.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

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
    this.btnDelete.addEventListener('click', () => this.deleteSelected());
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
        const files = Array.from(e.dataTransfer.files);
        files.forEach((file) => {
          if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (event) => this.addPage(event.target.result);
            reader.readAsDataURL(file);
          }
        });
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && this.selectedIndex >= 0) {
        this.deleteSelected();
      } else if (e.key === 'ArrowUp' && this.selectedIndex > 0) {
        this.selectPage(this.selectedIndex - 1);
      } else if (e.key === 'ArrowDown' && this.selectedIndex < this.pages.length - 1) {
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
          const page = new DocumentPage(p.id, p.dataUrl, p.width, p.height);
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
        data.pages.forEach((dataUrl) => this.addPage(dataUrl));
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

  addPage(dataUrl) {
    const img = new Image();
    img.onload = () => {
      const page = new DocumentPage(null, dataUrl, img.width, img.height);
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
      const result = await ImageProcessor.deskewDataUrl(page.dataUrl);
      if (result && result.dataUrl) {
        page.dataUrl = result.dataUrl;
        page.width = result.width;
        page.height = result.height;
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
      const page = this.pages[this.selectedIndex];
      page.rotate(delta);

      const activeCard = this.thumbnailList.children[this.selectedIndex];
      if (activeCard) {
        const thumbImg = activeCard.querySelector('.thumbnail-img');
        const metaText = activeCard.querySelector('.thumbnail-meta-text');
        if (thumbImg) thumbImg.style.transform = `rotate(${page.rotation}deg)`;
        if (metaText) metaText.textContent = `${page.width} × ${page.height} px ${page.rotation ? `(${page.rotation}°)` : ''}`;
      }

      this.updatePreview();
      this.syncSession();
    }
  }

  deleteSelected() {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
      this.pages.splice(this.selectedIndex, 1);
      if (this.selectedIndex >= this.pages.length) {
        this.selectedIndex = this.pages.length - 1;
      }
      this.renderThumbnails();
      this.updateUI();
      this.syncSession();
    }
  }

  clearAll() {
    if (this.pages.length === 0) return;
    if (confirm('Are you sure you want to clear all document pages?')) {
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
        <div class="d-flex align-items-center gap-2">
          <div class="thumbnail-drag-handle px-1" title="Drag to reorder">
            <i class="bi bi-grip-vertical fs-5"></i>
          </div>
          <span class="badge ${idx === this.selectedIndex ? 'bg-primary' : 'bg-secondary'} rounded-circle p-2" style="width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 11px;">${idx + 1}</span>
          <div class="thumbnail-img-box">
            <img class="thumbnail-img" src="${page.dataUrl}" style="transform: rotate(${page.rotation}deg)">
          </div>
          <div class="d-flex flex-column text-truncate">
            <span class="fw-bold small text-dark">Page ${idx + 1}</span>
            <span class="text-muted thumbnail-meta-text" style="font-size: 10px;">${page.width} × ${page.height} px ${page.rotation ? `(${page.rotation}°)` : ''}</span>
          </div>
        </div>
      `;

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
    this.btnDelete.disabled = !hasSelection;
    this.btnSavePdf.disabled = !hasPages;
    this.btnSaveJpg.disabled = !hasSelection;
    this.btnClearAll.disabled = !hasPages;
  }

  handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    files.forEach((file) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          this.addPage(event.target.result);
        };
        reader.readAsDataURL(file);
      }
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

    this.btnSavePdf.disabled = false;
    this.btnSavePdf.innerHTML = `<i class="bi bi-file-earmark-pdf me-1"></i>Save PDF`;
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
}

window.addEventListener('DOMContentLoaded', () => {
  window.scannerApp = new ScannerApp();
});
