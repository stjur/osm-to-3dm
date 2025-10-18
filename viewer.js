import { convertOsmTo3dm } from './web_converter.js';

const RHINO_CDN_BASE = 'https://cdn.jsdelivr.net/npm/rhino3dm@8.7.0/';

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');

let rhinoModulePromise = null;
let currentDoc = null;
let downloadName = 'buildings.3dm';

function setStatus(message, tone = 'info') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', tone === 'error');
}

function waitForRhinoFactory(timeout = 15000) {
  if (typeof window.rhino3dm === 'function') {
    return Promise.resolve(window.rhino3dm);
  }

  return new Promise((resolve, reject) => {
    const start = performance.now();

    function check() {
      if (typeof window.rhino3dm === 'function') {
        resolve(window.rhino3dm);
        return;
      }
      if (performance.now() - start > timeout) {
        reject(new Error('Timed out waiting for the Rhino3dm library.'));
        return;
      }
      requestAnimationFrame(check);
    }

    check();
  });
}

async function ensureRhino() {
  if (rhinoModulePromise) {
    return rhinoModulePromise;
  }

  const factory = await waitForRhinoFactory();
  rhinoModulePromise = factory({
    locateFile: (path) => `${RHINO_CDN_BASE}${path}`
  }).catch((error) => {
    rhinoModulePromise = null;
    throw error;
  });

  return rhinoModulePromise;
}

function setDownloadDoc(doc, name = 'buildings.3dm') {
  currentDoc = doc;
  downloadName = name;
  if (downloadBtn) {
    downloadBtn.disabled = !doc;
  }
}

function sanitiseDownloadName(name) {
  if (!name) return 'buildings.3dm';
  const stem = name.replace(/\.[^.]+$/i, '');
  return `${stem || 'buildings'}.3dm`;
}

async function convertFile(file) {
  try {
    setStatus('Reading OSM file…');
    const text = await file.text();

    setStatus('Loading Rhino core…');
    const rhino = await ensureRhino();

    setStatus('Converting buildings…');
    const { doc, featureCount } = convertOsmTo3dm(rhino, text);

    const message = featureCount === 1
      ? 'Converted 1 building. Ready to download.'
      : `Converted ${featureCount} buildings. Ready to download.`;

    setDownloadDoc(doc, sanitiseDownloadName(file.name));
    setStatus(message);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : 'Conversion failed.';
    setDownloadDoc(null);
    setStatus(message, 'error');
  }
}

function handleFile(file) {
  if (!file) {
    return;
  }

  const name = file.name || '';
  const lower = name.toLowerCase();
  if (lower && !lower.endsWith('.osm') && !lower.endsWith('.xml')) {
    setDownloadDoc(null);
    setStatus('Unsupported file type. Please choose an .osm file.', 'error');
    return;
  }

  setDownloadDoc(null);
  convertFile(file);
}

if (fileInput) {
  fileInput.addEventListener('change', (event) => {
    handleFile(event.target.files?.[0]);
  });
}

['dragenter', 'dragover'].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
    document.body.classList.add('drag-over');
  });
});

['dragleave', 'dragend', 'drop'].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
    document.body.classList.remove('drag-over');
  });
});

if (dropZone) {
  dropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    handleFile(file);
  });
}

if (downloadBtn) {
  downloadBtn.addEventListener('click', () => {
    if (!currentDoc) return;
    try {
      const bytes = currentDoc.toByteArray();
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      setStatus('Unable to export the 3DM file.', 'error');
    }
  });
}

setDownloadDoc(null);
setStatus('Drop an OSM export to begin.');
