from http.server import BaseHTTPRequestHandler, HTTPServer
import urllib.parse, os
class H(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','*'); self.send_header('Access-Control-Allow-Methods','POST'); self.end_headers()
    def do_POST(self):
        q=urllib.parse.urlparse(self.path); name=urllib.parse.parse_qs(q.query).get('name',['x'])[0]
        n=int(self.headers.get('Content-Length',0)); body=self.rfile.read(n)
        open('/private/tmp/claude-501/dumps/'+os.path.basename(name)+'.json','wb').write(body)
        self.send_response(200); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self,*a): pass
HTTPServer(('127.0.0.1',8766),H).serve_forever()
