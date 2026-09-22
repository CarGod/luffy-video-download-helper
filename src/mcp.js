import { videoList } from './list-model.js';

// Explicit allowlist: MCP never gets the extension's internal engine operations.
export function createMcpHandler({ chrome, rpc }) {
  async function page(tabId) {
    const tab = tabId == null
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      : await chrome.tabs.get(tabId);
    if (!tab || tab.incognito || !/^https?:\/\//.test(tab.url || ''))
      throw Error('请在浏览器中打开普通网页并切换到目标视频页面');
    return tab;
  }
  return async function handleMcp(m) {
    if (m.action === 'connection') {
      const tabs = await chrome.tabs.query({ active: true });
      return { browser: navigator.userAgent, activeTabs: tabs.filter(t => !t.incognito && /^https?:/.test(t.url || '')).map(t => ({ tabId:t.id, title:t.title, url:t.url, windowId:t.windowId })) };
    }
    if (m.action === 'jobs' || m.action === 'cancel') {
      const { jobs } = await rpc({type:'state'});
      const job = m.jobId ? jobs.find(j => j.id === m.jobId) : null;
      if (m.jobId && !job) throw Error('任务不存在或浏览器会话已结束');
      if (m.action === 'cancel') {
        if (!job) throw Error('需要 jobId');
        await rpc({type:'cancel', id:job.id});
        return { jobId:job.id, status:(await rpc({type:'state'})).jobs.find(j=>j.id===job.id)?.status };
      }
      // Do not expose private request headers, blob URLs or temporary rule IDs.
      return { jobs:await Promise.all((job ? [job] : jobs).map(async ({id,title,status,progress,bytes,error,path,filename,type,downloadId}) => {
        if (downloadId != null) {const [saved] = await chrome.downloads.search({id:downloadId});path ||= saved?.filename;}
        return {id,title,status,progress,bytes,error,path,filename,type};
      })) };
    }
    if (!['list','inspect','download'].includes(m.action)) throw Error('未知 MCP 操作');
    const tab = await page(m.tabId);
    if (m.action !== 'list' && (!m.pageUrl || tab.url !== m.pageUrl))
      throw Error('页面已切换，请重新调用 list_videos');
    if (m.action === 'list') await rpc({type:'scan', tabId:tab.id});
    const { media } = await rpc({type:'state', tabId:tab.id});
    const videos = videoList(media, tab);
    if (m.action === 'list') return {tabId:tab.id, page_url:tab.url, title:tab.title, videos};
    const selected = m.mediaId ? videos.find(v => v.id === m.mediaId) : videos.length === 1 ? videos[0] : null;
    if (!selected) throw Error('请从 list_videos 的结果中指定有效 media_id；页面可能包含多个视频');
    if (m.action === 'inspect') {
      if (selected.type !== 'hls') throw Error('仅 HLS 视频需要检查清晰度和音轨');
      return rpc({type:'inspect',mediaId:selected.id});
    }
    for (const key of ['variantIndex','audioIndex']) if (m[key] != null && (!Number.isInteger(m[key]) || m[key] < 0)) throw Error('无效的清晰度或音轨索引');
    // Re-check after asynchronous reads, just before starting a side effect.
    if ((await page(tab.id)).url !== m.pageUrl) throw Error('页面已切换，请重新调用 list_videos');
    const native = ['page','dash'].includes(selected.type);
    const id = await rpc(native ? {type:'nativeStart',url:selected.url,title:selected.title,quality:m.quality||'best',format:m.format||'mp4',cookies:m.cookies||'none'}
      : {type:'start',mediaId:selected.id,variantIndex:m.variantIndex??undefined,audioIndex:m.audioIndex??undefined});
    return {jobId:id, transport:native?'native':'browser', note:'已提交下载，请用 get_jobs 查询完成状态'};
  };
}
