"""Dev server: python serve.py [port] — static files with Cache-Control: no-store,
so edited src/*.js always reloads. (The stock http.server's heuristic caching
serves stale modules mid-iteration.)"""
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

os.chdir(os.path.dirname(os.path.abspath(__file__)))  # serve the repo root regardless of cwd


class NoStoreHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quiet
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    print(f"serving on http://localhost:{port} (no-store)")
    ThreadingHTTPServer(("127.0.0.1", port), NoStoreHandler).serve_forever()
