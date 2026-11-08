"""Dependency-only HTTP proxy. DNS addresses are checked and pinned before connect."""
import http.server, socket, socketserver, ipaddress, os, select, urllib.parse
ALLOWED=set(os.environ.get('GOOSE_ALLOWED_HOSTS','').split(','))
def destination(host,port):
    host=host.lower().rstrip('.')
    if host not in ALLOWED or port not in (80,443): raise ValueError('destination not permitted')
    addresses=socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(x[4][0]).is_global for x in addresses): raise ValueError('non-public address')
    family,kind,proto,_,address=addresses[0]
    s=socket.socket(family,kind,proto);s.settimeout(30);s.connect(address);return s
class Proxy(http.server.BaseHTTPRequestHandler):
    timeout=30
    def log_message(self,*args): pass
    def do_CONNECT(self):
        try:
            host,port=self.path.rsplit(':',1);up=destination(host,int(port))
            self.send_response(200);self.end_headers()
            with up:
                while True:
                    ready,_,_=select.select([self.connection,up],[],[],45)
                    if not ready:return
                    for src in ready:
                        data=src.recv(65536)
                        if not data:return
                        (up if src is self.connection else self.connection).sendall(data)
        except Exception:
            try:self.send_error(403)
            except Exception:pass
    def do_GET(self):
        try:
            u=urllib.parse.urlsplit(self.path)
            if u.scheme!='http' or u.username or u.password:raise ValueError('HTTP URL required')
            with destination(u.hostname,u.port or 80) as up:
                target=urllib.parse.urlunsplit(('','',u.path or '/',u.query,''))
                headers=''.join(f'{k}: {v}\r\n' for k,v in self.headers.items() if k.lower() not in ('proxy-connection','connection','proxy-authorization','authorization','cookie'))
                up.sendall(f'GET {target} HTTP/1.0\r\n{headers}Connection: close\r\n\r\n'.encode())
                while True:
                    data=up.recv(65536)
                    if not data:break
                    self.connection.sendall(data)
        except Exception:self.send_error(403)
    do_HEAD=do_GET
class Server(socketserver.ThreadingMixIn,http.server.HTTPServer):daemon_threads=True
Server(('0.0.0.0',8080),Proxy).serve_forever()
