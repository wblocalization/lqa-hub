// Робот обхода страниц. Открывает каждую ссылку в отдельном окне, через протокол отладки Chrome
// изображает компьютер или телефон, прокручивает страницу (чтобы подгрузились картинки и блоки),
// ждёт, пока пройдёт проверка «вы не робот», и снимает страницу целиком.

const ALLOWED_HOSTS = [
  /(^|\.)wildberries\.(ru|kz|uz|am|ge|kg|by|tj|az)$/, /(^|\.)wb\.ru$/, /(^|\.)rwb\.ru$/,
  /^localhost$/, /^127\.0\.0\.1$/,
];
const VIEWPORTS = {
  desktop: { label: 'компьютер', width: 1440, height: 900, dpr: 1, mobile: false },
  mobile: { label: 'телефон', width: 390, height: 844, dpr: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
};
const CHALLENGE_RE = /Подозрительная активность|Почти готово|Проверяем браузер|captcha/i;
const MAX_SHOT_HEIGHT = 7800;   // LQA Hub хранит скриншоты до 8000 px в высоту

const sleep = ms => new Promise(r => setTimeout(r, ms));
function allowed(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) && ALLOWED_HOSTS.some(re => re.test(u.hostname)); }
  catch (e) { return false; }
}
function waitEvent(tabId, method, timeout) {
  return new Promise(resolve => {
    const t = setTimeout(() => { chrome.debugger.onEvent.removeListener(on); resolve(false); }, timeout);
    function on(src, m) { if (src.tabId === tabId && m === method) { clearTimeout(t); chrome.debugger.onEvent.removeListener(on); resolve(true); } }
    chrome.debugger.onEvent.addListener(on);
  });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'lqa-crawl') return;
  const state = { stop: false };
  port.onDisconnect.addListener(() => { state.stop = true; });
  port.onMessage.addListener(msg => {
    if (msg.type === 'stop') state.stop = true;
    if (msg.type === 'crawl') crawl(msg.job, port, state).catch(err => safePost(port, { type: 'error', message: String(err && err.message || err) }));
  });
});
function safePost(port, msg) { try { port.postMessage(msg); } catch (e) {} }

async function crawl(job, port, state) {
  const pages = (job.pages || []).filter(p => p && p.url);
  const vps = (job.viewports || ['desktop']).filter(v => VIEWPORTS[v]);
  const screens = Math.max(1, Math.min(8, +job.screens || 3));
  const total = pages.length * vps.length;
  const bad = pages.filter(p => !allowed(p.url));
  if (bad.length) { safePost(port, { type: 'error', message: 'Расширение снимает только сайты Wildberries. Не подходит: ' + bad.map(p => p.url).join(', ') }); return; }
  if (!total) { safePost(port, { type: 'error', message: 'Список страниц пуст' }); return; }

  const win = await chrome.windows.create({ url: 'about:blank', focused: true, width: 1200, height: 900 });
  const tabId = win.tabs[0].id;
  const target = { tabId };
  let done = 0, ok = 0;
  try {
    await chrome.debugger.attach(target, '1.3');
    const send = (method, params) => chrome.debugger.sendCommand(target, method, params || {});
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });   // вкладка рисуется, даже если окно перекрыто
    for (const vpKey of vps) {
      const vp = VIEWPORTS[vpKey];
      await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile });
      await send('Emulation.setUserAgentOverride', { userAgent: vp.ua || (await send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result.value.replace(/HeadlessChrome/, 'Chrome') });
      await send('Emulation.setTouchEmulationEnabled', vp.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      for (const page of pages) {
        if (state.stop) break;
        const name = (page.name || page.url) + ' · ' + vp.label;
        safePost(port, { type: 'progress', done, total, name, stage: 'открываю' });
        try {
          const loaded = waitEvent(tabId, 'Page.loadEventFired', 45000);
          await send('Page.navigate', { url: page.url });
          await loaded;
          // проверка «вы не робот»: в обычном браузере она проходит сама за несколько секунд
          for (let i = 0; i < 45; i++) {
            const txt = (await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.slice(0, 2000) : ""', returnByValue: true })).result.value || '';
            if (!CHALLENGE_RE.test(txt) && txt.trim().length > 40) break;
            if (i === 0) safePost(port, { type: 'progress', done, total, name, stage: 'жду проверку сайта' });
            await sleep(2000);
          }
          await sleep(2000);
          safePost(port, { type: 'progress', done, total, name, stage: 'прокручиваю' });
          const h = (await send('Runtime.evaluate', {
            expression: `(async () => { const H = innerHeight, max = ${screens} * H;
              for (let y = 0; y < max; y += Math.round(H * 0.8)) { scrollTo(0, y); await new Promise(r => setTimeout(r, 400)); }
              scrollTo(0, 0); await new Promise(r => setTimeout(r, 800));
              return Math.min(document.documentElement.scrollHeight, max); })()`,
            awaitPromise: true, returnByValue: true,
          })).result.value || vp.height;
          const height = Math.max(vp.height, Math.min(h, Math.floor(MAX_SHOT_HEIGHT / vp.dpr)));
          safePost(port, { type: 'progress', done, total, name, stage: 'снимаю' });
          const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88, captureBeyondViewport: true, clip: { x: 0, y: 0, width: vp.width, height, scale: 1 } });
          const title = (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value || '';
          safePost(port, { type: 'shot', name, url: page.url, viewport: vpKey, title, dataUrl: 'data:image/jpeg;base64,' + shot.data });
          ok++;
        } catch (err) {
          safePost(port, { type: 'pageError', name, url: page.url, message: String(err && err.message || err) });
        }
        done++;
      }
      if (state.stop) break;
    }
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) {}
    try { await chrome.windows.remove(win.id); } catch (e) {}
    safePost(port, { type: 'done', done, total, ok, stopped: state.stop });
  }
}
