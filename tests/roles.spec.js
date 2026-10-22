// Роли: менеджер видит всё, редактор — только свои языки и без загрузки, создания и удаления.
const { test, expect } = require('@playwright/test');
const { openApp, expectNoErrors } = require('./helpers');

async function seed(page) {
  await page.evaluate(() => {
    dbUpsert('projects', { id: 'p1', name: 'Магазин', languages: [{ code: 'hy', name: 'Армянский' }, { code: 'kk', name: 'Казахский' }] });
    dbUpsert('projects', { id: 'p2', name: 'Только казахский', languages: [{ code: 'kk', name: 'Казахский' }] });
    dbUpsert('components', { id: 'c1', projectId: 'p1', name: 'web' });
    const rows = [], issues = [];
    ['hy', 'kk'].forEach(code => { for (let k = 0; k < 3; k++) {
      const id = 'r' + code + k;
      rows.push({ id, projectId: 'p1', componentId: 'c1', languageCode: code, key: 'k' + k, source: 'Корзина', target: 'x' });
      issues.push({ id: 'i' + id, rowId: id, projectId: 'p1', componentId: 'c1', languageCode: code, type: 'Пробелы', severity: 'Средняя', text: 'проблема ' + code, status: 'Новая', createdAt: new Date().toISOString(), history: [] });
    } });
    dbSave('rows', rows); dbSave('issues', issues);
    saveSettings({ personLangs: { [EDITORS[0]]: ['hy'] } });
    router();
  });
}

test('редактор видит только свои языки и не видит кнопок менеджера', async ({ page }) => {
  const errors = await openApp(page);
  await seed(page);
  await page.evaluate(() => { setIdentity(EDITORS[0], 'editor'); router(); });

  // меню: нет подрядчиков, отчётов, аналитики, экспорта, расширения
  const nav = page.locator('#sideNav');
  await expect(nav).toContainText('Проблемы');
  await expect(nav).toContainText('Глоссарии');
  for (const t of ['Аналитика', 'Подрядчики', 'Экспорт', 'Отчёт за период', 'Расширение']) await expect(nav).not.toContainText(t);
  await expect(page.locator('.dash-hero button:has-text("Проект")')).toBeHidden();

  // проблемы — только армянские
  await page.evaluate(() => { location.hash = '#/issues'; });
  await expect(page.locator('#issuesRoot')).toContainText(/\b3 пробл/);
  await expect(page.locator('#issuesRoot')).not.toContainText(/\b6 пробл/);

  // проекты — только где есть его язык; в проекте нет загрузки и вкладок менеджера
  await page.evaluate(() => { location.hash = '#/projects'; });
  await expect(page.locator('#content')).toContainText('Магазин');
  await expect(page.locator('#content')).not.toContainText('Только казахский');
  await page.evaluate(() => { location.hash = '#/project/p1/content/files'; });
  await expect(page.locator('#poDrop')).toBeHidden();
  await expect(page.locator('.tabbar')).not.toContainText('Качество');

  // прямые ссылки на разделы менеджера и функции менеджера закрыты
  await page.evaluate(() => { location.hash = '#/vendors'; });
  await expect(page.locator('#content')).toContainText('Этот раздел для менеджеров');
  await page.evaluate(() => deleteProject('p1'));
  expect(await page.evaluate(() => !!dbGet('projects', 'p1'))).toBe(true);

  // настройки: только подключение
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.locator('#content')).toContainText('Командное хранилище');
  await expect(page.locator('#content')).not.toContainText('Правила LQA');
  expectNoErrors(errors);
});

test('менеджер видит всё и задаёт языки редактору', async ({ page }) => {
  const errors = await openApp(page);
  await seed(page);
  await page.evaluate(() => { setIdentity(MANAGERS[0], 'manager'); location.hash = '#/issues'; });
  await expect(page.locator('#issuesRoot')).toContainText(/\b6 пробл/);
  await expect(page.locator('#sideNav')).toContainText('Подрядчики');

  await page.evaluate(() => { location.hash = '#/settings'; });
  const card = page.locator('.card', { has: page.locator('h3', { hasText: 'Команда и доступ' }) });
  const editor = await page.evaluate(() => EDITORS[1]);
  await card.locator(`button[data-person="${editor}"]`).click();
  await page.locator('.dialog input[value="kk"]').check();
  await page.click('.dialog [data-ok]');
  expect(await page.evaluate(n => getSettings().personLangs[n], editor)).toEqual(['kk']);
  expectNoErrors(errors);
});

test('Google: роль менеджера выдаёт только менеджер', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => saveSettings({ googleClientId: '123-abc.apps.googleusercontent.com' }));
  const cred = (email, name) => 'x.' + Buffer.from(JSON.stringify({ email, name })).toString('base64') + '.y';
  // первый менеджер становится менеджером сам
  await page.evaluate(c => onGoogleCredential({ credential: c }), cred('boss@gmail.com', await page.evaluate(() => MANAGERS[0])));
  expect(await page.evaluate(() => currentRole())).toBe('manager');
  // кто-то другой называет себя менеджером — получает роль редактора
  await page.evaluate(() => { localStorage.removeItem('lqa_google'); });
  await page.evaluate(c => onGoogleCredential({ credential: c }), cred('someone@gmail.com', await page.evaluate(() => MANAGERS[1])));
  expect(await page.evaluate(() => [getSettings().googleAccounts['someone@gmail.com'].role, currentRole()])).toEqual(['editor', 'editor']);
  // без Google назваться менеджером нельзя
  await page.evaluate(() => { localStorage.removeItem('lqa_google'); setIdentity(MANAGERS[2], 'manager'); });
  expect(await page.evaluate(() => isManager())).toBe(false);
  expectNoErrors(errors);
});
