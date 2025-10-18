import { convertOsmTo3dm } from './web_converter.js';

const RHINO_SOURCES = [
  {
    scriptUrl: 'https://cdn.jsdelivr.net/npm/rhino3dm@8.7.0/rhino3dm.min.js',
    wasmBaseUrl: 'https://cdn.jsdelivr.net/npm/rhino3dm@8.7.0/',
  },
  {
    scriptUrl: 'https://files.mcneel.com/rhino3dm/js/latest/rhino3dm.min.js',
    wasmBaseUrl: 'https://files.mcneel.com/rhino3dm/js/latest/',
  },
  {
    scriptUrl: 'https://unpkg.com/rhino3dm@8.7.0/rhino3dm.min.js',
    wasmBaseUrl: 'https://unpkg.com/rhino3dm@8.7.0/',
  },
];
const RHINO_LOAD_TIMEOUT = 20000;

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');

let rhinoFactoryPromise = null;
let rhinoModulePromise = null;
let rhinoWasmBaseUrl = window.__rhinoWasmBaseUrl || null;
let currentDoc = null;
let downloadName = 'buildings.3dm';

function setStatus(message, tone = 'info') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', tone === 'error');
}

function describeSource(url) {
  try {
    const { host } = new URL(url);
    return host;
  } catch (error) {
    return url;
  }
}

function rememberWasmBase(baseUrl) {
  if (!baseUrl) return;
  rhinoWasmBaseUrl = baseUrl;
  try {
    window.__rhinoWasmBaseUrl = baseUrl;
  } catch (error) {
    // Ignore when the environment forbids writing to window.
  }
}

function currentWasmBaseUrl() {
  if (rhinoWasmBaseUrl) {
    return rhinoWasmBaseUrl;
  }
  const taggedScript = document.querySelector('script[data-rhino-base][data-rhino-loaded="true"]');
  if (taggedScript?.dataset?.rhinoBase) {
    rememberWasmBase(taggedScript.dataset.rhinoBase);
    return rhinoWasmBaseUrl;
  }
  if (typeof window.__rhinoWasmBaseUrl === 'string') {
    rememberWasmBase(window.__rhinoWasmBaseUrl);
    return rhinoWasmBaseUrl;
  }
  return RHINO_SOURCES[0].wasmBaseUrl;
}

function injectScript(source) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-rhino-source="${source.scriptUrl}"]`);
    if (existing) {
      if (existing.dataset.rhinoLoaded === 'true' && typeof window.rhino3dm === 'function') {
        rememberWasmBase(existing.dataset.rhinoBase);
        resolve(window.rhino3dm);
        return;
      }
      existing.remove();
    }

    const script = document.createElement('script');
    script.src = source.scriptUrl;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.rhinoSource = source.scriptUrl;
    script.dataset.rhinoBase = source.wasmBaseUrl;

    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      script.remove();
      reject(new Error('Timed out fetching script.'));
    }, RHINO_LOAD_TIMEOUT);

    script.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.remove();
      reject(new Error('Network error while loading script.'));
    });

    script.addEventListener('load', () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.dataset.rhinoLoaded = 'true';
      if (typeof window.rhino3dm === 'function') {
        rememberWasmBase(source.wasmBaseUrl);
        resolve(window.rhino3dm);
      } else {
        script.remove();
        reject(new Error('Loaded script did not expose window.rhino3dm.'));
      }
    });

    document.head.appendChild(script);
  });
}

async function ensureRhinoFactory(onAttempt) {
  if (typeof window.rhino3dm === 'function') {
    return window.rhino3dm;
  }

  if (rhinoFactoryPromise) {
    return rhinoFactoryPromise;
  }

  rhinoFactoryPromise = (async () => {
    const errors = [];
    for (const source of RHINO_SOURCES) {
      onAttempt?.(`Loading Rhino core from ${describeSource(source.scriptUrl)}…`);
      try {
        const factory = await injectScript(source);
        return factory;
      } catch (error) {
        errors.push(`${describeSource(source.scriptUrl)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(
      `Unable to load the Rhino3dm library. Tried:\n${errors.join('\n')}`,
    );
  })();

  try {
    return await rhinoFactoryPromise;
  } finally {
    rhinoFactoryPromise = null;
  }
}

async function ensureRhino(onAttempt) {
  if (rhinoModulePromise) {
    return rhinoModulePromise;
  }

  const factory = await ensureRhinoFactory(onAttempt);
  const baseUrl = currentWasmBaseUrl();
  rhinoModulePromise = factory({
    locateFile: (path) => {
      try {
        return new URL(path, baseUrl).toString();
      } catch (error) {
        return `${baseUrl}${path}`;
      }
    },
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
    const rhino = await ensureRhino((message) => setStatus(message));

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
