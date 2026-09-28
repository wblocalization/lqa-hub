// LQA Hub service worker: lets the installed app open without network.
// The page is served from cache immediately and refreshed in the background, so a new version
// shows up on the next launch. Requests to other origins (fonts, the AI/storage backend) are
// never cached here.
const CACHE = 'lqa-hub-v3';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './fonts/TwemojiCountryFlags.woff2'].concat(['am','ar','az','be','en','fr','he','hy','ka','kk','ko','ky','ru','sw','tg','tr','uz','zh'].map(c=>'./flags/'+c+'.svg'));

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e=>{
  const req = e.request;
  const u = new URL(req.url);
  // the extension's files are downloaded to build its zip — always take them from the network
  if(req.method!=='GET' || u.origin!==location.origin || u.pathname.includes('/extension/')) return;
  e.respondWith(caches.open(CACHE).then(async cache=>{
    const cached = await cache.match(req, {ignoreSearch:true});
    const fresh = fetch(req).then(res=>{ if(res && res.ok) cache.put(req, res.clone()); return res; }).catch(()=>cached);
    return cached || fresh;
  }));
});
