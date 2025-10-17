const canvas = document.getElementById('viewport');
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');

let renderer;
let scene;
let camera;
let controls;
let rhino;
let currentGroup;

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

async function loadArrayBuffer(buffer) {
  try {
    if (!rhino) {
      setStatus('Loading Rhino3dm…');
      rhino = await rhino3dm();
    }
    const doc = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
    if (!doc) {
      setStatus('Could not read the 3DM file.');
      return;
    }
    renderDoc(doc);
  } catch (error) {
    console.error(error);
    setStatus('Failed to load the file. Check the console for details.');
  }
}

async function handleFile(file) {
  if (!file) return;
  setStatus('Loading…');
  const buffer = await file.arrayBuffer();
  loadArrayBuffer(buffer);
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

initThree();
setStatus('Select or drop a .3dm file to begin.');
