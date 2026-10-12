// Расширение «выгрузка из Weblate»: weblate.js на подменённом Weblate (API отвечает тестовыми данными).
const path = require('path');
const { test, expect } = require('@playwright/test');

const W = 'https://weblate.test';
const page1 = (results, next) => ({ count: results.length, next, results });
const UNITS = {
  web: [
    { context: 'cart.title', source: ['Корзина'], target: ['Себет'], state: 20, note: 'Заголовок', location: 'cart.js:10' },
    { context: 'cart.empty', source: ['Корзина пуста'], target: [''], state: 0 },
    { context: 'cart.fuzzy', source: ['Оплатить'], target: ['Төлеу'], state: 10 },
    { context: 'items', source: ['{n} товар', '{n} товара'], target: ['{n} тауар', '{n} тауар'], state: 30 },
    { context: '', source: ['Скажите "да"\nи всё'], target: ['"Иә" деңіз\nболды'], state: 100 },
  ],
  'apps/mobile': [{ context: 'cart.title', source: ['Корзина'], target: ['Себетім'], state: 20 }],
};
function api(url) {
  const u = new URL(url), p = decodeURIComponent(u.pathname);
  if (p === '/api/') return { projects: W + '/api/projects/' };
  if (p === '/api/projects/shop/') return { slug: 'shop', name: 'Магазин' };
  if (p === '/api/components/shop/web/') return { slug: 'web', name: 'Сайт' };
  if (p === '/api/projects/shop/components/') return page1([{ slug: 'web', name: 'Сайт' }, { slug: 'mobile', name: 'Приложение', category: W + '/api/categories/7/' }, { slug: 'glossary', name: 'Глоссарий', is_glossary: true }]);
  if (p === '/api/categories/7/') return { slug: 'apps', name: 'Apps' };
  if (p === '/api/projects/shop/languages/') return [{ code: 'kk', name: 'Казахский', translated_percent: 80 }, { code: 'uz', name: 'Узбекский', translated_percent: 10 }];
  const m = p.match(/^\/api\/translations\/shop\/(.+)\/(kk|uz)\/(units\/)?$/);
  if (m && m[2] === 'uz' && m[1] !== 'web') return null;
  if (m && !m[3]) return { language: { code: m[2], plural: { number: 2, formula: 'n != 1' } } };
  if (m) {
    const all = m[2] === 'kk' ? UNITS[m[1]] : [];
    // постранично, «next» — с http://, как бывает за прокси
    const page = +(u.searchParams.get('page') || 1), size = 3;
    const next = all.length > page * size ? 'http://weblate.test' + u.pathname + '?page=' + (page + 1) + '&page_size=' + size : null;
    return { count: all.length, next, results: all.slice((page - 1) * size, page * size) };
  }
  return null;
}

test('выгрузка из Weblate: язык, компоненты, только переведённые, множественное число', async ({ page }) => {
  const seen = [];
  await page.route(W + '/**', async route => {
    const url = route.request().url();
    if (!url.includes('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Weblate</title><body></body>' });
    seen.push(url);
    const body = api(url);
    return route.fulfill(body ? { contentType: 'application/json', body: JSON.stringify(body) } : { status: 404, body: '{}' });
  });
  await page.goto(W + '/projects/shop/web/kk/');
  await page.addScriptTag({ path: path.join(__dirname, '..', 'extension-weblate', 'weblate.js') });

  const info = await page.evaluate(() => self.lqaWeblate.detect(location.href));
  expect(info.project).toEqual({ slug: 'shop', name: 'Магазин' });
  expect(info.component).toEqual({ slug: 'web', name: 'Сайт' });
  expect(info.language).toBe('kk');
  expect(info.components).toEqual([{ slug: 'web', name: 'Сайт' }, { slug: 'apps/mobile', name: 'apps / Приложение' }]);   // глоссарий не выгружаем
  expect(info.languages.map(l => l.code)).toEqual(['kk', 'uz']);

  const one = await page.evaluate(() => self.lqaWeblate.exportPo({ href: location.href, project: 'shop', components: ['web'], languages: ['kk'], strings: 'translated', download: false }));
  const po = one.files[0].text;
  expect(one.files[0].name).toBe('shop_web_kk.po');
  expect(one.total).toBe(3);
  expect(po).toContain('"Language: kk\\n"');
  expect(po).toContain('"Plural-Forms: nplurals=2; plural=(n != 1);\\n"');
  expect(po).toContain('#. Заголовок\n#: cart.js:10\nmsgctxt "cart.title"\nmsgid "Корзина"\nmsgstr "Себет"');
  expect(po).toContain('msgid "{n} товар"\nmsgid_plural "{n} товара"\nmsgstr[0] "{n} тауар"\nmsgstr[1] "{n} тауар"');
  expect(po).toContain('msgid "Скажите \\"да\\"\\nи всё"\nmsgstr "\\"Иә\\" деңіз\\nболды"');   // «только для чтения» с текстом — тоже перевод
  expect(po).not.toContain('Корзина пуста');
  expect(po).not.toContain('Оплатить');
  expect(seen.some(u => u.includes('q=state%3A%3E%3Dtranslated'))).toBe(true);
  expect(seen.every(u => u.startsWith(W))).toBe(true);                                  // «next» с http:// не уводит на другой адрес

  // все компоненты, два языка, «требуют правки» как fuzzy, один файл на язык
  const many = await page.evaluate(() => self.lqaWeblate.exportPo({ href: location.href, project: 'shop', components: 'all', languages: ['kk', 'uz'], strings: 'fuzzy', download: false }));
  expect(many.files.map(f => f.name)).toEqual(['shop_kk.po', 'shop_uz.po']);
  expect(many.skipped).toEqual(['uz: apps/mobile']);
  const kk = many.files[0].text;
  expect(kk).toContain('#, fuzzy\nmsgctxt "cart.fuzzy"');
  expect(kk).toContain('msgctxt "apps/mobile/cart.title"\nmsgid "Корзина"\nmsgstr "Себетім"');   // одинаковая строка из другого компонента
  expect(seen.some(u => u.includes('/api/translations/shop/apps%2Fmobile/kk/units/'))).toBe(true);

  // отдельный файл на компонент
  const split = await page.evaluate(() => self.lqaWeblate.exportPo({ href: location.href, project: 'shop', components: ['web', 'apps/mobile'], languages: ['kk'], strings: 'translated', split: true, download: false }));
  expect(split.files.map(f => f.name)).toEqual(['shop_web_kk.po', 'shop_apps_mobile_kk.po']);
});

test('выгрузка из Weblate: не Weblate и нет доступа', async ({ page }) => {
  await page.route('https://other.test/**', route => route.request().url().includes('/api/') ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto('https://other.test/projects/x/');
  await page.addScriptTag({ path: path.join(__dirname, '..', 'extension-weblate', 'weblate.js') });
  expect(await page.evaluate(() => self.lqaWeblate.detect(location.href))).toEqual({ weblate: false });

  await page.route(W + '/**', route => route.request().url().includes('/api/') ? route.fulfill({ status: 403, body: '{}' }) : route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto(W + '/projects/shop/');
  await page.addScriptTag({ path: path.join(__dirname, '..', 'extension-weblate', 'weblate.js') });
  const err = await page.evaluate(() => self.lqaWeblate.detect(location.href).catch(e => e.message));
  expect(err).toContain('API-ключ');
});

test('окошко расширения: находит проект, даёт выбрать и выгружает', async ({ page }) => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'extension-weblate');
  await page.route(W + '/**', async route => {
    const url = route.request().url();
    if (url.includes('/ext/')) { const f = url.split('/ext/')[1]; return route.fulfill({ contentType: f.endsWith('.html') ? 'text/html' : 'text/javascript', body: fs.readFileSync(path.join(dir, f), 'utf8') }); }
    const body = api(url);
    return route.fulfill(body ? { contentType: 'application/json', body: JSON.stringify(body) } : { status: 404, body: '{}' });
  });
  // окошко открыто «на вкладке» с компонентом web, chrome.* — заглушки, скрипты выполняются тут же
  await page.addInitScript(W2 => {
    const store = {}; const listeners = [];
    window.__downloads = [];
    window.chrome = {
      tabs: { query: async () => [{ id: 1, url: W2 + '/projects/shop/web/kk/' }] },
      storage: { local: { get: async k => ({ [k]: store[k] }), set: async o => Object.assign(store, o) } },
      runtime: { onMessage: { addListener: f => listeners.push(f) }, sendMessage: m => listeners.forEach(f => f(m)) },
      scripting: { executeScript: async ({ func, args, files }) => {
        if (files) { if (!self.lqaWeblate) await new Promise(r => { const s = document.createElement('script'); s.src = 'weblate.js'; s.onload = r; document.head.append(s); }); return [{}]; }
        return [{ result: await func(...args) }];
      } },
    };
    URL.createObjectURL = b => { window.__downloads.push(b); return 'blob:x'; };
  }, W);
  await page.goto(W + '/ext/popup.html');
  await expect(page.locator('#where')).toHaveText('Магазин · Сайт · kk');
  await expect(page.locator('#langs input:checked')).toHaveCount(1);
  await expect(page.locator('#comps input:checked')).toHaveCount(1);
  await page.click('#compAll');
  await page.click('#go');
  await expect(page.locator('#msg')).toContainText('Готово: 4 строк → shop_kk.po (4)');
  expect(await page.evaluate(() => window.__downloads.length)).toBe(1);
});
