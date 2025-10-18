# osm-to-3dm

This repository contains a Python utility that converts OpenStreetMap (OSM)
building footprints into a Rhino 3DM file filled with simple extrusions. The
converter keeps `building=*` and `building:part=*` geometries, infers heights
from common tags, and projects coordinates to a local tangent plane to remove
distortion.

## Install the dependency

Both the command-line script and the optional local web interface rely on the
[rhino3dm](https://github.com/mcneel/rhino3dm) package. Install it with:

```bash
pip install rhino3dm
```

## Command-line usage

1. Export an area of interest from OpenStreetMap as an `.osm` XML file. The
   export must contain `building=*` or `building:part=*` features.
2. Run the converter:

   ```bash
   python osm_to_3dm.py map.osm buildings.3dm
   ```

   Additional options are available:

   * `--default-height` – fallback height (metres) used when the data does not
     define a height. Defaults to 10 metres.
   * `--level-height` – average storey height (metres) used when only
     `building:levels` is present. Defaults to 3 metres.

The script extracts polygons and multipolygons, reads `height` and
`min_height` tags (falling back to `building:height` / `building:min_height` or
`building:levels`), converts their coordinates to a local tangent plane to
avoid projection distortions, and writes one extrusion per footprint to the
output 3DM file. Basic metadata (such as the source OSM identifier and the
projection origin) is embedded into the file for future reference.

## Run a local drag-and-drop converter

Prefer a graphical workflow? Start the included HTTP server and use it from any
browser on your machine:

```bash
python web_converter.py --port 8000
```

Then open <http://127.0.0.1:8000/> and drop an exported `.osm` file. The server
processes the upload locally (nothing ever leaves your machine) and returns the
converted `.3dm` file for download.
