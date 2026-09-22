const seen = new Set();
function scan() {
  const pending = [];
  for (const el of document.querySelectorAll('video, audio, video source, audio source')) {
    const url = el.currentSrc || el.src;
    if (!url || !/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    pending.push(chrome.runtime.sendMessage({target:'background', type:'discovered', url, title:document.title, page:location.href,poster:el.poster||el.parentElement?.poster,duration:Number.isFinite(el.duration)?el.duration:undefined}).catch(()=>{}));
  }
  return Promise.all(pending);
}
scan();
document.addEventListener('loadedmetadata',scan,true);
let timer;
new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(scan,400);}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});
chrome.runtime.onMessage.addListener((m,sender,respond)=>{if(m.type==='scan'){seen.clear();scan().then(()=>respond({ok:true}));return true;}});
