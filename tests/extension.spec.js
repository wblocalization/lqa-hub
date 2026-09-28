// Расширение Chrome для обхода страниц: грузится в настоящий Chromium, обходит имитацию сайта
// (длинная страница и страница с проверкой «вы не робот») и складывает скриншоты в сессию.
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { test, expect, chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
let appServer, siteServer, appUrl, siteUrl;

test.beforeAll(async () => {
  // LQA Hub по http://localhost (расширение работает только на сайте платформы, не в файле с диска)
  appServer = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    fs.readFile(p, (e, d) => { if (e) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); res.end(d); });
  });
  // «сайт WB» на 127.0.0.1
  const page = (t, b) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${t}</title><style>body{font:18px Arial;margin:0;padding:20px}.card{height:420px;border:1px solid #ccc;margin:10px 0}</style></head><body>${b}</body></html>`;
  siteServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // сайт с переключателем языка: язык хранится в cookie lang или в localStorage
    if (req.url.startsWith('/lang')) return res.end(page('lang', `<div id=out></div><button id=ru onclick="document.cookie='lang=ru;path=/';location.reload()">Русский</button> <nav><span onclick="document.cookie='lang=kk;path=/';location.reload()">Қазақша</span></nav>
      <script>const c=(document.cookie.match(/lang=(\\w+)/)||[])[1], s=localStorage.getItem('lang'); const l=c||s||'ru'; document.title='язык '+l; document.getElementById('out').textContent=l==='kk'?'Басты бет':l==='uz'?'Bosh sahifa':'Главная';</script>`));
    if (req.url.startsWith('/challenge')) return res.end(page('...', `Подозрительная активность. Пожалуйста, подождите.<script>setTimeout(()=>{document.title='Каталог';document.body.innerHTML='<h1>Каталог товаров</h1><p>'+'Товары для дома '.repeat(20)+'</p>'},2500)</script>`));
    res.end(page('Главная', `<h1>Главная</h1><div id=w></div><script>document.getElementById('w').textContent='ширина '+innerWidth</script>` + Array.from({ length: 12 }, (_, i) => `<div class=card>Блок ${i + 1}</div>`).join('')));
  });
  await new Promise(r => appServer.listen(0, '127.0.0.1', r));
  await new Promise(r => siteServer.listen(0, '127.0.0.1', r));
  appUrl = `http://localhost:${appServer.address().port}/index.html`;
  siteUrl = `http://127.0.0.1:${siteServer.address().port}`;
});
test.afterAll(() => { appServer.close(); siteServer.close(); });

test('расширение обходит страницы на компьютере и телефоне и добавляет скриншоты в сессию', async () => {
  test.setTimeout(120_000);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lqa-ext-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1440, height: 900 },
  });
  const errors = [];
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('lqa_tour_done', '1'); } catch (e) {} });
  await page.goto(appUrl + '#/');
  await page.waitForFunction(() => typeof dbList === 'function' && document.querySelector('.side-link'));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.lqaExtension)).toBe(require('../extension/manifest.json').version);

  await page.evaluate(() => {
    dbUpsert('projects', { id: 'p0', name: 'WB', languages: [{ code: 'ru', name: 'Русский' }] });
    dbUpsert('visualSessions', { id: 's0', projectId: 'p0', name: 'Обход', languageCode: 'ru', createdAt: nowISO() });
    location.hash = '#/visual/s0';
  });
  await page.click('button:has-text("Обойти страницы")');
  await page.fill('#crPages', `Главная | ${siteUrl}/\nКаталог | ${siteUrl}/challenge`);
  await page.uncheck('#crOcr');
  await page.click('.dialog [data-ok]');

  await expect.poll(() => page.evaluate(() => dbList('visualShots').length), { timeout: 90_000 }).toBe(4);
  const shots = await page.evaluate(() => dbList('visualShots').map(s => ({ name: s.name, w: s.w, h: s.h, url: s.pageUrl, source: s.source })));
  const by = n => shots.find(s => s.name === n);
  expect(by('Главная · компьютер').w).toBe(1440);
  expect(by('Главная · компьютер').h).toBeGreaterThan(2000);          // снята целиком, со скроллом (3 экрана)
  expect(by('Главная · телефон').w).toBe(780);                        // 390 × 2 (ретина)
  expect(by('Каталог · компьютер').url).toBe(`${siteUrl}/challenge`);
  expect(shots.every(s => s.source === 'crawl')).toBe(true);
  // страница с проверкой «вы не робот» снята уже после неё
  const img = await page.evaluate(() => { const s = dbList('visualShots').find(x => x.name === 'Каталог · компьютер'); return s.id; });
  expect(img).toBeTruthy();
  expect(await page.evaluate(() => dbGet('crawlRoutes', 'p0').viewports)).toEqual(['desktop', 'mobile']);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('шаги перед снимком: нажать на переключатель языка, cookie и localStorage', async () => {
  test.setTimeout(120_000);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lqa-ext-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : { channel: 'chromium' }),
    headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1440, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('lqa_tour_done', '1'); } catch (e) {} });
  await page.goto(appUrl + '#/');
  await page.waitForFunction(() => typeof dbList === 'function' && document.querySelector('.side-link'));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.lqaExtension)).toBe(require('../extension/manifest.json').version);
  await page.evaluate(() => {
    dbUpsert('projects', { id: 'p0', name: 'WB', languages: [{ code: 'kk', name: 'Казахский' }] });
    dbUpsert('visualSessions', { id: 's0', projectId: 'p0', name: 'Языки', languageCode: 'kk', createdAt: nowISO() });
    location.hash = '#/visual/s0';
  });
  await page.click('button:has-text("Обойти страницы")');
  await page.fill('#crPages', [
    `Нажатие | ${siteUrl}/lang?a | нажать: Қазақша`,
    `Cookie | ${siteUrl}/lang?b | cookie: lang=ru`,
    `Storage | ${siteUrl}/lang?c | cookie: lang= | storage: lang=uz | ждать: 1`,
  ].join('\n'));
  await page.uncheck('#crMob'); await page.uncheck('#crOcr');
  await page.click('.dialog [data-ok]');
  await expect.poll(() => page.evaluate(() => dbList('visualShots').length), { timeout: 90_000 }).toBe(3);
  const titles = await page.evaluate(() => Object.fromEntries(dbList('visualShots').map(s => [s.name.split(' · ')[0], s.pageTitle])));
  expect(titles).toEqual({ 'Нажатие': 'язык kk', 'Cookie': 'язык ru', 'Storage': 'язык uz' });
  // неизвестный шаг не запускает обход, а объясняет формат
  await page.click('button:has-text("Обойти страницы")');
  await page.fill('#crPages', `Х | ${siteUrl}/ | прыгнуть: высоко`);
  await page.click('.dialog [data-ok]');
  await expect(page.locator('.toast').last()).toContainText('Не понял шаг');
  expect(errors).toEqual([]);
  await ctx.close();
});
