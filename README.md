# osm-to-3dm

This repository contains a small utility that converts OpenStreetMap (OSM)
building footprints into a 3DM (Rhino) file filled with simple building
volumes.

## Convert in your browser

The repository ships with a WebAssembly-powered converter so you can try the
workflow without installing anything: 

1. Export an area from OpenStreetMap that contains `building=*` or
   `building:part=*` features.
2. Open [`viewer.html`](viewer.html) (or the published GitHub Pages site) in a
   modern browser.
3. Drop the exported `.osm` file onto the page. The converter extrudes the
   buildings, previews them in 3D, and lets you download the resulting Rhino
   `.3dm` file.

All processing happens locally in the browser; files never leave your device.

## Requirements

To run the command-line script you still need
[rhino3dm](https://github.com/mcneel/rhino3dm). Install it with:

```bash
pip install rhino3dm
```

## Usage

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

Whether you convert in the browser or via the CLI, you can use `viewer.html`
to preview the resulting `.3dm` file directly in your browser.

## GitHub Pages quick-start

If you want a simple landing page at
`https://<username>.github.io/osm-to-3dm/`, point GitHub Pages to the `main`
branch and root folder. This repository now includes an `index.html` file that
walks through the installation and usage steps above and explains how to retry a
failed GitHub Pages build. After saving the Pages settings, GitHub will deploy
the site automatically.
