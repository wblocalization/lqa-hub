// Доступ по списку Google-почт: backend подменяется, Google — заглушка.
const { test, expect } = require('@playwright/test');
const { openApp, expectNoErrors } = require('./helpers');

const URL = 'https://script.google.com/macros/s/test/exec';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cred = email => b64({ alg: 'none' }) + '.' + b64({ email, name: 'Test', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';

async function fakeBackend(page, { admins = ['boss@gmail.com'], allowed = ['ok@gmail.com'] } = {}) {
  const state = { allowed: [...allowed], calls: [] };
  await page.route(URL, async route => {
    const req = JSON.parse(route.request().postData() || '{}');
    state.calls.push(req);
    const email = req.idToken ? JSON.parse(Buffer.from(req.idToken.split('.')[1], 'base64').toString()).email : null;
    let body;
    if (!email) body = { error: 'Войди через Google', code: 'auth_required', auth: 'google', clientId: '123-abc.apps.googleusercontent.com' };
    else if (!admins.includes(email) && !state.allowed.includes(email)) body = { error: 'нет в списке', code: 'not_allowed', auth: 'google', email };
    else if (req.mode === 'ping') body = { ok: true, sync: true, auth: 'google', email, admin: admins.includes(email) };
    else if (req.mode === 'access') {
      if (req.action === 'set') state.allowed = req.allowed;
      body = { auth: 'google', admins, allowed: state.allowed, email, admin: admins.includes(email) };
    } else body = { ok: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  return state;
}

test('без входа — экран входа, Client ID приходит от backend', async ({ page }) => {
  const errors = await openApp(page);
  await fakeBackend(page);
  await page.evaluate(u => saveSettings({ aiEndpointUrl: u, googleClientId: '' }), URL);
  await page.evaluate(u => backendFetch(u, { method: 'POST', body: JSON.stringify({ mode: 'ping' }) }), URL);
  await expect(page.locator('#authGate')).toBeVisible();
  expect(await page.evaluate(() => getSettings().googleClientId)).toBe('123-abc.apps.googleusercontent.com');
  // чужая почта — «нет в списке»
  await page.evaluate(c => onGoogleCredential({ credential: c }), cred('stranger@gmail.com'));
  await page.evaluate(u => backendFetch(u, { method: 'POST', body: JSON.stringify({ mode: 'ping' }) }), URL);
  await expect(page.locator('#authGate')).toContainText('stranger@gmail.com');
  // одобренная почта — экран уходит
  await page.evaluate(c => { googleSignOut(); onGoogleCredential({ credential: c }); }, cred('ok@gmail.com'));
  await page.evaluate(u => backendFetch(u, { method: 'POST', body: JSON.stringify({ mode: 'ping' }) }), URL);
  await expect(page.locator('#authGate')).toHaveCount(0);
  expectNoErrors(errors);
});

test('администратор меняет список в Настройках', async ({ page }) => {
  const errors = await openApp(page);
  const state = await fakeBackend(page);
  await page.evaluate(({ u, c }) => {
    saveSettings({ aiEndpointUrl: u, googleClientId: '123-abc.apps.googleusercontent.com' });
    onGoogleCredential({ credential: c });
    setIdentity(MANAGERS[0], 'manager');
    location.hash = '#/settings';
  }, { u: URL, c: cred('boss@gmail.com') });
  await page.evaluate(() => closeDialogIfOpen());
  const ta = page.locator('#accessList');
  await expect(ta).toHaveValue('ok@gmail.com');
  await ta.fill('ok@gmail.com\nNew.One@gmail.com');
  await page.click('#accessCard button:has-text("Сохранить список")');
  await expect.poll(() => state.allowed).toEqual(['ok@gmail.com', 'new.one@gmail.com']);
  expect(state.calls.every(c => c.idToken)).toBe(true);
  expectNoErrors(errors);
});

test('старый backend по ключу: доступ открыт, в карточке инструкция', async ({ page }) => {
  const errors = await openApp(page);
  await page.route(URL, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, sync: true }) }));
  await page.evaluate(u => { saveSettings({ aiEndpointUrl: u }); setIdentity(MANAGERS[0], 'manager'); location.hash = '#/settings'; }, URL);
  await expect(page.locator('#accessCard')).toContainText('ADMIN_EMAILS');
  await expect(page.locator('#authGate')).toHaveCount(0);
  expectNoErrors(errors);
});

test('редполитика: ссылка на документ в Настройках уходит в ИИ-проверку своего языка', async ({ page }) => {
  const errors = await openApp(page);
  const sent = [];
  await page.route(URL, async route => {
    const req = JSON.parse(route.request().postData() || '{}'); sent.push(req);
    const body = req.mode === 'styleguide' ? { ok: true, chars: 42, preview: 'Обращаемся на «сіз»' } : { results: [] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.evaluate(u => { saveSettings({ aiEndpointUrl: u, aiEnabled: true }); setIdentity(MANAGERS[0], 'manager'); location.hash = '#/settings'; }, URL);
  await page.click('#styleGuidesCard button:has-text("Добавить редполитику")');
  await page.selectOption('#sgLang', 'kk');
  await page.fill('#sgValue', 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit');
  await page.click('.dialog [data-ok]');
  await expect(page.locator('#styleGuidesCard .sg-status[data-lang=kk]')).toContainText('42 символа');
  await expect(page.locator('#styleGuidesCard')).toContainText('Google Документ');
  await page.evaluate(() => callAiEndpoint([{ id: 'r1', language: 'kk', source: 'a', target: 'b' }, { id: 'r2', language: 'uz', source: 'a', target: 'c' }]));
  const ai = sent.find(r => r.items);
  expect(Object.keys(ai.styleGuides)).toEqual(['kk']);
  expectNoErrors(errors);
});
