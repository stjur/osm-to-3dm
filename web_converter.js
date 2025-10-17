export const DEFAULT_LEVEL_HEIGHT = 3.0;
export const DEFAULT_BUILDING_HEIGHT = 10.0;

function parseTags(element) {
  const tags = new Map();
  element.querySelectorAll(':scope > tag').forEach((tag) => {
    const key = tag.getAttribute('k');
    if (!key) return;
    const value = tag.getAttribute('v') ?? '';
    tags.set(key, value);
  });
  return tags;
}

function parseOsm(xmlText) {
  const parser = new DOMParser();
  const document = parser.parseFromString(xmlText, 'application/xml');
  const errorNode = document.querySelector('parsererror');
  if (errorNode) {
    throw new Error(errorNode.textContent || 'Failed to parse OSM XML.');
  }

  const root = document.documentElement;
  if (!root || root.nodeName !== 'osm') {
    throw new Error('Not a valid OSM XML document.');
  }

  const nodes = new Map();
  const ways = new Map();
  const relations = new Map();

  root.childNodes.forEach((node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.nodeName === 'node') {
      const id = Number(node.getAttribute('id'));
      const lat = Number(node.getAttribute('lat'));
      const lon = Number(node.getAttribute('lon'));
      if (Number.isFinite(id) && Number.isFinite(lat) && Number.isFinite(lon)) {
        nodes.set(id, { lat, lon });
      }
    } else if (node.nodeName === 'way') {
      const id = Number(node.getAttribute('id'));
      if (!Number.isFinite(id)) return;
      const nodeRefs = [];
      node.querySelectorAll(':scope > nd').forEach((nd) => {
        const ref = Number(nd.getAttribute('ref'));
        if (Number.isFinite(ref)) {
          nodeRefs.push(ref);
        }
      });
      const tags = parseTags(node);
      ways.set(id, { nodeRefs, tags });
    } else if (node.nodeName === 'relation') {
      const id = Number(node.getAttribute('id'));
      if (!Number.isFinite(id)) return;
      const members = [];
      node.querySelectorAll(':scope > member').forEach((member) => {
        const type = member.getAttribute('type');
        const ref = Number(member.getAttribute('ref'));
        const role = member.getAttribute('role') || '';
        if (!type || !Number.isFinite(ref)) return;
        members.push({ type, ref, role });
      });
      const tags = parseTags(node);
      relations.set(id, { members, tags });
    }
  });

  return { nodes, ways, relations };
}

function isBuilding(tags) {
  return tags.has('building') || tags.has('building:part');
}

function parseFloatTag(value) {
  if (typeof value !== 'string') return null;
  let cleaned = value.trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned.includes(',') && !cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '.');
  }
  for (const separator of [';', '|']) {
    if (cleaned.includes(separator)) {
      cleaned = cleaned.split(separator)[0];
      break;
    }
  }
  if (cleaned.endsWith('m')) {
    cleaned = cleaned.slice(0, -1);
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildingHeight(tags, { defaultHeight, levelHeight }) {
  let height = null;
  let minHeight = null;

  for (const key of ['min_height', 'building:min_height']) {
    if (tags.has(key)) {
      const parsed = parseFloatTag(tags.get(key));
      if (parsed !== null) {
        minHeight = parsed;
        break;
      }
    }
  }

  for (const key of ['height', 'building:height']) {
    if (tags.has(key)) {
      const parsed = parseFloatTag(tags.get(key));
      if (parsed !== null) {
        height = parsed;
        break;
      }
    }
  }

  if (height === null && tags.has('building:levels')) {
    const levels = parseFloatTag(tags.get('building:levels'));
    if (levels !== null) {
      height = levels * levelHeight;
    }
  }

  if (minHeight === null) {
    minHeight = 0;
  }

  if (height === null) {
    height = defaultHeight;
  }

  if (height <= minHeight) {
    height = minHeight + Math.max(defaultHeight * 0.25, 1);
  }

  return { height, minHeight };
}

function extractWayFeature(wayId, nodes, nodeRefs, tags) {
  if (nodeRefs.length < 4) return null;
  if (nodeRefs[0] !== nodeRefs[nodeRefs.length - 1]) return null;
  const outer = [];
  for (const ref of nodeRefs) {
    const node = nodes.get(ref);
    if (!node) {
      return null;
    }
    outer.push([node.lat, node.lon]);
  }
  return {
    osmId: `way/${wayId}`,
    outer,
    holes: [],
    tags,
  };
}

function assembleRings(sequences) {
  const unused = sequences
    .filter((seq) => seq.length >= 2)
    .map((seq) => seq.slice());
  const rings = [];

  while (unused.length) {
    const current = unused.pop();
    if (!current || !current.length) continue;
    const ring = current.slice();
    while (ring[0] !== ring[ring.length - 1] && unused.length) {
      const tail = ring[ring.length - 1];
      let joined = false;
      for (let i = 0; i < unused.length; i++) {
        const candidate = unused[i];
        if (!candidate.length) continue;
        const head = candidate[0];
        const candTail = candidate[candidate.length - 1];
        if (head === tail) {
          ring.push(...candidate.slice(1));
          unused.splice(i, 1);
          joined = true;
          break;
        }
        if (candTail === tail) {
          ring.push(...candidate.slice(0, -1).reverse());
          unused.splice(i, 1);
          joined = true;
          break;
        }
        if (candTail === ring[0]) {
          ring.unshift(...candidate.slice(0, -1));
          unused.splice(i, 1);
          joined = true;
          break;
        }
        if (head === ring[0]) {
          ring.unshift(...candidate.slice(1).reverse());
          unused.splice(i, 1);
          joined = true;
          break;
        }
      }
      if (!joined) {
        break;
      }
    }
    if (ring[0] !== ring[ring.length - 1]) {
      ring.push(ring[0]);
    }
    rings.push(ring);
  }

  return rings;
}

function extractRelationFeatures(relationId, nodes, ways, members, tags) {
  const wayRoles = { outer: [], inner: [] };
  const outerTags = new Map(tags);

  members.forEach(({ type, ref, role }) => {
    if (type !== 'way') return;
    const way = ways.get(ref);
    if (!way) return;
    const normalized = (role || 'outer').toLowerCase();
    let target;
    if (['outline', 'exterior', 'shell', 'outer'].includes(normalized)) {
      target = 'outer';
    } else if (['interior', 'hole', 'inner'].includes(normalized)) {
      target = 'inner';
    } else {
      return;
    }
    wayRoles[target].push(way.nodeRefs);
    if (!isBuilding(outerTags) && isBuilding(way.tags)) {
      way.tags.forEach((value, key) => {
        if (key.startsWith('building') || key === 'height' || key === 'min_height') {
          outerTags.set(key, value);
        }
      });
    }
  });

  if (!wayRoles.outer.length) {
    return [];
  }

  const outerRings = assembleRings(wayRoles.outer)
    .map((ringIds) => {
      const ring = [];
      for (const id of ringIds) {
        const node = nodes.get(id);
        if (!node) return null;
        ring.push([node.lat, node.lon]);
      }
      return ring;
    })
    .filter((ring) => ring && ring.length);

  if (!outerRings.length) {
    return [];
  }

  const innerRings = assembleRings(wayRoles.inner)
    .map((ringIds) => {
      const ring = [];
      for (const id of ringIds) {
        const node = nodes.get(id);
        if (!node) return null;
        ring.push([node.lat, node.lon]);
      }
      return ring;
    })
    .filter((ring) => ring && ring.length);

  const ringCentroid = (ring) => {
    let latSum = 0;
    let lonSum = 0;
    let count = 0;
    ring.forEach(([lat, lon]) => {
      latSum += lat;
      lonSum += lon;
      count += 1;
    });
    if (!count) return { lat: 0, lon: 0 };
    return { lat: latSum / count, lon: lonSum / count };
  };

  const ringContainsPoint = (ring, point) => {
    const px = point.lon;
    const py = point.lat;
    let inside = false;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lat1, lon1] = ring[i];
      const [lat2, lon2] = ring[i + 1];
      const x1 = lon1;
      const y1 = lat1;
      const x2 = lon2;
      const y2 = lat2;
      const intersects = (y1 > py) !== (y2 > py) && px < ((x2 - x1) * (py - y1)) / ((y2 - y1) || 1e-12) + x1;
      if (intersects) inside = !inside;
    }
    return inside;
  };

  const unassigned = innerRings.slice();
  const features = [];

  outerRings.forEach((outer) => {
    const assigned = [];
    const remaining = [];
    unassigned.forEach((inner) => {
      const centroid = ringCentroid(inner);
      if (ringContainsPoint(outer, centroid)) {
        assigned.push(inner);
      } else {
        remaining.push(inner);
      }
    });
    unassigned.length = 0;
    unassigned.push(...remaining);
    features.push({
      osmId: `relation/${relationId}`,
      outer,
      holes: assigned,
      tags: outerTags,
    });
  });

  return features;
}

function collectFeatures(nodes, ways, relations) {
  const features = [];
  const relationWayIds = new Set();
  const relationCandidates = [];

  relations.forEach(({ members, tags }, relationId) => {
    const type = tags.get('type');
    if (type !== 'multipolygon' && type !== 'building') {
      return;
    }
    relationCandidates.push({ relationId, members: members.slice(), tags });
    const memberHasBuilding = members.some(({ type: memberType, ref }) => {
      if (memberType !== 'way') return false;
      const way = ways.get(ref);
      return way ? isBuilding(way.tags) : false;
    });
    if (isBuilding(tags) || memberHasBuilding) {
      members.forEach(({ type: memberType, ref }) => {
        if (memberType === 'way') {
          relationWayIds.add(ref);
        }
      });
    }
  });

  ways.forEach(({ nodeRefs, tags }, wayId) => {
    if (!isBuilding(tags)) return;
    if (relationWayIds.has(wayId) && !tags.has('building:part')) {
      return;
    }
    const feature = extractWayFeature(wayId, nodes, nodeRefs, tags);
    if (feature) {
      features.push(feature);
    }
  });

  relationCandidates.forEach(({ relationId, members, tags }) => {
    const hasBuildingTags = isBuilding(tags);
    const memberHasBuilding = members.some(({ type, ref }) => {
      if (type !== 'way') return false;
      const way = ways.get(ref);
      return way ? isBuilding(way.tags) : false;
    });
    if (!hasBuildingTags && !memberHasBuilding) {
      return;
    }
    const relationFeatures = extractRelationFeatures(relationId, nodes, ways, members, tags);
    relationFeatures.forEach((feature) => features.push(feature));
  });

  return features;
}

function determineOrigin(features) {
  let latSum = 0;
  let lonSum = 0;
  let count = 0;
  features.forEach((feature) => {
    feature.outer.forEach(([lat, lon]) => {
      latSum += lat;
      lonSum += lon;
      count += 1;
    });
    feature.holes.forEach((hole) => {
      hole.forEach(([lat, lon]) => {
        latSum += lat;
        lonSum += lon;
        count += 1;
      });
    });
  });
  if (!count) {
    throw new Error('No geographic coordinates found in OSM input.');
  }
  return { lat: latSum / count, lon: lonSum / count };
}

function projectPoint(lat, lon, origin) {
  const radius = 6378137.0;
  const latRad = (lat * Math.PI) / 180;
  const originLatRad = (origin.lat * Math.PI) / 180;
  const x = radius * ((lon - origin.lon) * Math.PI) / 180 * Math.cos(originLatRad);
  const y = radius * (latRad - originLatRad);
  return [x, y];
}

function projectFeature(feature, origin) {
  const outer = feature.outer.map(([lat, lon]) => projectPoint(lat, lon, origin));
  const holes = feature.holes.map((ring) => ring.map(([lat, lon]) => projectPoint(lat, lon, origin)));
  return {
    osmId: feature.osmId,
    outer,
    holes,
    tags: feature.tags,
  };
}

function ringSignedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

function prepareRingPoints(rhino, ring, counterClockwise) {
  if (ring.length < 4) return null;
  const closed = ring.slice();
  if (closed[0][0] !== closed[closed.length - 1][0] || closed[0][1] !== closed[closed.length - 1][1]) {
    closed.push(closed[0]);
  }
  const area = ringSignedArea(closed);
  if (counterClockwise && area < 0) {
    closed.reverse();
  } else if (!counterClockwise && area > 0) {
    closed.reverse();
  }
  const points = closed.map(([x, y]) => new rhino.Point3d(x, y, 0));
  const first = points[0];
  const last = points[points.length - 1];
  const distance = typeof first.distanceTo === 'function'
    ? first.distanceTo(last)
    : typeof first.DistanceTo === 'function'
      ? first.DistanceTo(last)
      : 0;
  if (distance > 1e-6) {
    points.push(points[0]);
  }
  return points.length >= 4 ? points : null;
}

function polylineCurveFromRing(rhino, ring, counterClockwise) {
  const points = prepareRingPoints(rhino, ring, counterClockwise);
  if (!points) return null;
  const curve = new rhino.PolylineCurve(points);
  const isClosed = typeof curve.isClosed === 'function'
    ? curve.isClosed()
    : curve.isClosed ?? (typeof curve.IsClosed === 'function' ? curve.IsClosed() : curve.IsClosed);
  if (!isClosed) {
    return null;
  }
  const toNurbs = typeof curve.toNurbsCurve === 'function'
    ? curve.toNurbsCurve.bind(curve)
    : typeof curve.ToNurbsCurve === 'function'
      ? curve.ToNurbsCurve.bind(curve)
      : null;
  return toNurbs ? toNurbs() : null;
}

function createGeometryFromFeature(rhino, feature, height, minHeight) {
  const extrusionHeight = height - minHeight;
  if (extrusionHeight <= 0) return null;

  const outerCurve = polylineCurveFromRing(rhino, feature.outer, true);
  if (!outerCurve) return null;

  const holeCurves = [];
  feature.holes.forEach((hole) => {
    const curve = polylineCurveFromRing(rhino, hole, false);
    if (curve) holeCurves.push(curve);
  });

  if (holeCurves.length) {
    const createPlanar = rhino.Brep.createPlanarBreps || rhino.Brep.CreatePlanarBreps;
    const planar = createPlanar ? createPlanar([outerCurve, ...holeCurves]) : null;
    if (!planar || !planar.length) return null;
    const base = planar[0];
    const face = base.faces().get(0);
    const createExtrusion = face.createExtrusion || face.CreateExtrusion;
    const solid = createExtrusion
      ? createExtrusion.call(face, new rhino.Vector3d(0, 0, extrusionHeight), true)
      : null;
    if (!solid) return null;
    const translate = solid.translate || solid.Translate;
    translate?.call(solid, new rhino.Vector3d(0, 0, minHeight));
    return solid;
  }

  const createExtrusion = rhino.Extrusion.create || rhino.Extrusion.Create;
  const extrusion = createExtrusion
    ? createExtrusion.call(rhino.Extrusion, outerCurve, extrusionHeight, true)
    : null;
  if (!extrusion) return null;
  const translate = extrusion.translate || extrusion.Translate;
  translate?.call(extrusion, new rhino.Vector3d(0, 0, minHeight));
  return extrusion;
}

function addFeatureToModel(rhino, doc, feature, height, minHeight) {
  const geometry = createGeometryFromFeature(rhino, feature, height, minHeight);
  if (!geometry) return;
  const attributes = new rhino.ObjectAttributes();
  const name = feature.tags.get('name') || feature.tags.get('building:name');
  if ('name' in attributes) {
    attributes.name = name || feature.osmId;
  } else {
    attributes.Name = name || feature.osmId;
  }
  feature.tags.forEach((value, key) => {
    if (key.startsWith('building') || key === 'height' || key === 'min_height' || key === 'name') {
      const setUserString = attributes.setUserString || attributes.SetUserString;
      setUserString?.call(attributes, key, value);
    }
  });
  const setUserString = attributes.setUserString || attributes.SetUserString;
  setUserString?.call(attributes, 'osm:id', feature.osmId);
  const objects = doc.objects?.() || doc.Objects?.();
  if (!objects) return;
  if (geometry instanceof rhino.Extrusion) {
    const addExtrusion = objects.addExtrusion || objects.AddExtrusion;
    addExtrusion?.call(objects, geometry, attributes);
  } else {
    const addBrep = objects.addBrep || objects.AddBrep;
    addBrep?.call(objects, geometry, attributes);
  }
}

function buildModel(rhino, features, origin, options) {
  const doc = new rhino.File3dm();
  const settings = doc.settings?.() || doc.Settings?.();
  const setUnits = settings?.setModelUnitSystem || settings?.SetModelUnitSystem;
  setUnits?.call(settings, rhino.UnitSystem.Meters);
  const strings = doc.strings?.() || doc.Strings?.();
  const setString = strings?.set || strings?.Set;
  setString?.call(strings, 'origin_lat', String(origin.lat));
  setString?.call(strings, 'origin_lon', String(origin.lon));

  const projected = features.map((feature) => projectFeature(feature, origin));

  projected.forEach((projectedFeature, index) => {
    const original = features[index];
    const { height, minHeight } = buildingHeight(original.tags, options);
    addFeatureToModel(rhino, doc, projectedFeature, height, minHeight);
  });

  return doc;
}

export function convertOsmTo3dm(rhino, xmlText, options = {}) {
  const defaults = {
    defaultHeight: DEFAULT_BUILDING_HEIGHT,
    levelHeight: DEFAULT_LEVEL_HEIGHT,
  };
  const settings = { ...defaults, ...options };

  const { nodes, ways, relations } = parseOsm(xmlText);
  const features = collectFeatures(nodes, ways, relations);
  if (!features.length) {
    throw new Error('No buildings found in the supplied OSM data.');
  }
  const origin = determineOrigin(features);
  const doc = buildModel(rhino, features, origin, settings);
  return { doc, featureCount: features.length, origin };
}
