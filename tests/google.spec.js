// Вход через Google: Google Identity Services подменяется заглушкой, которая «входит» заданной почтой.
const { test, expect } = require('@playwright/test');
const { openApp, expectNoErrors } = require('./helpers');

async function fakeGoogle(page, account) {
  await page.addInitScript(acc => {
    const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const credential = () => b64({ alg: 'none' }) + '.' + b64(Object.assign({ email_verified: true }, acc)) + '.sig';
    window.__gsi = { prompted: 0, disabled: 0 };
    window.google = { accounts: { id: {
      initialize(o) { window.__gsi.options = o; },
      prompt() { window.__gsi.prompted++; },
      renderButton(el) { el.innerHTML = '<button type="button" class="fake-gsi">Войти через Google</button>'; el.querySelector('button').onclick = () => window.__gsi.options.callback({ credential: credential() }); },
      disableAutoSelect() { window.__gsi.disabled++; },
    } } };
  }, account);
}

test('первый вход: выбираешь себя один раз, дальше почта узнаётся сама', async ({ page, context }) => {
  await fakeGoogle(page, { email: 'Editor.Test@gmail.com', name: 'Someone Else' });
  const errors = await openApp(page);
  const editor = await page.evaluate(() => EDITORS[0]);
  await page.evaluate(() => { saveSettings({ googleClientId: '123-abc.apps.googleusercontent.com' }); return initGoogleSignIn(); });
  expect(await page.evaluate(() => window.__gsi.prompted)).toBe(1);        // нет имени — Google сам предлагает войти

  await page.click('#meAvatar');
  await page.click('.fake-gsi');                                            // «Войти через Google»
  await expect(page.locator('.gsi-row')).toContainText('editor.test@gmail.com');
  await page.click('[data-role=editor]');
  await page.click(`.person[data-name="${editor}"]`);
  expect(await page.evaluate(() => [getMe(), getRole()])).toEqual([editor, 'editor']);
  expect(await page.evaluate(() => getSettings().googleAccounts['editor.test@gmail.com'].name)).toBe(editor);

  // другой браузер той же команды (настройки общие): вход той же почтой сразу открывает «Мои задачи»
  const settings = await page.evaluate(() => getSettings());
  const page2 = await context.browser().newPage();
  await fakeGoogle(page2, { email: 'editor.test@gmail.com', name: 'Someone Else' });
  const errors2 = await openApp(page2);
  await page2.evaluate(s => { saveSettings(s); return initGoogleSignIn(); }, settings);
  await page2.evaluate(() => window.__gsi.options.callback({ credential: 'x.' + btoa(JSON.stringify({ email: 'editor.test@gmail.com' })) + '.y' }));
  await expect(page2).toHaveURL(/#\/my$/);
  expect(await page2.evaluate(() => getMe())).toBe(editor);
  await expect(page2.locator('.page-sub')).toContainText(editor);
  expectNoErrors(errors); expectNoErrors(errors2);
});

test('совпадение по имени из Google связывает почту без выбора', async ({ page }) => {
  const errors = await openApp(page);
  const manager = await page.evaluate(() => MANAGERS[0]);
  await page.evaluate(() => saveSettings({ googleClientId: '123-abc.apps.googleusercontent.com' }));
  await page.evaluate(m => onGoogleCredential({ credential: 'x.' + btoa(unescape(encodeURIComponent(JSON.stringify({ email: 'boss@gmail.com', name: m })))) + '.y' }), manager);
  expect(await page.evaluate(() => [getMe(), getRole()])).toEqual([manager, 'manager']);
  // «Выйти» в окне «Кто я» сбрасывает имя и Google-вход в этом браузере
  await page.click('#meAvatar');
  await page.click('[data-gout]');
  expect(await page.evaluate(() => [getMe(), googleIdentity()])).toEqual(['', null]);
  expectNoErrors(errors);
});

test('настройка Client ID и список связанных почт', async ({ page }) => {
  const errors = await openApp(page, '#/settings');
  const card = page.locator('.card', { has: page.locator('h3', { hasText: 'Вход через Google' }) });
  await page.fill('#gClientId', 'not-a-client-id');
  await card.locator('button:has-text("Сохранить")').click();
  expect(await page.evaluate(() => getSettings().googleClientId)).toBe('');     // неверный формат не сохраняется
  await page.fill('#gClientId', '123-abc.apps.googleusercontent.com');
  await card.locator('button:has-text("Сохранить")').click();
  expect(await page.evaluate(() => getSettings().googleClientId)).toBe('123-abc.apps.googleusercontent.com');
  await page.evaluate(() => { linkGoogleAccount('a@gmail.com', 'Тест Тестов', 'editor'); router(); });
  await expect(page.locator('#content')).toContainText('a@gmail.com');
  expectNoErrors(errors);
});

test('связанные почты не теряются, когда два браузера привязали разные почты', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => saveSettings({ googleClientId: '123-abc.apps.googleusercontent.com' }));
  // у нас — привязка коллеги, ещё не ушедшая на сервер; с сервера приходят настройки без неё, но с чужой привязкой
  const res = await page.evaluate(() => {
    linkGoogleAccount('colleague@gmail.com', EDITORS[0], 'editor');
    const st = syncState(); st.lastRev = 0; st.base = {};
    const remote = Object.assign({}, getSettings(), { googleAccounts: { 'boss@gmail.com': { name: MANAGERS[0], role: 'manager', linkedAt: '2026-01-01T00:00:00Z' } } });
    applyRemoteChanges({ settings: { upserts: [remote] } });
    const acc = getSettings().googleAccounts;
    const pending = collectLocalChanges().changes.settings;
    return { emails: Object.keys(acc).sort(), willPush: !!(pending && pending.ups.length) };
  });
  expect(res.emails).toEqual(['boss@gmail.com', 'colleague@gmail.com']);
  expect(res.willPush).toBe(true);   // слитый список уйдёт обратно на сервер

  // удалённая почта не возвращается из старой копии
  const back = await page.evaluate(() => {
    localStorage.setItem('lqa_google', JSON.stringify({ email: 'boss@gmail.com', exp: Date.now() + 3600e3 }));   // удалять может только менеджер
    unlinkGoogleAccount('colleague@gmail.com');
    const stale = Object.assign({}, getSettings(), { googleAccounts: { 'colleague@gmail.com': { name: EDITORS[0], role: 'editor', linkedAt: '2026-01-01T00:00:00Z' } }, googleAccountsRemoved: {} });
    syncState().base = {};
    applyRemoteChanges({ settings: { upserts: [stale] } });
    return Object.keys(getSettings().googleAccounts);
  });
  expect(back).not.toContain('colleague@gmail.com');
  expectNoErrors(errors);
});

test('менеджер сам привязывает почту и исправляет «Кто»', async ({ page }) => {
  const errors = await openApp(page);
  const [boss, other] = await page.evaluate(() => [MANAGERS[0], MANAGERS[1]]);
  await page.evaluate(m => { saveSettings({ googleClientId: '123-abc.apps.googleusercontent.com' }); linkGoogleAccount('boss@gmail.com', m, 'manager');
    localStorage.setItem('lqa_google', JSON.stringify({ email: 'boss@gmail.com', exp: Date.now() + 3600e3 })); }, boss);
  await page.goto(page.url().split('#')[0] + '#/settings');
  await page.fill('#gaEmail', 'Colleague@Gmail.com');
  await page.selectOption('#gaName', other);
  await page.selectOption('#gaRole', 'manager');
  await page.click('button:has-text("Привязать")');
  expect(await page.evaluate(() => getSettings().googleAccounts['colleague@gmail.com'])).toMatchObject({ name: other, role: 'manager' });
  // в таблице «Кто» можно поменять
  const row = page.locator('tr', { hasText: 'colleague@gmail.com' });
  await row.locator('select').first().selectOption(boss);
  expect(await page.evaluate(() => getSettings().googleAccounts['colleague@gmail.com'].name)).toBe(boss);
  expectNoErrors(errors);
});
