import asyncio
import json
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    async with stdio_client(StdioServerParameters(command=sys.argv[1])) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            names = {t.name for t in (await session.list_tools()).tools}
            assert names == {'list_connections','list_videos','download_video','inspect_video','get_jobs','cancel_download'}
            async def call(name, args):
                result = await session.call_tool(name, args)
                if result.isError:
                    raise RuntimeError(result.content)
                return json.loads(result.content[0].text)
            connections = (await call('list_connections', {}))['connections']
            connection = next(c['connection'] for c in connections if any(t['url'].startswith('http://127.0.0.1:18765') for t in c['activeTabs']))
            page = await call('list_videos', {'connection':connection})
            assert page['videos'], page
            media = next(v for v in page['videos'] if v['url'].endswith('.mp4'))
            args = {'connection':connection,'tab_id':page['tabId'],'page_url':page['page_url'],'media_id':media['id']}
            rejected = await session.call_tool('download_video', {**args,'page_url':'https://wrong.example'})
            assert rejected.isError
            job = await call('download_video', args)
            async def finish(job):
                for _ in range(150):
                    state = await call('get_jobs', {'connection':connection,'job_id':job['jobId']})
                    status = state['jobs'][0]['status']
                    if status == 'complete':
                        assert state['jobs'][0]['path']
                        return state['jobs'][0]
                    assert status not in ['error','cancelled'],state
                    await asyncio.sleep(.2)
                raise TimeoutError(state)
            direct = await finish(job)
            hls = next(v for v in page['videos'] if '/plain/' in v['url'])
            hls_args = {**args, 'media_id':hls['id']}
            info = await call('inspect_video', hls_args)
            assert info
            merged = await finish(await call('download_video', hls_args))
            slow = next(v for v in page['videos'] if '/slow/' in v['url'])
            slow_job = await call('download_video', {**args,'media_id':slow['id']})
            cancelled = await call('cancel_download', {'connection':connection,'job_id':slow_job['jobId']})
            assert cancelled['status'] == 'cancelled'
            print(json.dumps({'connection':connection,'tools':sorted(names),'direct':direct,'hls':merged,'cancelled':True,'stalePageRejected':True}))

asyncio.run(main())
