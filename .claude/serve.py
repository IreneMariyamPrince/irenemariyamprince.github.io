import os
import http.server
import socketserver

# Serve the scratchpad mirror: the Desktop copy is TCC-protected for
# processes spawned outside the terminal. Sync with:
#   rsync -a --delete --exclude .claude /Users/nobin/Desktop/Irene_port/ <SITE>
SITE = (
    "/private/tmp/claude-501/-Users-nobin-Desktop-Irene-port/"
    "ee011075-6b75-40ef-9484-1e8c5652d82c/scratchpad/site"
)
os.chdir(SITE)

PORT = 4173


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving on http://127.0.0.1:{PORT}")
    httpd.serve_forever()
