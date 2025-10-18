 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/README.md b/README.md
index bc16a6257d83fc679d6dd0fb51beb56f989efa58..74e0a22a8233ec0bc398addfba906c4dff57a00b 100644
--- a/README.md
+++ b/README.md
@@ -1,65 +1,53 @@
 # osm-to-3dm
 
-This repository contains a small utility that converts OpenStreetMap (OSM)
-building footprints into a 3DM (Rhino) file filled with simple building
-volumes.
+This repository contains a Python utility that converts OpenStreetMap (OSM)
+building footprints into a Rhino 3DM file filled with simple extrusions. The
+converter keeps `building=*` and `building:part=*` geometries, infers heights
+from common tags, and projects coordinates to a local tangent plane to remove
+distortion.
 
-## Convert in your browser
+## Install the dependency
 
-The repository ships with a WebAssembly-powered converter so you can try the
-workflow without installing anything: 
-
-1. Export an area from OpenStreetMap that contains `building=*` or
-   `building:part=*` features.
-2. Open [`viewer.html`](viewer.html) (or the published GitHub Pages site) in a
-   modern browser.
-3. Drop the exported `.osm` file onto the page. The converter extrudes the
-   buildings, previews them in 3D, and lets you download the resulting Rhino
-   `.3dm` file.
-
-All processing happens locally in the browser; files never leave your device.
-
-## Requirements
-
-To run the command-line script you still need
-[rhino3dm](https://github.com/mcneel/rhino3dm). Install it with:
+Both the command-line script and the optional local web interface rely on the
+[rhino3dm](https://github.com/mcneel/rhino3dm) package. Install it with:
 
 ```bash
 pip install rhino3dm
 ```
 
-## Usage
+## Command-line usage
 
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
 
-Whether you convert in the browser or via the CLI, you can use `viewer.html`
-to preview the resulting `.3dm` file directly in your browser.
+## Run a local drag-and-drop converter
 
-## GitHub Pages quick-start
+Prefer a graphical workflow? Start the included HTTP server and use it from any
+browser on your machine:
+
+```bash
+python web_converter.py --port 8000
+```
 
-If you want a simple landing page at
-`https://<username>.github.io/osm-to-3dm/`, point GitHub Pages to the `main`
-branch and root folder. This repository now includes an `index.html` file that
-walks through the installation and usage steps above and explains how to retry a
-failed GitHub Pages build. After saving the Pages settings, GitHub will deploy
-the site automatically.
+Then open <http://127.0.0.1:8000/> and drop an exported `.osm` file. The server
+processes the upload locally (nothing ever leaves your machine) and returns the
+converted `.3dm` file for download.
 
EOF
)
