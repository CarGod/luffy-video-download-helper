#!/usr/bin/env python3
"""Luffy native messaging host. No listening network port, no shell command input."""
import json, os, re, signal, struct, subprocess, sys, threading, uuid, shutil, tempfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
OUTPUT = Path.home() / 'Downloads' / 'Luffy'
WRITE_LOCK = threading.Lock()
JOBS = {}
JOB_LOCK = threading.Lock()


def send(message):
    data = json.dumps(message, ensure_ascii=False).encode('utf-8')
    with WRITE_LOCK:
        sys.stdout.buffer.write(struct.pack('<I', len(data)) + data)
        sys.stdout.buffer.flush()


def validate_url(value):
    if not isinstance(value, str) or len(value) > 16384:
        raise ValueError('无效的视频链接')
    u = urlparse(value)
    if u.scheme not in ('https', 'http') or not u.hostname or u.username or u.password:
        raise ValueError('仅支持 HTTP/HTTPS 视频链接')
    # The helper also accepts generic HLS, but cannot access local/private networks.
    import ipaddress
    host = u.hostname.lower()
    if host in ('localhost',) or host.endswith(('.local', '.localhost')):
        raise ValueError('本机助手不接受本地网络地址')
    try:
        if not ipaddress.ip_address(host).is_global:
            raise ValueError('本机助手不接受私有网络地址')
    except ValueError as e:
        if '私有' in str(e):
            raise
    return value


def args_for(message, output=OUTPUT):
    url = validate_url(message.get('url'))
    quality = str(message.get('quality', 'best'))
    if quality != 'best' and not (quality.isascii() and quality.isdigit() and 1 <= int(quality) <= 16384):
        raise ValueError('无效的画质选择')
    cookies = message.get('cookies', 'none')
    if cookies not in ('none', 'chrome', 'edge', 'firefox'):
        raise ValueError('无效的浏览器登录来源')
    limit = '' if quality == 'best' else '[height<=%s]' % quality
    args = [sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--no-colors', '--newline',
            '--no-warnings', '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3',
            '--js-runtimes', 'node:' + (shutil.which('node') or '/usr/local/bin/node'),
            '--no-overwrites', '--restrict-filenames', '--windows-filenames',
            '--format', 'bv*%s+ba/b%s' % (limit, limit), '--merge-output-format', 'mp4/mkv',
            '--paths', str(output), '--output', '%(title).120B [%(id)s].%(ext)s',
            '--progress-template', 'download:LUFFY_PROGRESS:%(progress)j',
            '--print', 'before_dl:LUFFY_META:%(title)j',
            '--print', 'after_move:LUFFY_FILE:%(filepath)j', '--no-simulate',
            '--match-filter', '!is_live']
    if cookies != 'none':
        args.extend(['--cookies-from-browser', cookies])
    args.extend(['--', url])
    return args


def terminate(job):
    job['cancelled'] = True
    process = job.get('process')
    if process and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def output_format(message):
    fmt=message.get('format', 'mp4')
    if fmt not in ('mp4', 'mkv', 'original'):
        raise ValueError('无效的输出格式')
    return fmt


def convert_file(source, fmt, job, ident, work):
    source=Path(source)
    if fmt == 'original':
        return source
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(source)], timeout=30))
    streams=probe.get('streams',[])
    videos=[x for x in streams if x.get('codec_type')=='video']
    audios=[x for x in streams if x.get('codec_type')=='audio']
    if not videos:
        raise ValueError('没有找到视频轨道')
    video_copy=all(x.get('codec_name')=='h264' and x.get('pix_fmt')=='yuv420p' for x in videos)
    audio_copy=all(x.get('codec_name')=='aac' for x in audios)
    if fmt=='mp4' and source.suffix.lower()=='.mp4' and video_copy and audio_copy:
        return source
    output=Path(work)/('converted.'+fmt)
    args=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-i',str(source),'-map','0:v:0','-map','0:a:0?']
    if fmt=='mkv':
        args += ['-c','copy']
    else:
        args += ['-c:v','copy'] if video_copy else ['-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p']
        args += ['-c:a','copy'] if audio_copy else ['-c:a','aac','-b:a','192k']
        args += ['-movflags','+faststart']
    args += ['-progress','pipe:1','-nostats',str(output)]
    duration=float(probe.get('format',{}).get('duration') or 0)
    send({'event':'job','id':ident,'patch':{'status':'converting','progress':0,'detail':'转换为兼容 MP4（H.264 / AAC）' if fmt=='mp4' else '无损封装为 MKV'}})
    with tempfile.TemporaryFile(mode='w+') as errors:
        process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=errors,text=True,start_new_session=True)
        job['process']=process
        if job['cancelled']: terminate(job)
        for line in process.stdout:
            if line.startswith('out_time_us=') and duration:
                try: progress=min(99,round(int(line.strip().split('=')[1])/1e6/duration*100))
                except ValueError: continue
                send({'event':'job','id':ident,'patch':{'status':'converting','progress':progress}})
        code=process.wait()
        process.stdout.close()
        if job['cancelled']: raise RuntimeError('已取消')
        if code: errors.seek(0);raise RuntimeError('格式转换失败：'+errors.read()[-800:])
    if not output.is_file() or output.stat().st_size<100:raise RuntimeError('格式转换未生成有效文件')
    return output


def publish_file(source, name):
    dest=OUTPUT/name
    # Reserve destination atomically so concurrent jobs never overwrite a file.
    i=1
    while True:
        try:
            fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644);os.close(fd);break
        except FileExistsError:
            dest=OUTPUT/(Path(name).stem+f' ({i})'+Path(name).suffix);i+=1
    try: shutil.move(str(source),str(dest))
    except Exception: dest.unlink(missing_ok=True);raise
    return dest


def preview_metadata(message):
    url=validate_url(message.get('url'))
    args_for(message) # Validate the explicit cookie choice too.
    args=[sys.executable,'-m','yt_dlp','--ignore-config','--no-playlist','--skip-download','--dump-single-json','--no-warnings','--socket-timeout','15','--retries','1','--js-runtimes','node:'+(shutil.which('node') or '/usr/local/bin/node')]
    if message.get('cookies','none')!='none':args+=['--cookies-from-browser',message['cookies']]
    args+=['--',url]
    result=subprocess.run(args,capture_output=True,text=True,timeout=70)
    if result.returncode:raise ValueError(result.stderr[-1000:] or '无法解析预览')
    data=json.loads(result.stdout)
    if data.get('_type') in ('playlist','multi_video'):raise ValueError('请使用单个视频链接预览')
    formats=[f for f in data.get('formats',[]) if f.get('url','').startswith(('http://','https://')) and f.get('vcodec') != 'none' and (f.get('height') or f.get('vcodec')) and not f.get('has_drm') and f.get('ext') in ('mp4','webm')]
    formats.sort(key=lambda f:(f.get('acodec')=='none' and not f.get('manifest_url'),(f.get('height') or 0)>720, not str(f.get('vcodec','')).startswith(('avc','h264')), abs((f.get('height') or 360)-480)))
    selected=formats[0] if formats else None
    headers={k.lower():v for k,v in (selected or {}).get('http_headers',data.get('http_headers',{})).items() if k.lower() in ('referer','origin','authorization')}
    return {'qualities':sorted({int(f['height']) for f in formats if isinstance(f.get('height'),(int,float)) and 1 <= f['height'] <= 16384},reverse=True),'title':data.get('title','视频预览')[:300],'duration':data.get('duration'),'poster':data.get('thumbnail'),'url':(selected.get('manifest_url') if selected.get('acodec')=='none' and 'm3u8' in selected.get('protocol','') else selected.get('url')) if selected else None,'type':'hls' if selected and 'm3u8' in selected.get('protocol','') else 'file','headers':headers,'page':url}


def download(message, job):
    ident = message['jobId']
    last_error = ''
    saved = []
    work=None
    try:
        fmt=output_format(message)
        OUTPUT.mkdir(parents=True, exist_ok=True)
        work=Path(tempfile.mkdtemp(prefix='.luffy-',dir=OUTPUT))
        args = args_for(message,work)
        OUTPUT.mkdir(parents=True, exist_ok=True)
        if job['cancelled']:
            return
        send({'event': 'job', 'id': ident, 'patch': {'status': 'preparing', 'detail': '解析网站视频'}})
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                   encoding='utf-8', errors='replace', start_new_session=True)
        job['process'] = process
        if job['cancelled']:
            terminate(job)
        for line in process.stdout:
            if line.startswith('LUFFY_PROGRESS:'):
                try:
                    p = json.loads(line.split(':', 1)[1])
                    size = p.get('downloaded_bytes') or 0
                    total = p.get('total_bytes') or p.get('total_bytes_estimate') or 0
                    send({'event': 'job', 'id': ident, 'patch': {'status': 'downloading', 'bytes': size,
                         'progress': min(98, round(size / total * 100)) if total else 0,
                         'detail': '本机助手下载中 · 音视频可能分轨下载'}})
                except (ValueError, TypeError):
                    pass
            elif line.startswith('LUFFY_META:'):
                title = json.loads(line.split(':', 1)[1])
                if isinstance(title, str):
                    send({'event':'job','id':ident,'patch':{'title':title[:300]}})
            elif line.startswith('LUFFY_FILE:'):
                path = Path(json.loads(line.split(':', 1)[1])).resolve()
                if path.is_relative_to(OUTPUT.resolve()) and path.is_file():
                    saved.append(str(path))
            elif line.startswith('ERROR:'):
                last_error = line.strip()[:1200]
            elif '[Merger]' in line or '[Fixup' in line:
                send({'event': 'job', 'id': ident, 'patch': {'status': 'merging', 'detail': 'FFmpeg 合并音视频'}})
        code = process.wait()
        if job['cancelled']:
            send({'event':'job','id':ident,'patch':{'status':'cancelled'}})
        elif code == 0 and saved:
            source=Path(saved[0])
            converted=convert_file(source,fmt,job,ident,work)
            if job['cancelled']:raise RuntimeError('已取消')
            name=source.stem+converted.suffix
            final=publish_file(converted,name)
            send({'event':'job','id':ident,'patch':{'status':'complete','progress':100,'path':str(final),'detail':'已保存到 Downloads/Luffy'}})
        else:
            send({'event':'job','id':ident,'patch':{'status':'error','error':last_error or '没有生成视频文件；可能为直播、不可用视频或网站需要登录'}})
    except Exception as e:
        send({'event':'job','id':ident,'patch':{'status':'cancelled' if job['cancelled'] else 'error','error':'' if job['cancelled'] else str(e)[:1200]}})
    finally:
        if work:shutil.rmtree(work,ignore_errors=True)
        with JOB_LOCK:
            JOBS.pop(ident, None)


def convert_existing(message,job):
    ident=message['jobId'];work=None
    try:
        source=Path(message['path']).resolve()
        if not source.is_relative_to(OUTPUT.resolve()) or not source.is_file():raise ValueError('文件不属于 Luffy 下载目录')
        work=Path(tempfile.mkdtemp(prefix='.luffy-convert-',dir=OUTPUT))
        converted=convert_file(source,'mp4',job,ident,work)
        if job['cancelled']:raise RuntimeError('已取消')
        final=source if converted==source else publish_file(converted,source.stem+'.mp4')
        send({'event':'job','id':ident,'patch':{'status':'complete','progress':100,'path':str(final),'detail':'MP4 转换完成，原文件已保留'}})
    except Exception as e:
        send({'event':'job','id':ident,'patch':{'status':'cancelled' if job['cancelled'] else 'error','error':'' if job['cancelled'] else str(e)}})
    finally:
        if work:shutil.rmtree(work,ignore_errors=True)
        with JOB_LOCK:JOBS.pop(ident,None)


def handle(message):
    request_id = message.get('requestId')
    try:
        action = message.get('type')
        if action == 'status':
            import yt_dlp.version
            result = {'version':yt_dlp.version.__version__, 'ffmpeg':bool(shutil.which('ffmpeg')), 'output':str(OUTPUT)}
        elif action == 'preview':
            result=preview_metadata(message)
        elif action in ('start','convert'):
            if action=='start':
                args_for(message)
                output_format(message)
            ident = message.get('jobId')
            if not isinstance(ident, str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,80}', ident):
                raise ValueError('无效的任务编号')
            with JOB_LOCK:
                if len(JOBS) >= 2 or ident in JOBS:
                    raise ValueError('本机助手最多同时下载两个任务')
                job = {'cancelled':False}
                JOBS[ident] = job
            threading.Thread(target=download if action=='start' else convert_existing, args=(message, job), daemon=True).start()
            result = True
        elif action == 'cancel':
            with JOB_LOCK:
                job = JOBS.get(message.get('jobId'))
            if job:
                terminate(job)
            result = True
        elif action == 'show':
            path = Path(message.get('path', '')).resolve()
            if not path.is_relative_to(OUTPUT.resolve()) or not path.is_file():
                raise ValueError('文件不存在或不属于 Luffy 下载目录')
            subprocess.Popen(['/usr/bin/open', '-R', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result = True
        else:
            raise ValueError('未知操作')
        send({'requestId':request_id, 'ok':True, 'value':result})
    except Exception as e:
        send({'requestId':request_id, 'ok':False, 'error':str(e)})


PREVIEW_LOCK=threading.Lock()
def preview_request(message):
    try:handle(message)
    finally:PREVIEW_LOCK.release()

def main():
    from bridge import Bridge
    bridge = None
    try:
        while True:
            header = sys.stdin.buffer.read(4)
            if not header:
                break
            if len(header) != 4:
                break
            length = struct.unpack('<I', header)[0]
            if length > 1024 * 1024:
                break
            raw = sys.stdin.buffer.read(length)
            if len(raw) != length:
                break
            message=json.loads(raw)
            if message.get('type') in ('mcpStatus', 'mcpControl'):
                try:
                    if message['type'] == 'mcpControl':
                        if not isinstance(message.get('enabled'), bool):
                            raise ValueError('无效的 MCP 开关')
                        if message['enabled'] and bridge is None:
                            bridge = Bridge(send)
                        elif not message['enabled'] and bridge is not None:
                            bridge.close()
                            bridge = None
                    launcher = ROOT / 'launch-mcp.sh'
                    if not launcher.is_file():
                        raise ValueError('请更新本机助手以安装 MCP 服务')
                    result = {'running': bridge is not None, 'config': {'mcpServers': {'luffy-video': {'command': str(launcher)}}}}
                    send({'requestId': message.get('requestId'), 'ok': True, 'value': result})
                except Exception as e:
                    send({'requestId': message.get('requestId'), 'ok': False, 'error': str(e)})
                continue
            if message.get('type') == 'mcpResponse':
                if bridge: bridge.resolve(message)
                continue
            if message.get('type')=='preview':
                if not PREVIEW_LOCK.acquire(blocking=False):send({'requestId':message.get('requestId'),'ok':False,'error':'已有预览正在解析，请稍后重试'})
                else:threading.Thread(target=preview_request,args=(message,),daemon=True).start()
            else:handle(message)
    finally:
        if bridge: bridge.close()
        for job in list(JOBS.values()):
            terminate(job)


if __name__ == '__main__':
    main()
