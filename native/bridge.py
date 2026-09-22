"""Private, per-native-host Unix socket bridge. No TCP listener."""
import json
import os
from pathlib import Path
import queue
import socket
import threading
import uuid

LIMIT = 1024 * 1024

def runtime_dir():
    path = Path.home() / '.luffy-video-helper' / 'run'
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path

def read_message(stream):
    raw = stream.readline(LIMIT + 1)
    if len(raw) > LIMIT or not raw.endswith(b'\n'):
        raise ValueError('Invalid bridge frame')
    return json.loads(raw)

class Bridge:
    def __init__(self, send):
        self.closed = False
        self.send = send
        self.pending = {}
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(8)
        self.path = runtime_dir() / f'{os.getpid()}.sock'
        self.server = socket.socket(socket.AF_UNIX)
        self.path.unlink(missing_ok=True)  # Recover a stale socket after PID reuse.
        self.server.bind(str(self.path))
        self.path.chmod(0o600)
        self.server.listen(8)
        self.server.settimeout(0.5)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while not self.closed:
            try:
                client, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if not self.slots.acquire(False):
                client.close()
                continue
            threading.Thread(target=self.serve, args=(client,), daemon=True).start()

    def serve(self, client):
        ident = str(uuid.uuid4())
        reply = queue.Queue(maxsize=1)
        try:
            client.settimeout(100)
            with client, client.makefile('rb') as stream:
                try:
                    request = read_message(stream)
                    if not isinstance(request, dict):
                        raise ValueError('Invalid request')
                    with self.lock:
                        if self.closed: raise ValueError("MCP 服务已关闭")
                        self.pending[ident] = reply
                    self.send({'event': 'mcp', 'requestId': ident, 'request': request})
                    result = reply.get(timeout=90)
                except queue.Empty:
                    result = {'ok': False, 'error': '浏览器响应超时；下载可能已开始，请先查询任务，勿自动重试'}
                except Exception as e:
                    result = {'ok': False, 'error': str(e)}
                client.sendall((json.dumps(result) + '\n').encode())
        except OSError:
            pass
        finally:
            with self.lock:
                self.pending.pop(ident, None)
            self.slots.release()

    def resolve(self, message):
        with self.lock:
            reply = self.pending.get(message.get('requestId'))
            if reply and reply.empty():
                reply.put_nowait(message)

    def close(self):
        with self.lock:
            self.closed = True
            for reply in self.pending.values():
                if reply.empty(): reply.put_nowait({'ok': False, 'error': 'MCP 服务已关闭'})
        self.server.close()
        self.path.unlink(missing_ok=True)


def request(connection, payload):
    if not isinstance(connection, str) or not connection.isdigit():
        raise ValueError('无效的 connection；请先调用 list_connections')
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(100)
        client.connect(str(runtime_dir() / f'{connection}.sock'))
        client.sendall((json.dumps(payload) + '\n').encode())
        with client.makefile('rb') as stream:
            result = read_message(stream)
    if not result.get('ok'):
        raise ValueError(result.get('error', 'Bridge error'))
    return result.get('value')
