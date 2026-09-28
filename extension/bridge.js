// Мост между страницей LQA Hub и расширением. Работает только на сайте LQA Hub (см. manifest.json):
// страница просит обойти список ссылок, расширение присылает прогресс и готовые скриншоты.
const VERSION = chrome.runtime.getManifest().version;
let port = null;

function announce() { window.postMessage({ lqaExt: 'ready', version: VERSION }, window.location.origin); }
document.documentElement.dataset.lqaExtension = VERSION;
announce();

window.addEventListener('message', e => {
  if (e.source !== window || !e.data || typeof e.data.lqaHub !== 'string') return;
  const m = e.data;
  if (m.lqaHub === 'ping') return announce();
  if (m.lqaHub === 'stop') { if (port) port.postMessage({ type: 'stop' }); return; }
  if (m.lqaHub !== 'crawl') return;
  if (port) { try { port.disconnect(); } catch (err) {} }
  port = chrome.runtime.connect({ name: 'lqa-crawl' });
  port.onMessage.addListener(msg => window.postMessage(Object.assign({ lqaExt: msg.type }, msg), window.location.origin));
  port.onDisconnect.addListener(() => { port = null; });
  port.postMessage({ type: 'crawl', job: m.job });
});
