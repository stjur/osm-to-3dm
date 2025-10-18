diff --git a/web_converter.py b/web_converter.py
new file mode 100644
index 0000000000000000000000000000000000000000..a4e8f2b52a7fb113a4dd02a7fc3c91f28c0cf9d8
--- /dev/null
+++ b/web_converter.py
@@ -0,0 +1,348 @@
+"""Serve a minimal web interface for converting OSM files to 3DM."""
+
+from __future__ import annotations
+
+import argparse
+import cgi
+from dataclasses import dataclass
+from http import HTTPStatus
+from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
+from pathlib import Path
+from typing import Optional
+from urllib.parse import quote
+
+from osm_to_3dm import (
+    DEFAULT_BUILDING_HEIGHT,
+    DEFAULT_LEVEL_HEIGHT,
+    convert_osm_to_3dm_bytes,
+)
+
+
+HTML_PAGE = """<!DOCTYPE html>
+<html lang=\"en\">
+  <head>
+    <meta charset=\"utf-8\" />
+    <title>OSM → 3DM converter</title>
+    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
+    <style>
+      :root {
+        color-scheme: light dark;
+        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
+        line-height: 1.5;
+      }
+      body {
+        margin: 0;
+        display: grid;
+        place-items: center;
+        min-height: 100vh;
+        background: radial-gradient(circle at top, #3d5afe 0%, #111 60%);
+        color: #fff;
+        padding: 2rem;
+      }
+      main {
+        background: rgba(0, 0, 0, 0.45);
+        border-radius: 18px;
+        padding: 2.5rem 2rem;
+        max-width: 32rem;
+        width: min(100%, 32rem);
+        box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.45);
+      }
+      h1 {
+        margin-top: 0;
+        font-weight: 600;
+        font-size: 1.6rem;
+        text-align: center;
+      }
+      p {
+        margin: 0.75rem 0;
+        color: rgba(255, 255, 255, 0.85);
+      }
+      form {
+        display: grid;
+        gap: 1rem;
+        margin-top: 1.5rem;
+      }
+      .drop-zone {
+        border: 2px dashed rgba(255, 255, 255, 0.45);
+        border-radius: 14px;
+        padding: 2rem;
+        text-align: center;
+        transition: border-color 0.2s ease, background 0.2s ease;
+        background: rgba(255, 255, 255, 0.05);
+      }
+      .drop-zone.dragover {
+        border-color: #90caf9;
+        background: rgba(144, 202, 249, 0.2);
+      }
+      button {
+        padding: 0.85rem 1.2rem;
+        border-radius: 999px;
+        border: none;
+        background: linear-gradient(135deg, #90caf9, #536dfe);
+        color: #111;
+        font-size: 1rem;
+        font-weight: 600;
+        cursor: pointer;
+      }
+      button:disabled {
+        opacity: 0.5;
+        cursor: wait;
+      }
+      #status {
+        min-height: 1.5rem;
+        text-align: center;
+        font-size: 0.95rem;
+        color: rgba(255, 255, 255, 0.7);
+      }
+    </style>
+  </head>
+  <body>
+    <main>
+      <h1>OSM → 3DM converter</h1>
+      <p>Drop an OpenStreetMap export below or pick a file manually. The
+      converter keeps only <code>building</code> and <code>building:part</code>
+      features, infers heights, fixes projection distortion, and returns a Rhino
+      <code>.3dm</code> file.</p>
+      <form id=\"upload-form\">
+        <div id=\"drop-zone\" class=\"drop-zone\">
+          Drop a <code>.osm</code> file here or click to browse.
+          <input id=\"file-input\" name=\"file\" type=\"file\" accept=\".osm,.xml\" required style=\"display:none\" />
+        </div>
+        <button type=\"submit\">Convert to 3DM</button>
+        <p id=\"status\"></p>
+      </form>
+    </main>
+    <script>
+      const form = document.getElementById('upload-form');
+      const dropZone = document.getElementById('drop-zone');
+      const fileInput = document.getElementById('file-input');
+      const status = document.getElementById('status');
+
+      const setStatus = (message, isError = false) => {
+        status.textContent = message;
+        status.style.color = isError ? '#ff8a80' : 'rgba(255, 255, 255, 0.7)';
+      };
+
+      dropZone.addEventListener('click', () => fileInput.click());
+
+      const preventDefaults = (event) => {
+        event.preventDefault();
+        event.stopPropagation();
+      };
+
+      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
+        dropZone.addEventListener(eventName, preventDefaults, false);
+      });
+
+      ['dragenter', 'dragover'].forEach(eventName => {
+        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
+      });
+
+      ['dragleave', 'drop'].forEach(eventName => {
+        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
+      });
+
+      dropZone.addEventListener('drop', (event) => {
+        const dt = event.dataTransfer;
+        if (dt && dt.files && dt.files.length) {
+          fileInput.files = dt.files;
+          setStatus(`${dt.files[0].name} selected.`);
+        }
+      });
+
+      fileInput.addEventListener('change', () => {
+        if (fileInput.files.length) {
+          setStatus(`${fileInput.files[0].name} selected.`);
+        } else {
+          setStatus('');
+        }
+      });
+
+      form.addEventListener('submit', async (event) => {
+        event.preventDefault();
+        if (!fileInput.files.length) {
+          setStatus('Please choose an .osm file first.', true);
+          return;
+        }
+
+        const file = fileInput.files[0];
+        const formData = new FormData();
+        formData.append('file', file);
+
+        setStatus('Converting…');
+        form.querySelector('button').disabled = true;
+
+        try {
+          const response = await fetch('/convert', {
+            method: 'POST',
+            body: formData,
+          });
+
+          if (!response.ok) {
+            const message = await response.text();
+            throw new Error(message || 'Conversion failed.');
+          }
+
+          const blob = await response.blob();
+          const downloadName = file.name.replace(/\.[^.]+$/, '') + '.3dm';
+          const url = window.URL.createObjectURL(blob);
+          const anchor = document.createElement('a');
+          anchor.href = url;
+          anchor.download = downloadName;
+          anchor.click();
+          window.URL.revokeObjectURL(url);
+          setStatus('Conversion complete.');
+        } catch (error) {
+          setStatus(error.message || 'Conversion failed.', true);
+        } finally {
+          form.querySelector('button').disabled = false;
+        }
+      });
+    </script>
+  </body>
+</html>
+"""
+
+
+@dataclass
+class ConverterConfig:
+    default_height: float
+    level_height: float
+
+
+class ConverterRequestHandler(BaseHTTPRequestHandler):
+    """Handle upload requests and return converted Rhino files."""
+
+    server_version = "OSMTo3dmConverter/1.0"
+
+    @property
+    def config(self) -> ConverterConfig:
+        return getattr(self.server, "converter_config")  # type: ignore[attr-defined]
+
+    def do_GET(self) -> None:  # noqa: N802 (HTTP verb signature)
+        if self.path not in {"/", "/index.html"}:
+            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
+            return
+
+        body = HTML_PAGE.encode("utf-8")
+        self.send_response(HTTPStatus.OK)
+        self.send_header("Content-Type", "text/html; charset=utf-8")
+        self.send_header("Content-Length", str(len(body)))
+        self.send_header("Cache-Control", "no-store")
+        self.end_headers()
+        self.wfile.write(body)
+
+    def do_POST(self) -> None:  # noqa: N802 (HTTP verb signature)
+        if self.path != "/convert":
+            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
+            return
+
+        content_type = self.headers.get("Content-Type")
+        if not content_type:
+            self.send_error(HTTPStatus.BAD_REQUEST, "Missing Content-Type header")
+            return
+
+        environ = {
+            "REQUEST_METHOD": "POST",
+            "CONTENT_TYPE": content_type,
+        }
+        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ=environ)
+
+        if "file" not in form:
+            self.send_error(HTTPStatus.BAD_REQUEST, "Missing uploaded file")
+            return
+
+        field = form["file"]
+        if isinstance(field, list):
+            field = field[0]
+
+        filename = Path(field.filename or "buildings.osm").name
+        data = field.file.read() if field.file else b""
+
+        if not data:
+            self.send_error(HTTPStatus.BAD_REQUEST, "Empty upload")
+            return
+
+        try:
+            payload = convert_osm_to_3dm_bytes(
+                data,
+                default_height=self.config.default_height,
+                level_height=self.config.level_height,
+            )
+        except ValueError as exc:
+            self._send_text_response(str(exc), HTTPStatus.BAD_REQUEST)
+            return
+        except Exception as exc:  # pragma: no cover - unexpected failure path
+            self._send_text_response(f"Conversion failed: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)
+            return
+
+        download_name = Path(filename).stem or "buildings"
+        download_name = f"{download_name}.3dm"
+        encoded = quote(download_name)
+
+        self.send_response(HTTPStatus.OK)
+        self.send_header("Content-Type", "application/octet-stream")
+        self.send_header("Content-Length", str(len(payload)))
+        self.send_header(
+            "Content-Disposition",
+            f"attachment; filename=\"{download_name}\"; filename*=UTF-8''{encoded}",
+        )
+        self.send_header("Cache-Control", "no-store")
+        self.end_headers()
+        self.wfile.write(payload)
+
+    def log_message(self, format: str, *args) -> None:  # noqa: A003 - matching BaseHTTPRequestHandler signature
+        # Reduce noise – stdout already shows startup instructions.
+        return
+
+    def _send_text_response(self, message: str, status: HTTPStatus) -> None:
+        body = message.encode("utf-8")
+        self.send_response(status)
+        self.send_header("Content-Type", "text/plain; charset=utf-8")
+        self.send_header("Content-Length", str(len(body)))
+        self.send_header("Cache-Control", "no-store")
+        self.end_headers()
+        self.wfile.write(body)
+
+
+def run_server(host: str, port: int, config: ConverterConfig) -> None:
+    server = ThreadingHTTPServer((host, port), ConverterRequestHandler)
+    server.converter_config = config  # type: ignore[attr-defined]
+    address = f"http://{host}:{port}"
+    print(f"Serving converter on {address} – drop OSM files in your browser to convert them.")
+    print("Press Ctrl+C to stop.")
+    try:
+        server.serve_forever()
+    except KeyboardInterrupt:  # pragma: no cover - manual shutdown
+        print("\nShutting down converter server…")
+    finally:
+        server.server_close()
+
+
+def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
+    parser = argparse.ArgumentParser(description="Run a local OSM → 3DM converter server")
+    parser.add_argument("--host", default="127.0.0.1", help="Interface to bind (default: 127.0.0.1)")
+    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
+    parser.add_argument(
+        "--default-height",
+        type=float,
+        default=DEFAULT_BUILDING_HEIGHT,
+        help="Fallback height in metres when buildings lack explicit heights",
+    )
+    parser.add_argument(
+        "--level-height",
+        type=float,
+        default=DEFAULT_LEVEL_HEIGHT,
+        help="Average storey height used when only building:levels is available",
+    )
+    return parser.parse_args(argv)
+
+
+def main(argv: Optional[list[str]] = None) -> None:
+    args = parse_args(argv)
+    config = ConverterConfig(default_height=args.default_height, level_height=args.level_height)
+    run_server(args.host, args.port, config)
+
+
+if __name__ == "__main__":
+    main()
