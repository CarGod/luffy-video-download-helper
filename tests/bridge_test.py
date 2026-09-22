import concurrent.futures
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).resolve().parents[1] / 'native/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class BridgeTests(unittest.TestCase):
    def test_frames(self):
        self.assertEqual(bridge.read_message(io.BytesIO(b'{"ok":true}\n')), {'ok':True})
        for raw in [b'{}', b'x' * (bridge.LIMIT+1)]:
            with self.assertRaises(ValueError):
                bridge.read_message(io.BytesIO(raw))

    def test_concurrent_requests_and_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='lmcp-',dir='/tmp') as tmp:
            with patch.object(bridge, 'runtime_dir', return_value=Path(tmp)):
                def send(message):
                    server.resolve({'requestId':message['requestId'],'ok':True,'value':message['request']['number']})
                server = bridge.Bridge(send)
                try:
                    self.assertEqual(server.path.stat().st_mode & 0o777, 0o600)
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        values = list(pool.map(lambda n: bridge.request(str(os.getpid()), {'number':n}), range(12)))
                    self.assertEqual(values, list(range(12)))
                    with self.assertRaises(ValueError):
                        bridge.request('../other', {})
                finally:
                    server.close()
                self.assertFalse(server.path.exists())
