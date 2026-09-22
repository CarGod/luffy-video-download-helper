export function loadingState(label='正在加载清晰度', detail='准备可用画质，请稍候') {
 const root=document.createElement('div');root.className='media-loading';root.setAttribute('role','status');root.setAttribute('aria-live','polite');root.setAttribute('aria-busy','true');
 const heading=document.createElement('div');heading.className='media-loading-heading';heading.textContent=label;
 const hint=document.createElement('span');hint.className='media-loading-hint';hint.textContent=detail;
 const track=document.createElement('div');track.className='media-loading-track';track.setAttribute('role','progressbar');track.setAttribute('aria-label',label);
 track.append(document.createElement('span'));root.append(heading,hint,track);return root;
}
export const connectionError=error=>/Receiving end does not exist|Could not establish connection|message port closed|message channel closed|后台连接中断|媒体处理引擎无响应/i.test(error?.message||'');
export async function retryConnection(operation,{attempts=3,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 for(let attempt=0;attempt<attempts;attempt++){
  try{return await operation();}catch(error){if(!connectionError(error)||attempt===attempts-1)throw error;await wait(250*(attempt+1));}
 }
}
