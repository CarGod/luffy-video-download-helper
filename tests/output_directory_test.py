import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('output_directory', Path(__file__).resolve().parents[1] / 'native/output_directory.py')
output = importlib.util.module_from_spec(spec)
spec.loader.exec_module(output)


class OutputDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='luffy-output-')
        self.root = Path(self.temporary.name).resolve()
        self.directory = self.root / '完整目标路径' / '素材'
        self.source = self.root / 'Downloads' / 'video.mp4'
        self.source.parent.mkdir()
        self.content = bytes(range(256)) * 2048
        self.source.write_bytes(self.content)
        self.job = {'id': 'fixture-job', 'status': 'complete', 'path': str(self.source), 'progress': 100}
        self.manager = output.OutputDirectories(self.root / 'records', lambda *args: {'jobs': [self.job]})
        # Deterministic unit tests; the integration harness exercises the worker.
        self.start_patch = patch.object(self.manager, 'start')
        self.start_patch.start()

    def tearDown(self):
        self.start_patch.stop()
        self.manager.close()
        self.temporary.cleanup()

    def register(self):
        directory = output.prepare_directory(str(self.directory))
        self.manager.register('123', self.job['id'], directory)

    def test_absent_directory_keeps_default_job_and_file(self):
        self.assertIs(self.manager.apply('123', self.job), self.job)
        self.assertEqual(self.source.read_bytes(), self.content)
        self.assertFalse(self.directory.exists())
        self.assertFalse(self.manager.state_directory.exists())

    def test_full_absolute_directory_is_created_and_file_moved(self):
        self.register()
        result = self.manager.jobs('123')['jobs'][0]
        self.assertEqual(result['path'], str(self.directory / self.source.name))
        self.assertEqual(Path(result['path']).read_bytes(), self.content)
        self.assertEqual(result['status'], 'complete')
        self.assertFalse(self.source.exists())
        self.assertEqual(list(self.directory.iterdir()), [Path(result['path'])])

    def test_home_expansion(self):
        project = Path(__file__).resolve().parents[1]
        if not project.is_relative_to(Path.home()):
            self.skipTest('project must be inside the current home for the ~/ fixture')
        directory = output.prepare_directory('~/' + str(project.relative_to(Path.home())))
        self.assertEqual(directory, project)

    def test_invalid_and_unwritable_directories(self):
        for value in ['', ' ', 'relative/path', 42, False, '/tmp/\0bad', '/tmp/\nbad']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                output.prepare_directory(value)
        with self.assertRaisesRegex(ValueError, '无法使用下载目录'):
            output.prepare_directory(str(self.source))
        with patch.object(output.tempfile, 'TemporaryFile', side_effect=PermissionError('permission denied')):
            with self.assertRaisesRegex(ValueError, 'permission denied'):
                output.prepare_directory(str(self.directory))

    def test_conflicts_and_multiple_clients_never_overwrite(self):
        self.register()
        existing = self.directory / self.source.name
        existing.write_bytes(b'existing')
        (self.directory / 'video (1).mp4').write_bytes(b'also existing')
        other = output.OutputDirectories(self.manager.state_directory, self.manager.request)
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            list(pool.map(lambda index: (self.manager if index % 2 else other).apply('123', self.job), range(10)))
        result = other.apply('123', self.job)
        self.assertEqual(existing.read_bytes(), b'existing')
        self.assertEqual((self.directory / 'video (1).mp4').read_bytes(), b'also existing')
        self.assertEqual(Path(result['path']).read_bytes(), self.content)
        self.assertEqual(Path(result['path']).name, 'video (2).mp4')
        self.assertEqual(len(list(self.directory.iterdir())), 3)

    def test_copy_failure_retains_source_and_reports_error_without_retry(self):
        self.register()
        with patch.object(output.shutil, 'copyfileobj', side_effect=OSError('No space left on device')):
            result = self.manager.apply('123', self.job)
        self.assertEqual(result['status'], 'error')
        self.assertIn('No space left on device', result['error'])
        self.assertEqual(result['source_path'], str(self.source))
        self.assertIsNone(result['path'])
        self.assertEqual(self.source.read_bytes(), self.content)
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assertEqual(self.manager.apply('123', self.job)['status'], 'error')

    def test_directory_removed_then_recreated_at_completion(self):
        self.register()
        self.directory.rmdir()
        result = self.manager.apply('123', self.job)
        self.assertEqual(Path(result['path']).read_bytes(), self.content)

    def test_completion_permission_failure_retains_source(self):
        self.register()
        with patch.object(output, 'prepare_directory', side_effect=PermissionError('permission revoked')):
            result = self.manager.apply('123', self.job)
        self.assertEqual(result['status'], 'error')
        self.assertIn('permission revoked', result['error'])
        self.assertTrue(self.source.exists())

    def test_missing_empty_symlink_and_relative_source_are_errors(self):
        for kind in ['missing', 'empty', 'symlink', 'relative']:
            with self.subTest(kind=kind):
                self.source.unlink(missing_ok=True)
                self.job = {**self.job, 'id': kind, 'path': str(self.source)}
                if kind == 'empty':
                    self.source.touch()
                elif kind == 'symlink':
                    self.source.symlink_to('/etc/hosts')
                elif kind == 'relative':
                    self.job['path'] = 'video.mp4'
                self.register()
                self.assertEqual(self.manager.apply('123', self.job)['status'], 'error')

    def test_cancelled_failed_and_pending_jobs_are_not_moved(self):
        for status in ['cancelled', 'error', 'downloading']:
            with self.subTest(status=status):
                job = {**self.job, 'id': status, 'status': status}
                self.manager.register('123', status, output.prepare_directory(str(self.directory)))
                self.assertEqual(self.manager.apply('123', job)['status'], status)
                self.assertTrue(self.source.exists())

    def test_pending_records_resume_and_completed_records_are_idempotent(self):
        self.register()
        restarted = output.OutputDirectories(self.manager.state_directory, self.manager.request)
        restarted.poll()
        result = restarted.jobs('123')['jobs'][0]
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(Path(result['path']).read_bytes(), self.content)
        self.manager.register('123', self.job['id'], self.directory)
        self.assertEqual(self.manager.apply('123', self.job)['path'], result['path'])
        self.assertEqual(len(list(self.directory.iterdir())), 1)

    def test_interrupted_publication_is_reported_as_uncertain_not_retried(self):
        self.register()
        path = self.manager._record_path('123', self.job['id'])
        record = json.loads(path.read_text())
        record.update(status='publishing', source_path=str(self.source), path=str(self.directory / 'video.mp4'))
        self.manager._write(path, record)
        result = self.manager.apply('123', self.job)
        self.assertEqual(result['status'], 'error')
        self.assertIn('不确定', result['error'])
        self.assertTrue(self.source.exists())
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_same_directory_avoids_copy(self):
        self.manager.register('123', self.job['id'], self.source.parent)
        self.assertEqual(self.manager.apply('123', self.job)['path'], str(self.source))
        self.assertTrue(self.source.exists())

    def test_source_cleanup_failure_preserves_final_file_and_reports_warning(self):
        self.register()
        original_unlink = Path.unlink

        def unlink(path, *args, **kwargs):
            if path == self.source:
                raise PermissionError('source cleanup denied')
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, 'unlink', unlink):
            result = self.manager.apply('123', self.job)
        self.assertEqual(result['status'], 'complete')
        self.assertIn('source cleanup denied', result['warning'])
        self.assertEqual(Path(result['path']).read_bytes(), self.content)
        self.assertEqual(self.source.read_bytes(), self.content)

    def test_all_existing_transports_keep_their_type_and_use_the_custom_path(self):
        for kind in ['file', 'hls', 'native']:
            with self.subTest(kind=kind):
                source = self.source.parent / (kind + '.mp4')
                source.write_bytes(self.content)
                job = {**self.job, 'id': kind, 'type': kind, 'path': str(source)}
                self.manager.register('123', kind, output.prepare_directory(str(self.directory)))
                result = self.manager.apply('123', job)
                self.assertEqual(result['type'], kind)
                self.assertEqual(Path(result['path']).parent, self.directory)
                self.assertEqual(Path(result['path']).read_bytes(), self.content)

    def test_other_jobs_and_connections_are_unaffected(self):
        self.register()
        self.assertIs(self.manager.apply('456', self.job), self.job)
        self.assertEqual(self.manager.apply('123', {**self.job, 'id': 'unrelated'})['status'], self.job['status'])
        self.assertTrue(self.source.exists())

    def test_nonregular_fifo_and_missing_result_path_fail_without_blocking(self):
        fifo = self.root / 'not-a-video'
        os.mkfifo(fifo)
        for ident, source in [('fifo', str(fifo)), ('no-path', None)]:
            with self.subTest(ident=ident):
                job = {**self.job, 'id': ident, 'path': source}
                self.manager.register('123', ident, output.prepare_directory(str(self.directory)))
                self.assertEqual(self.manager.apply('123', job)['status'], 'error')
        self.assertTrue(self.source.exists())

    def test_source_changed_during_copy_is_retained_and_not_published(self):
        self.register()
        original_copy = output.shutil.copyfileobj

        def copy(source, target, **kwargs):
            original_copy(source, target, **kwargs)
            with self.source.open('ab') as changed:
                changed.write(b'changed')

        with patch.object(output.shutil, 'copyfileobj', copy):
            result = self.manager.apply('123', self.job)
        self.assertEqual(result['status'], 'error')
        self.assertIn('发生变化', result['error'])
        self.assertTrue(self.source.exists())
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_unsupported_publication_fails_and_retains_source(self):
        self.register()
        with patch.object(output.os, 'link', side_effect=OSError('Operation not supported')):
            result = self.manager.apply('123', self.job)
        self.assertEqual(result['status'], 'error')
        self.assertIn('Operation not supported', result['error'])
        self.assertEqual(self.source.read_bytes(), self.content)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_invalid_destination_record_does_not_break_other_job_results(self):
        self.register()
        path = self.manager._record_path('123', self.job['id'])
        for content in ['{broken', 'null', '{}']:
            with self.subTest(content=content):
                path.write_text(content)
                result = self.manager.apply('123', self.job)
                self.assertEqual(result['status'], 'error')
                self.assertIn('记录无法读取', result['error'])
                self.assertTrue(self.source.exists())
                self.assertIs(self.manager.apply('456', self.job), self.job)

    def test_connection_error_keeps_pending_record(self):
        self.register()
        with patch.object(self.manager, 'request', side_effect=OSError('connection gone')):
            self.manager.poll()
            with self.assertRaises(OSError):
                self.manager.jobs('123')
        self.assertEqual(json.loads(self.manager._record_path('123', self.job['id']).read_text())['status'], 'pending')
