"""Offline SDK -> stdio MCP -> isolated socket fixture -> real output files.

Run with the installed helper's Python (MCP SDK + FFmpeg required).
This deliberately does not use or restart a real browser/native-host connection.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
import bridge


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


async def main():
    artifacts = ROOT / 'artifacts' / 'custom-output'
    artifacts.mkdir(parents=True, exist_ok=True)
    fixture = artifacts / 'synthetic.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i',
                    'sine=frequency=500', '-t', '1', '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(fixture)], check=True)
    checksum = digest(fixture)
    # Keep outputs reviewable; fixture sockets and records are disposable.
    target = artifacts / '完整目标目录' / '素材库'
    target.mkdir(parents=True, exist_ok=True)
    jobs = []
    with tempfile.TemporaryDirectory(prefix='lmo-', dir='/tmp') as temporary:
        runtime = Path(temporary)
        staging = runtime / 'browser-downloads'
        staging.mkdir()
        connection = str(os.getpid())

        def send(message):
            payload = message['request']
            if payload['action'] == 'download':
                job_id = 'fixture-' + str(len(jobs) + 1)
                source = staging / ('default.mp4' if not jobs else 'synthetic.mp4')
                shutil.copyfile(fixture, source)
                jobs.append({'id': job_id, 'status': 'complete', 'progress': 100,
                             'path': str(source), 'type': 'file', 'bytes': source.stat().st_size})
                result = {'jobId': job_id, 'transport': 'browser'}
            elif payload['action'] == 'jobs':
                result = {'jobs': [job for job in jobs if not payload.get('jobId') or job['id'] == payload['jobId']]}
            else:
                raise AssertionError(payload)
            server.resolve({'requestId': message['requestId'], 'ok': True, 'value': result})

        with patch.object(bridge, 'runtime_dir', return_value=runtime):
            server = bridge.Bridge(send)
        try:
            bootstrap = (
                "import sys;from pathlib import Path;"
                f"sys.path.insert(0,{str(ROOT / 'native')!r});"
                f"import bridge;bridge.runtime_dir=lambda:Path({str(runtime)!r});"
                "import mcp_server;mcp_server.outputs.start();mcp_server.mcp.run(transport='stdio')"
            )
            parameters = StdioServerParameters(command=sys.executable, args=['-c', bootstrap])
            async with stdio_client(parameters) as (reader, writer):
                async with ClientSession(reader, writer) as client:
                    await client.initialize()
                    tools = await client.list_tools()
                    schema = next(t for t in tools.tools if t.name == 'download_video').inputSchema
                    assert 'output_directory' in schema['properties']
                    assert 'output_directory' not in schema['required']

                    async def call(name, args):
                        result = await client.call_tool(name, args)
                        assert not result.isError, result
                        return result.structuredContent or json.loads(result.content[0].text)

                    arguments = {'connection': connection, 'tab_id': 7,
                                 'page_url': 'https://example.com/local-fixture', 'media_id': 'fixture'}
                    default = await call('download_video', arguments)
                    assert 'output_directory' not in default
                    first = (await call('get_jobs', {'connection': connection, 'job_id': default['jobId']}))['jobs'][0]
                    assert first['path'] == str(staging / 'default.mp4')
                    assert digest(first['path']) == checksum
                    default_evidence = artifacts / 'default-saved.mp4'
                    shutil.copyfile(first['path'], default_evidence)

                    # Existing file must remain byte-for-byte unchanged.
                    occupied = target / 'synthetic.mp4'
                    if not occupied.exists():
                        occupied.write_bytes(b'pre-existing conflict fixture')
                    occupied_checksum = digest(occupied)
                    before = set(target.iterdir())
                    custom = await call('download_video', {**arguments, 'output_directory': str(target)})
                    # Saving is autonomous: no get_jobs call triggers this move.
                    for _ in range(100):
                        if set(target.iterdir()) - before and not (staging / 'synthetic.mp4').exists():
                            break
                        await asyncio.sleep(.05)
                    assert not (staging / 'synthetic.mp4').exists(), 'background worker did not finish'
                    second = None
                    for _ in range(80):
                        second = (await call('get_jobs', {'connection': connection, 'job_id': custom['jobId']}))['jobs'][0]
                        if second['status'] != 'saving':
                            break
                        await asyncio.sleep(.05)
                    assert second['status'] == 'complete', second
                    assert Path(second['path']).parent == target
                    assert Path(second['path']).name != occupied.name
                    assert digest(second['path']) == checksum
                    assert digest(occupied) == occupied_checksum
                    assert not (staging / 'synthetic.mp4').exists()
                    assert digest(staging / 'default.mp4') == checksum
                    subprocess.run(['ffmpeg', '-v', 'error', '-i', second['path'], '-f', 'null', '-'], check=True)
                    evidence = {'schema_required': schema['required'], 'directory_schema': schema['properties']['output_directory'],
                                'default_job': first, 'default_saved_evidence': str(default_evidence),
                                'custom_job': second, 'sha256': checksum,
                                'existing_conflict_sha256': occupied_checksum, 'full_decode': 'passed',
                                'autonomous_save_before_get_jobs': True, 'default_file_retained': True,
                                'scope': 'real stdio SDK + isolated socket fixture + real filesystem; no browser or public video used'}
                    (artifacts / 'result.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + '\n')
                    print(json.dumps(evidence, indent=2, ensure_ascii=False))
        finally:
            server.close()


if __name__ == '__main__':
    asyncio.run(main())
