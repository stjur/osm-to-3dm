import { convertOsmTo3dm } from './web_converter.js';

const canvas = document.getElementById('viewport');
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const downloadBtn = document.getElementById('downloadBtn');

let renderer;
let scene;
let camera;
let controls;
let rhino;
let rhinoFactoryPromise;
let currentGroup;
let currentDoc;
let downloadName = 'buildings.3dm';

async function waitForRhinoFactory() {
  const existing = window.rhino3dm || globalThis.rhino3dm;
  if (typeof existing === 'function') {
    return existing;
  }

  if (!rhinoFactoryPromise) {
    const rhinoScript = Array.from(document.scripts).find((script) =>
      /rhino3dm/i.test(script.src || '')
    );

    if (!rhinoScript) {
      throw new Error('Rhino3dm script tag is missing from the page.');
    }

    rhinoFactoryPromise = new Promise((resolve, reject) => {
      const handleLoad = () => {
        const factory = window.rhino3dm || globalThis.rhino3dm;
        if (typeof factory === 'function') {
          resolve(factory);
        } else {
          reject(new Error('Rhino3dm library finished loading but did not expose its factory.'));
        }
      };

      const handleError = () => {
        reject(new Error('Failed to download the Rhino3dm library.'));
      };

      rhinoScript.addEventListener('load', handleLoad, { once: true });
      rhinoScript.addEventListener('error', handleError, { once: true });

      if (rhinoScript.readyState === 'complete' || rhinoScript.readyState === 'loaded') {
        handleLoad();
      }
    });
  }

  return rhinoFactoryPromise;
}

async function ensureRhino() {
  if (rhino) return rhino;
  setStatus('Loading Rhino3dm…');
  const factory = await waitForRhinoFactory();
  rhino = await factory();
  return rhino;
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a111a');

  camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
  camera.position.set(60, 50, 60);

  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 0.65);
  sun.position.set(40, 100, 40);
  scene.add(sun);

  controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.target.set(0, 0, 0);

  window.addEventListener('resize', handleResize);
  animate();
}

function handleResize() {
  const { clientWidth, clientHeight } = canvas;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  controls?.update();
  renderer?.render(scene, camera);
}

function clearScene() {
  if (!currentGroup) return;
  scene.remove(currentGroup);
  currentGroup.traverse((child) => {
    if (child.isMesh) {
      child.geometry.dispose();
      child.material.dispose();
    }
  });
  currentGroup = null;
}

function setStatus(text) {
  dropZone.querySelector('p').textContent = text;
}

function setDownloadDoc(doc, filename) {
  currentDoc = doc || null;
  downloadName = filename || 'buildings.3dm';
  if (downloadBtn) {
    downloadBtn.disabled = !currentDoc;
  }
}

function createMaterial(index) {
  const palette = [
    '#4C7DFE',
    '#58B368',
    '#FF9F43',
    '#C86DD7',
    '#FF5F7E'
  ];
  return new THREE.MeshStandardMaterial({
    color: palette[index % palette.length],
    roughness: 0.55,
    metalness: 0.1,
    transparent: true,
    opacity: 0.92
  });
}

function meshFaceToTriangles(mesh, faceIndex, positions) {
  const face = mesh.faces().get(faceIndex);
  const vertices = mesh.vertices();
  const A = vertices.get(face.a);
  const B = vertices.get(face.b);
  const C = vertices.get(face.c);
  const D = face.d >= 0 ? vertices.get(face.d) : null;

  positions.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
  if (D) {
    positions.push(A.x, A.y, A.z, C.x, C.y, C.z, D.x, D.y, D.z);
  }
}

function meshToThree(mesh, material) {
  mesh.triangulate();
  const positions = [];
  const faceCount = mesh.faces().count;
  for (let i = 0; i < faceCount; i++) {
    meshFaceToTriangles(mesh, i, positions);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function applyAttributes(mesh, attributes) {
  const xf = attributes?.transform;
  if (!xf) return mesh;
  const matrix = new THREE.Matrix4().set(
    xf[0], xf[1], xf[2], xf[3],
    xf[4], xf[5], xf[6], xf[7],
    xf[8], xf[9], xf[10], xf[11],
    xf[12], xf[13], xf[14], xf[15]
  );
  mesh.applyMatrix4(matrix);
  return mesh;
}

function frameView(group) {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z);
  const distance = maxSize * 1.75;

  controls.target.copy(center);
  camera.position.set(center.x + distance, center.y + distance, center.z + distance);
  camera.near = distance / 100;
  camera.far = distance * 10;
  camera.updateProjectionMatrix();
}

function brepToMesh(brep) {
  const brepMeshes = rhino.Mesh.createFromBrep(brep, new rhino.MeshingParameters());
  if (!brepMeshes) return null;
  const joined = rhino.Mesh.join(brepMeshes);
  return joined;
}

function extrusionToMesh(extrusion) {
  const meshes = extrusion.getMesh(rhino.MeshType.Any);
  if (meshes) return meshes;
  const brep = extrusion.toBrep();
  return brep ? brepToMesh(brep) : null;
}

function convertGeometry(geometry) {
  if (geometry instanceof rhino.Mesh) {
    return geometry;
  }
  if (geometry instanceof rhino.Brep) {
    return brepToMesh(geometry);
  }
  if (geometry instanceof rhino.Extrusion) {
    return extrusionToMesh(geometry);
  }
  return null;
}

function renderDoc(doc) {
  clearScene();
  const group = new THREE.Group();
  const objects = doc.objects();
  for (let i = 0; i < objects.count; i++) {
    const obj = objects.get(i);
    const geometry = obj.geometry();
    const attributes = obj.attributes();
    const mesh = convertGeometry(geometry);
    if (!mesh) continue;
    const threeMesh = meshToThree(mesh, createMaterial(i));
    applyAttributes(threeMesh, attributes); 
    group.add(threeMesh);
  }
  if (!group.children.length) {
    setStatus('No renderable geometry found in the file.');
    return;
  }
  scene.add(group);
  currentGroup = group;
  frameView(group);
  setStatus('Drag to orbit, scroll to zoom.');
}

async function loadArrayBuffer(buffer, filename) {
  try {
    const rhinoModule = await ensureRhino();
    const doc = rhinoModule.File3dm.fromByteArray(new Uint8Array(buffer));
    if (!doc) {
      setStatus('Could not read the 3DM file.');
      setDownloadDoc(null);
      return;
    }
    renderDoc(doc);
    setDownloadDoc(doc, filename || 'model.3dm');
    if (filename) {
      setStatus(`Loaded ${filename}. Drag to orbit, scroll to zoom.`);
    }
  } catch (error) {
    console.error(error);
    setStatus('Failed to load the file. Check the console for details.');
    setDownloadDoc(null);
  }
}

async function loadOsmText(text, filename) {
  try {
    const rhinoModule = await ensureRhino();
    setStatus('Converting buildings…');
    const { doc, featureCount } = convertOsmTo3dm(rhinoModule, text);
    renderDoc(doc);
    const suggested = filename
      ? filename.replace(/\.(osm|xml)$/i, '') + '.3dm'
      : 'buildings.3dm';
    setDownloadDoc(doc, suggested);
    setStatus(
      `Converted ${featureCount} building${featureCount === 1 ? '' : 's'}. Drag to orbit, scroll to zoom.`
    );
  } catch (error) {
    console.error(error);
    setDownloadDoc(null);
    setStatus(error.message || 'Failed to convert the OSM data.');
  }
}

async function handleFile(file) {
  if (!file) return;
  const name = file.name || 'file';
  const lower = name.toLowerCase();

  if (lower.endsWith('.osm') || lower.endsWith('.xml')) {
    setStatus('Parsing OSM…');
    const text = await file.text();
    await loadOsmText(text, name);
    return;
  }

  if (lower.endsWith('.3dm')) {
    setStatus('Reading 3DM…');
    const buffer = await file.arrayBuffer();
    await loadArrayBuffer(buffer, name);
    return;
  }

  setStatus('Unsupported file type. Please choose a .osm or .3dm file.');
  setDownloadDoc(null);
}

fileInput.addEventListener('change', (event) => {
  handleFile(event.target.files[0]);
});

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

dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files[0];
  handleFile(file);
});

if (downloadBtn) {
  downloadBtn.addEventListener('click', async () => {
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
      setStatus('Unable to export the 3DM file.');
    }
  });
}

initThree();
setDownloadDoc(null);
setStatus('Drop an OSM export or a 3DM file to begin.');
