import asyncio
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

NATIVE = Path(__file__).resolve().parents[1] / 'native'
sys.path.insert(0, str(NATIVE))
import bridge


@unittest.skipUnless(importlib.util.find_spec('mcp'), 'MCP SDK required (use the native helper Python environment)')
class MCPServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='luffy-mcp-test-')
        self.root = Path(self.tmp.name).resolve()
        self.request = Mock(return_value={'jobId': 'test-job', 'transport': 'browser'})
        with patch.object(bridge, 'runtime_dir', return_value=self.root / 'run'), patch.object(bridge, 'request', self.request):
            spec = importlib.util.spec_from_file_location('tested_mcp_server', NATIVE / 'mcp_server.py')
            self.server = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.server)
        self.start = patch.object(self.server.outputs, 'start')
        self.start.start()

    def tearDown(self):
        self.start.stop()
        self.server.outputs.close()
        self.tmp.cleanup()

    def download(self, **kwargs):
        return self.server.download_video('123', 7, 'https://example.com/video', **kwargs)

    def test_default_and_null_leave_request_result_and_directory_unchanged(self):
        result = self.download()
        self.assertIs(result, self.request.return_value)
        self.assertNotIn('output_directory', result)
        self.assertNotIn('outputDirectory', self.request.call_args.args[1])
        self.assertEqual(self.request.call_args.args[1], {'action': 'download', 'tabId': 7,
            'pageUrl': 'https://example.com/video', 'mediaId': None, 'quality': 'best',
            'format': 'mp4', 'cookies': 'none', 'variantIndex': None, 'audioIndex': None})
        self.download(output_directory=None)
        self.assertFalse((self.root / 'run').exists())

    def test_custom_directory_is_local_and_registered_after_submission(self):
        directory = self.root / '完整路径' / '素材库'
        result = self.download(output_directory=str(directory))
        self.assertEqual(result['output_directory'], str(directory))
        self.assertTrue(directory.is_dir())
        self.assertEqual(result['jobId'], 'test-job')
        self.assertNotIn('outputDirectory', self.request.call_args.args[1])
        self.assertTrue(self.server.outputs._record_path('123', 'test-job').is_file())

    def test_invalid_directory_stops_before_download(self):
        for directory in ['', 'relative/directory', '/tmp/\x00bad']:
            with self.subTest(directory=directory), self.assertRaises(ValueError):
                self.download(output_directory=directory)
        self.request.assert_not_called()

    def test_registration_failure_returns_started_job_id_and_explicit_error(self):
        with patch.object(self.server.outputs, 'register', side_effect=OSError('state disk full')):
            result = self.download(output_directory=str(self.root / 'valid'))
        self.assertEqual(result['jobId'], 'test-job')
        self.assertIn('勿重复下载', result['output_directory_error'])
        self.assertIn('state disk full', result['output_directory_error'])
        self.assertEqual(self.request.call_count, 1)

    def test_real_sdk_schema_has_optional_directory_without_changing_required_inputs(self):
        tool = next(t for t in asyncio.run(self.server.mcp.list_tools()) if t.name == 'download_video')
        self.assertEqual(tool.inputSchema['required'], ['connection', 'tab_id', 'page_url'])
        self.assertEqual(tool.inputSchema['properties']['output_directory']['default'], None)
        self.assertEqual(tool.inputSchema['properties']['output_directory']['anyOf'], [{'type': 'string'}, {'type': 'null'}])

    def test_get_jobs_defaults_are_identical(self):
        result = {'jobs': [{'id': 'old-job', 'status': 'complete', 'path': '/old/default/video.mp4'}]}
        self.request.return_value = result
        self.assertEqual(self.server.get_jobs('123'), result)
        self.request.assert_called_once_with('123', {'action': 'jobs', 'jobId': None})

    def test_failed_submission_is_not_retried_or_registered(self):
        self.request.side_effect = ValueError('浏览器响应超时；下载可能已开始，请先查询任务，勿自动重试')
        with self.assertRaisesRegex(ValueError, '勿自动重试'):
            self.download(output_directory=str(self.root / 'valid'))
        self.assertEqual(self.request.call_count, 1)
        self.assertFalse(self.server.outputs.state_directory.exists())
