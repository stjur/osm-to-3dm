#!/usr/bin/env python3
"""Convert OSM buildings into a Rhino 3DM volume model.

The script extracts ``building`` and ``building:part`` geometries (ways and
multipolygons) from an OpenStreetMap XML export and converts them into simple
extrusions whose footprints are located in a locally projected coordinate
system.  The resulting 3DM file contains one extrusion object per footprint and
stores metadata about the geographic origin that was used for the projection.

Example::

    python osm_to_3dm.py map.osm buildings.3dm

The script requires the :mod:`rhino3dm` package which can be installed with
``pip install rhino3dm``.
"""

from __future__ import annotations

import argparse
import math
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

import rhino3dm

# Average storey height used when only ``building:levels`` is available.
DEFAULT_LEVEL_HEIGHT = 3.0
# Height used whenever a geometry is missing explicit height information.
DEFAULT_BUILDING_HEIGHT = 10.0


@dataclass
class Feature:
    """A single extrudable OSM footprint."""

    osm_id: str
    outer: List[Tuple[float, float]]
    holes: List[List[Tuple[float, float]]]
    tags: Dict[str, str]

    @property
    def name(self) -> Optional[str]:
        return self.tags.get("name")


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Path to an OSM XML file")
    parser.add_argument("output", type=Path, help="Destination 3DM file")
    parser.add_argument(
        "--default-height",
        type=float,
        default=DEFAULT_BUILDING_HEIGHT,
        help="Fallback height (in metres) when OSM data does not specify one",
    )
    parser.add_argument(
        "--level-height",
        type=float,
        default=DEFAULT_LEVEL_HEIGHT,
        help="Storey height to use when only building:levels is provided",
    )
    return parser.parse_args(argv)


def parse_osm(path: Path) -> Tuple[
    Dict[int, Tuple[float, float]],
    Dict[int, Tuple[List[int], Dict[str, str]]],
    Dict[int, Tuple[List[Tuple[str, int, str]], Dict[str, str]]],
]:
    """Parse the OSM XML document and return nodes, ways and relations."""

    tree = ET.parse(path)
    root = tree.getroot()
    nodes: Dict[int, Tuple[float, float]] = {}
    ways: Dict[int, Tuple[List[int], Dict[str, str]]] = {}
    relations: Dict[int, Tuple[List[Tuple[str, int, str]], Dict[str, str]]] = {}

    for element in root:
        if element.tag == "node":
            node_id = int(element.attrib["id"])
            lat = float(element.attrib["lat"])
            lon = float(element.attrib["lon"])
            nodes[node_id] = (lat, lon)
        elif element.tag == "way":
            way_id = int(element.attrib["id"])
            node_refs = [int(nd.attrib["ref"]) for nd in element.findall("nd")]
            tags = {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}
            ways[way_id] = (node_refs, tags)
        elif element.tag == "relation":
            relation_id = int(element.attrib["id"])
            members = [
                (member.attrib["type"], int(member.attrib["ref"]), member.attrib.get("role", ""))
                for member in element.findall("member")
            ]
            tags = {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}
            relations[relation_id] = (members, tags)

    return nodes, ways, relations


def is_building(tags: Dict[str, str]) -> bool:
    return "building" in tags or "building:part" in tags


def parse_float(value: str) -> Optional[float]:
    """Parse a height or level value from OSM."""

    cleaned = value.strip().lower()
    if not cleaned:
        return None
    if "," in cleaned and "." not in cleaned:
        cleaned = cleaned.replace(",", ".")
    for separator in (";", "|"):
        if separator in cleaned:
            cleaned = cleaned.split(separator)[0]
            break
    if cleaned.endswith("m"):
        cleaned = cleaned[:-1]
    try:
        return float(cleaned)
    except ValueError:
        return None


def building_height(tags: Dict[str, str], *, default_height: float, level_height: float) -> Tuple[float, float]:
    """Return total height and minimum height in metres."""

    height: Optional[float] = None
    min_height: Optional[float] = None

    for key in ("min_height", "building:min_height"):
        if key in tags:
            value = parse_float(tags[key])
            if value is not None:
                min_height = value
                break

    for key in ("height", "building:height"):
        if key in tags:
            value = parse_float(tags[key])
            if value is not None:
                height = value
                break

    if height is None and "building:levels" in tags:
        levels = parse_float(tags["building:levels"])
        if levels is not None:
            height = levels * level_height

    if min_height is None:
        min_height = 0.0

    if height is None:
        height = default_height

    if height <= min_height:
        height = min_height + max(default_height * 0.25, 1.0)

    return height, min_height


def extract_way_feature(
    way_id: int,
    nodes: Dict[int, Tuple[float, float]],
    node_refs: Sequence[int],
    tags: Dict[str, str],
) -> Optional[Feature]:
    if len(node_refs) < 4:
        return None
    if node_refs[0] != node_refs[-1]:
        return None
    try:
        ring = [nodes[nid] for nid in node_refs]
    except KeyError:
        return None
    return Feature(osm_id=f"way/{way_id}", outer=ring, holes=[], tags=tags)


def assemble_rings(node_sequences: Iterable[Sequence[int]]) -> List[List[int]]:
    """Combine way fragments into closed rings."""

    unused = [list(seq) for seq in node_sequences if len(seq) >= 2]
    rings: List[List[int]] = []

    while unused:
        current = unused.pop()
        if not current:
            continue
        ring = list(current)
        while ring[0] != ring[-1] and unused:
            tail = ring[-1]
            joined = False
            for index, candidate in enumerate(unused):
                if not candidate:
                    continue
                head = candidate[0]
                cand_tail = candidate[-1]
                if head == tail:
                    ring.extend(candidate[1:])
                    unused.pop(index)
                    joined = True
                    break
                if cand_tail == tail:
                    ring.extend(reversed(candidate[:-1]))
                    unused.pop(index)
                    joined = True
                    break
                if cand_tail == ring[0]:
                    ring = candidate[:-1] + ring
                    unused.pop(index)
                    joined = True
                    break
                if head == ring[0]:
                    ring = list(reversed(candidate[1:])) + ring
                    unused.pop(index)
                    joined = True
                    break
            if not joined:
                break
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        rings.append(ring)
    return rings


def extract_relation_features(
    relation_id: int,
    nodes: Dict[int, Tuple[float, float]],
    ways: Dict[int, Tuple[List[int], Dict[str, str]]],
    members: Sequence[Tuple[str, int, str]],
    tags: Dict[str, str],
) -> List[Feature]:
    """Extract outer rings from a multipolygon relation."""

    way_roles: Dict[str, List[List[int]]] = {"outer": [], "inner": []}
    outer_tags = tags.copy()

    for member_type, ref, role in members:
        if member_type != "way":
            continue
        if ref not in ways:
            continue
        node_refs, way_tags = ways[ref]
        normalized_role = role or "outer"
        if normalized_role in way_roles:
            way_roles[normalized_role].append(node_refs)
        if not is_building(outer_tags) and is_building(way_tags):
            outer_tags.update({k: v for k, v in way_tags.items() if k.startswith("building") or k == "height"})

    if not way_roles["outer"]:
        return []

    outer_rings: List[List[Tuple[float, float]]] = []
    for ring_node_ids in assemble_rings(way_roles["outer"]):
        try:
            ring = [nodes[nid] for nid in ring_node_ids]
        except KeyError:
            continue
        outer_rings.append(ring)

    if not outer_rings:
        return []

    inner_rings: List[List[Tuple[float, float]]] = []
    for ring_node_ids in assemble_rings(way_roles["inner"]):
        try:
            ring = [nodes[nid] for nid in ring_node_ids]
        except KeyError:
            continue
        inner_rings.append(ring)

    def ring_centroid(ring: Sequence[Tuple[float, float]]) -> Tuple[float, float]:
        if not ring:
            return 0.0, 0.0
        lat_sum = 0.0
        lon_sum = 0.0
        count = 0
        for lat, lon in ring:
            lat_sum += lat
            lon_sum += lon
            count += 1
        return lat_sum / count, lon_sum / count

    def ring_contains_point(ring: Sequence[Tuple[float, float]], point: Tuple[float, float]) -> bool:
        # Use the ray casting algorithm on longitude/latitude pairs.
        px, py = point[1], point[0]
        inside = False
        for (lat1, lon1), (lat2, lon2) in zip(ring, ring[1:]):
            x1, y1 = lon1, lat1
            x2, y2 = lon2, lat2
            intersects = ((y1 > py) != (y2 > py)) and (
                px < (x2 - x1) * (py - y1) / ((y2 - y1) or 1e-12) + x1
            )
            if intersects:
                inside = not inside
        return inside

    unassigned_inners = list(inner_rings)
    features: List[Feature] = []

    for outer_ring in outer_rings:
        assigned: List[List[Tuple[float, float]]] = []
        remaining_inners: List[List[Tuple[float, float]]] = []
        for inner_ring in unassigned_inners:
            centroid = ring_centroid(inner_ring)
            if ring_contains_point(outer_ring, centroid):
                assigned.append(inner_ring)
            else:
                remaining_inners.append(inner_ring)
        unassigned_inners = remaining_inners
        features.append(
            Feature(
                osm_id=f"relation/{relation_id}",
                outer=outer_ring,
                holes=assigned,
                tags=outer_tags,
            )
        )

    return features


def collect_features(
    nodes: Dict[int, Tuple[float, float]],
    ways: Dict[int, Tuple[List[int], Dict[str, str]]],
    relations: Dict[int, Tuple[List[Tuple[str, int, str]], Dict[str, str]]],
) -> List[Feature]:
    features: List[Feature] = []
    relation_way_ids: Set[int] = set()
    relation_candidates: List[Tuple[int, List[Tuple[str, int, str]], Dict[str, str]]] = []

    for relation_id, (members, tags) in relations.items():
        if tags.get("type") != "multipolygon":
            continue
        relation_candidates.append((relation_id, list(members), tags))
        member_has_building = any(
            member_type == "way" and is_building(ways.get(ref, ([], {}))[1])
            for member_type, ref, _ in members
        )
        if is_building(tags) or member_has_building:
            for member_type, ref, _ in members:
                if member_type == "way":
                    relation_way_ids.add(ref)

    for way_id, (node_refs, tags) in ways.items():
        if not is_building(tags):
            continue
        if way_id in relation_way_ids and "building:part" not in tags:
            # The relation will take care of the main building outline.
            continue
        feature = extract_way_feature(way_id, nodes, node_refs, tags)
        if feature:
            features.append(feature)

    for relation_id, members, tags in relation_candidates:
        if not is_building(tags) and not any(
            member_type == "way" and is_building(ways.get(ref, ([], {}))[1])
            for member_type, ref, _ in members
        ):
            continue
        features.extend(extract_relation_features(relation_id, nodes, ways, members, tags))

    return features


def determine_origin(features: Sequence[Feature]) -> Tuple[float, float]:
    latitudes: List[float] = []
    longitudes: List[float] = []
    for feature in features:
        for lat, lon in feature.outer:
            latitudes.append(lat)
            longitudes.append(lon)
        for hole in feature.holes:
            for lat, lon in hole:
                latitudes.append(lat)
                longitudes.append(lon)
    if not latitudes:
        raise ValueError("No geographic coordinates found in OSM input")
    return sum(latitudes) / len(latitudes), sum(longitudes) / len(longitudes)


def project_point(lat: float, lon: float, origin_lat: float, origin_lon: float) -> Tuple[float, float]:
    """Project WGS84 coordinates to a local tangent plane in metres."""

    radius = 6378137.0
    lat_rad = math.radians(lat)
    origin_lat_rad = math.radians(origin_lat)
    x = radius * math.radians(lon - origin_lon) * math.cos(origin_lat_rad)
    y = radius * (lat_rad - origin_lat_rad)
    return x, y


def project_feature(feature: Feature, origin: Tuple[float, float]) -> Feature:
    origin_lat, origin_lon = origin
    projected_outer = [
        project_point(lat, lon, origin_lat, origin_lon) for lat, lon in feature.outer
    ]
    projected_holes = [
        [project_point(lat, lon, origin_lat, origin_lon) for lat, lon in ring]
        for ring in feature.holes
    ]
    return Feature(
        osm_id=feature.osm_id,
        outer=projected_outer,
        holes=projected_holes,
        tags=feature.tags,
    )


def create_extrusion_from_ring(
    ring: Sequence[Tuple[float, float]],
    height: float,
    min_height: float,
) -> Optional[rhino3dm.Extrusion]:
    if len(ring) < 4:
        return None
    points = [rhino3dm.Point3d(x, y, 0.0) for x, y in ring]
    if points[0].DistanceTo(points[-1]) > 1e-6:
        points.append(points[0])
    curve = rhino3dm.PolylineCurve(points)
    if not curve.IsClosed:
        return None
    curve = curve.ToNurbsCurve()
    extrusion_height = height - min_height
    if extrusion_height <= 0:
        return None
    extrusion = rhino3dm.Extrusion.Create(curve, extrusion_height, True)
    if extrusion is None:
        return None
    extrusion.Translate(rhino3dm.Vector3d(0.0, 0.0, min_height))
    return extrusion


def add_feature_to_model(
    model: rhino3dm.File3dm,
    feature: Feature,
    height: float,
    min_height: float,
) -> None:
    extrusion = create_extrusion_from_ring(feature.outer, height, min_height)
    if extrusion is None:
        return
    attributes = rhino3dm.ObjectAttributes()
    attributes.Name = feature.name or feature.osm_id
    for key, value in feature.tags.items():
        if key.startswith("building") or key in {"height", "min_height", "name"}:
            attributes.SetUserString(key, value)
    attributes.SetUserString("osm:id", feature.osm_id)
    model.Objects.AddExtrusion(extrusion, attributes)


def build_model(
    features: Sequence[Feature],
    origin: Tuple[float, float],
    *,
    default_height: float,
    level_height: float,
) -> rhino3dm.File3dm:
    model = rhino3dm.File3dm()
    model.Settings.ModelUnitSystem = rhino3dm.UnitSystem.Meters
    model.Strings.Set("osm_to_3dm", "origin_lat", str(origin[0]))
    model.Strings.Set("osm_to_3dm", "origin_lon", str(origin[1]))

    projected_features = [project_feature(feature, origin) for feature in features]

    for original, projected in zip(features, projected_features):
        height, min_height = building_height(
            original.tags,
            default_height=default_height,
            level_height=level_height,
        )
        add_feature_to_model(model, projected, height, min_height)

    return model


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)

    nodes, ways, relations = parse_osm(args.input)
    features = collect_features(nodes, ways, relations)
    if not features:
        print("No buildings found in input", file=sys.stderr)
        return 1

    origin = determine_origin(features)
    model = build_model(
        features,
        origin,
        default_height=args.default_height,
        level_height=args.level_height,
    )
    if not model.Write(str(args.output), 7):
        print(f"Failed to write 3DM file to {args.output}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
