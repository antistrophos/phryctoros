"""Dev server: python serve.py [port] — static files with Cache-Control: no-store,
so edited src/*.js always reloads. (The stock http.server's heuristic caching
serves stale modules mid-iteration.)

POST /harness-result?page=<name> writes the request body to
harness/results/<name>.json — the suite pages post their verdict there so
results are file-readable without touching the browser pane."""
import os
import re
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

os.chdir(os.path.dirname(os.path.abspath(__file__)))  # serve the repo root regardless of cwd


class NoStoreHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/harness-result":
            self.send_response(404)
            self.end_headers()
            return
        page = parse_qs(parsed.query).get("page", ["suite"])[0]
        page = re.sub(r"[^A-Za-z0-9_-]", "", page)[:40] or "suite"
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        os.makedirs(os.path.join("harness", "results"), exist_ok=True)
        with open(os.path.join("harness", "results", page + ".json"), "wb") as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):  # quiet
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    print(f"serving on http://localhost:{port} (no-store)")
    ThreadingHTTPServer(("127.0.0.1", port), NoStoreHandler).serve_forever()
