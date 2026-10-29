"""Local-only destination handling; browser downloads still use their normal staging path."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import threading


def prepare_directory(value):
    if (not isinstance(value, str) or not value.strip() or len(value) > 4096
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError('output_directory 必须为非空的绝对目录路径')
    path = Path(value)
    try:
        path = path.expanduser()
        if not path.is_absolute():
            raise ValueError('output_directory 必须为绝对路径（可使用 ~/），不能为相对路径')
        path = path.resolve()
        path.mkdir(parents=True, exist_ok=True)
        # Probe actual creation, not os.access(): ACLs, read-only mounts and disk
        # errors must fail before submitting a download.
        with tempfile.TemporaryFile(dir=path):
            pass
    except (OSError, RuntimeError) as e:
        raise ValueError(f'无法使用下载目录 {path}: {e}') from e
    return path


class OutputDirectories:
    def __init__(self, state_directory, request):
        self.state_directory = Path(state_directory)
        self.request = request
        self.wake = threading.Event()
        self.stopped = threading.Event()
        self.worker = None
        self.worker_lock = threading.Lock()

    def _record_path(self, connection, job_id):
        key = hashlib.sha256(json.dumps([connection, job_id]).encode()).hexdigest()
        return self.state_directory / (key + '.json')

    def _write(self, path, record):
        fd, temporary = tempfile.mkstemp(prefix='.record-', dir=self.state_directory)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(record, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def register(self, connection, job_id, directory):
        self.state_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_directory.chmod(0o700)
        path = self._record_path(connection, job_id)
        # Callers register only newly returned job IDs. Never reset an older
        # completed/error record, which could otherwise move a file twice.
        with path.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not path.exists():
                self._write(path, {'connection': connection, 'job_id': job_id,
                    'output_directory': str(directory), 'status': 'pending'})
        self.start()
        self.wake.set()

    def _move(self, record, path, source):
        source = Path(source)
        if not source.is_absolute():
            raise ValueError('下载结果没有提供绝对文件路径')
        # Do not follow a substituted symlink. Files are supplied by the existing
        # native/Chrome job result, never by page titles or tool input.
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            original = os.fstat(stream.fileno())
            if not stat.S_ISREG(original.st_mode) or not original.st_size:
                raise ValueError('下载结果不是非空普通文件')
            directory = prepare_directory(record['output_directory'])
            if source.parent.resolve() == directory:
                record.update(status='complete', path=str(source), bytes=original.st_size)
                self._write(path, record)
                return
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(prefix='.luffy-save-', dir=directory, delete=False) as target:
                    temporary = Path(target.name)
                    shutil.copyfileobj(stream, target, length=1024 * 1024)
                    target.flush()
                    os.fsync(target.fileno())
                latest = os.fstat(stream.fileno())
                if (latest.st_size, latest.st_mtime_ns) != (original.st_size, original.st_mtime_ns):
                    raise ValueError('下载源文件在保存时发生变化，已保留原文件')
                candidate = directory / source.name
                index = 1
                while True:
                    # Persist intent before publication. A process crash in this
                    # window is reported as uncertain, never automatically retried.
                    record.update(status='publishing', source_path=str(source), path=str(candidate))
                    self._write(path, record)
                    try:
                        os.link(temporary, candidate)
                        break
                    except FileExistsError:
                        candidate = directory / f'{source.stem} ({index}){source.suffix}'
                        index += 1
                # The complete file is visible atomically, with no overwrite.
                record.update(status='complete', path=str(candidate), bytes=original.st_size)
                self._write(path, record)
                # Persist success first. If cleanup fails, the final path is still
                # valid and the duplicate is explicitly reported.
                try:
                    current = source.lstat()
                    if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (
                            original.st_dev, original.st_ino, original.st_size, original.st_mtime_ns):
                        raise ValueError('源文件已变化，未删除')
                    source.unlink()
                except (OSError, ValueError) as e:
                    record['warning'] = f'目标文件已保存；暂存源文件保留在 {source}: {e}'
                    self._write(path, record)
            finally:
                if temporary:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass  # Never hide a completed save due to temp cleanup.

    def apply(self, connection, job):
        path = self._record_path(connection, job['id'])
        if not path.exists():
            return job
        with path.with_suffix('.lock').open('a') as lock:
            # A worker or another MCP client may be saving the same job.
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {**job, 'status': 'saving', 'path': None, 'progress': 99}
            try:
                record = json.loads(path.read_text())
                if (record['connection'] != connection or record['job_id'] != job['id']
                        or record['status'] not in ('pending', 'publishing', 'complete', 'error', 'cancelled')
                        or not isinstance(record['output_directory'], str)):
                    raise ValueError('invalid destination record')
            except (OSError, ValueError, KeyError, TypeError) as e:
                return {**job, 'status': 'error', 'path': None, 'source_path': job.get('path'),
                        'error': f'目录保存记录无法读取；请核对源文件，勿重复下载: {e}'}
            if record['status'] == 'publishing':
                record.update(status='error', error=(
                    '上次目录保存被中断，落盘结果不确定；请核对 attempted_path 与 source_path，勿重新下载'))
                self._write(path, record)
            if record['status'] == 'pending' and job['status'] in ('error', 'cancelled'):
                record.update(status=job['status'], error=job.get('error', ''))
                self._write(path, record)
            if record['status'] == 'pending' and job['status'] == 'complete':
                try:
                    source = job.get('path')
                    if not source:
                        raise ValueError('下载已结束，但浏览器未提供实际文件路径')
                    record['source_path'] = source
                    self._move(record, path, source)
                except Exception as e:
                    record.update(status='error', error=f'保存到指定目录失败；请核对源文件与目标路径，勿重复下载: {e}')
                    self._write(path, record)
            result = {**job, 'output_directory': record['output_directory']}
            if record['status'] == 'complete':
                result.update(status='complete', progress=100, path=record['path'], bytes=record['bytes'])
            elif record['status'] == 'error':
                result.update(status='error', error=record['error'], path=None,
                              source_path=record.get('source_path'), attempted_path=record.get('path'))
            if record.get('warning'):
                result['warning'] = record['warning']
            return result

    def jobs(self, connection, job_id=None):
        result = self.request(connection, {'action': 'jobs', 'jobId': job_id})
        return {**result, 'jobs': [self.apply(connection, job) for job in result['jobs']]}

    def poll(self):
        if not self.state_directory.exists():
            return
        connections = set()
        for path in self.state_directory.glob('*.json'):
            try:
                record = json.loads(path.read_text())
                if record['status'] in ('pending', 'publishing'):
                    connections.add(record['connection'])
            except (OSError, ValueError, KeyError):
                continue
        for connection in connections:
            try:
                self.jobs(connection)
            except Exception:
                # Connection loss is not proof of download failure. Keep the
                # durable intent and let get_jobs surface the connection error.
                continue

    def start(self):
        with self.worker_lock:
            if self.worker is None:
                self.worker = threading.Thread(target=self._run, daemon=True)
                self.worker.start()

    def _run(self):
        while not self.stopped.is_set():
            self.poll()
            self.wake.wait(2)
            self.wake.clear()

    def close(self):
        self.stopped.set()
        self.wake.set()
