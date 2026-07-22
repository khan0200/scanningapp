/**
 * NAPS2 Web Document Scanner - Frontend Controller
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
}

class ScannerApp {
  constructor() {
    this.pages = [];
    this.selectedIndex = -1;
    this.zoomScale = 1.0;
    this.sortable = null;
    this.scanners = [];
    // Detect backend URL (use localhost:3000 when hosted on VSCode Live Server / 127.0.0.1 / file://)
    const isNativeHost = window.location.port === '3000';
    this.apiUrl = isNativeHost ? '' : 'http://localhost:3000';

    this.initDOM();
    this.initEvents();
    this.initSortable();
    this.loadScanners();
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
    this.scanningBar = document.getElementById('scanningBar');
    this.fileInput = document.getElementById('fileInput');

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
      }
    });
  }

  initEvents() {
    // Toolbar events
    this.btnRefreshScanners.addEventListener('click', () => this.loadScanners());
    this.btnScan.addEventListener('click', () => this.triggerHardwareScan());
    this.btnStopScan.addEventListener('click', () => this.abortScan());
    this.btnAddImage.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

    this.scannerSelect.addEventListener('change', () => {
      localStorage.setItem('naps2_selected_scanner', this.scannerSelect.value);
    });

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

      // Restore previously saved scanner selection
      const saved = localStorage.getItem('naps2_selected_scanner');
      if (saved && Array.from(this.scannerSelect.options).some(o => o.value === saved)) {
        this.scannerSelect.value = saved;
      }
    } catch (err) {
      console.warn('Scanner enumeration fallback:', err);
      this.scannerSelect.innerHTML = '<option value="wia:canon_g3410">Canon PIXMA G3410 (WIA Auto)</option>';
    }
  }

  async triggerHardwareScan() {
    this.hideAlert();
    this.scanningBar.style.display = 'block';
    this.btnScan.classList.add('hidden-input');
    this.btnStopScan.classList.remove('hidden-input');

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
    this.scanningBar.style.display = 'none';
    this.btnScan.classList.remove('hidden-input');
    this.btnStopScan.classList.add('hidden-input');
    this.btnScan.disabled = false;
  }

  showAlert(msg, isError = true) {
    this.alertText.textContent = msg;
    if (isError) {
      this.alertBanner.classList.add('error');
    } else {
      this.alertBanner.classList.remove('error');
    }
    this.alertBanner.classList.remove('hidden');
  }

  hideAlert() {
    this.alertBanner.classList.add('hidden');
  }

  addPage(dataUrl) {
    const img = new Image();
    img.onload = () => {
      const page = new DocumentPage(null, dataUrl, img.width, img.height);
      this.pages.push(page);
      this.selectedIndex = this.pages.length - 1;
      this.renderThumbnails();
      this.updateUI();
    };
    img.src = dataUrl;
  }

  selectPage(index) {
    if (index >= 0 && index < this.pages.length) {
      this.selectedIndex = index;
      this.renderThumbnails();
      this.updatePreview();
      this.updateUI();
    }
  }

  rotateSelected(delta) {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.pages.length) {
      const page = this.pages[this.selectedIndex];
      page.rotate(delta);
      this.renderThumbnails();
      this.updatePreview();
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
    }
  }

  clearAll() {
    if (this.pages.length === 0) return;
    if (confirm('Are you sure you want to clear all document pages?')) {
      this.pages = [];
      this.selectedIndex = -1;
      this.renderThumbnails();
      this.updateUI();
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
      item.className = `thumbnail-item ${idx === this.selectedIndex ? 'active' : ''}`;
      item.addEventListener('click', () => this.selectPage(idx));

      item.innerHTML = `
        <div class="thumbnail-drag-handle" title="Drag to reorder">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
          </svg>
        </div>
        <div class="thumbnail-badge">${idx + 1}</div>
        <div class="thumbnail-preview-container">
          <img class="thumbnail-img" src="${page.dataUrl}" style="transform: rotate(${page.rotation}deg)">
        </div>
        <div class="thumbnail-details">
          <div class="thumbnail-title">Page ${idx + 1}</div>
          <div class="thumbnail-meta">${page.width} × ${page.height} px ${page.rotation ? `(${page.rotation}°)` : ''}</div>
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
    this.btnSavePdf.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
      </svg> Save PDF
    `;
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
