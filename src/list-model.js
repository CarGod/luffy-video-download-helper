export function pageVideo(tab){
 try{
  const u=new URL(tab?.url);let valid=false;
  if(['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname))valid=(u.pathname==='/watch'&&!!u.searchParams.get('v'))||/^\/(shorts|live)\/[\w-]+/.test(u.pathname);
  else if(u.hostname==='youtu.be')valid=/^\/[\w-]+$/.test(u.pathname);
  else if(['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname))valid=/^\/[^/]+\/status\/\d+/.test(u.pathname);
  if(!valid)return null;
  return {id:`page:${u.href}`,url:u.href,title:tab.title||'当前视频',type:'page'};
 }catch{return null;}
}
export function videoList(media,tab){const current=pageVideo(tab);return current?[current,...media.filter(m=>m.url!==current.url)]:media;}
