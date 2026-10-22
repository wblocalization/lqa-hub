// Все страницы открываются без ошибок; палитра команд, сохранённые фильтры, отчёт за период.
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, po, uploadPo, expectNoErrors } = require('./helpers');

async function withData(page) {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['kk', 'uz'] });
  await uploadPo(page, { lang: 'kk', text: po('kk', [['a', 'Корзина', 'Себет  бос'], ['b', 'Цена 100 ₽', 'Бағасы 100 ₽'], ['c', 'Заказ', 'Тапсырыс']]) });
  return errors;
}

test('все разделы открываются без ошибок', async ({ page }) => {
  const errors = await withData(page);
  for (const hash of ['#/', '#/projects', '#/project/p0', '#/project/p0/folders', '#/project/p0/quality', '#/project/p0/folder/c0',
    '#/project/p0/folder/c0/strings', '#/issues', '#/my', '#/visual', '#/glossaries', '#/analytics', '#/report', '#/export', '#/settings']) {
    await page.evaluate(h => { location.hash = h; }, hash);
    await expect(page.locator('#content')).not.toContainText('Не получилось показать страницу');
    await expect(page.locator('#content')).not.toContainText('Страница не найдена');
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { location.hash = '#/'; });
  await expect(page.locator('.mob-search')).toBeVisible();
  expectNoErrors(errors);
});

test('палитра команд: Ctrl+K, поиск папки и переход', async ({ page }) => {
  const errors = await withData(page);
  await page.keyboard.press('Control+k');
  await expect(page.locator('#cmdk')).toBeVisible();
  await page.keyboard.type('web');
  await expect(page.locator('.cmdk-item.sel')).toContainText('web');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/project\/p0\/folder\/c0$/);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Тапсырыс');
  await expect(page.locator('.cmdk-group', { hasText: 'Строки' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#cmdk')).toHaveCount(0);
  expectNoErrors(errors);
});

test('сохранённый фильтр возвращает ту же выборку', async ({ page }) => {
  const errors = await withData(page);
  await page.evaluate(() => { location.hash = '#/issues'; });
  await page.waitForSelector('#issuesRoot_tablewrap tbody tr');
  const all = await page.locator('#issuesRoot_tablewrap tbody tr').count();
  await page.fill('#issuesRoot_q', 'Себет');
  const filtered = await page.locator('#issuesRoot_tablewrap tbody tr').count();
  expect(filtered).toBeLessThan(all);
  await page.click('.chip-save');
  await page.fill('#uiPromptInput', 'Себет');
  await page.click('.dialog [data-ok]');
  await page.fill('#issuesRoot_q', '');
  await page.locator('#issuesRoot_q').dispatchEvent('input');
  await expect(page.locator('#issuesRoot_tablewrap tbody tr')).toHaveCount(all);
  await page.locator('.chip-view button').first().click();
  await expect(page.locator('#issuesRoot_tablewrap tbody tr')).toHaveCount(filtered);
  await expect(page.locator('.chip-view.chip-active')).toHaveCount(1);
  expectNoErrors(errors);
});

test('отчёт за период считает найденное и решённое', async ({ page }) => {
  const errors = await withData(page);
  const found = await page.evaluate(() => dbList('issues').length);
  await page.evaluate(() => { const i = dbList('issues')[0]; i.status = 'Принята'; i.history.push({ ts: nowISO(), action: 'Подтвердить', reviewer: 'Тест' }); dbUpsert('issues', i); location.hash = '#/report'; });
  await expect(page.locator('.kpi .num').nth(0)).toHaveText(String(found));
  await expect(page.locator('.kpi .num').nth(1)).toHaveText('1');
  await expect(page.locator('#content')).toContainText('Кто решал');
  expectNoErrors(errors);
});

test('отчёт показывает менеджеров: кто загружал файлы', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page);
  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0/files'; });
  await page.waitForSelector('#folderUploadManager');
  const manager = await page.evaluate(() => MANAGERS[0]);
  await page.selectOption('#folderUploadManager', manager);
  await uploadPo(page, { text: po('kk', [['a', 'Корзина', 'Себет  бос'], ['b', 'Заказ', 'Тапсырыс']]) });
  await page.evaluate(() => { location.hash = '#/report'; });
  const card = page.locator('.card', { has: page.locator('h3', { hasText: 'Менеджеры' }) });
  await expect(card).toContainText(manager);
  await expect(card.locator('tbody tr').first().locator('td').nth(2)).toHaveText('2');   // строк
  expectNoErrors(errors);
});

test('ключ строки виден целиком и копируется по клику', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = await openApp(page);
  const key = 'FINTECH_INSURANCES_new_individual_insurance_payment_description_long_key';
  await page.evaluate(k => {
    dbUpsert('projects', { id: 'p0', name: 'x', languages: [{ code: 'az', name: 'az' }] });
    dbUpsert('components', { id: 'c0', projectId: 'p0', name: 'web' });
    dbSave('rows', [{ id: 'r1', projectId: 'p0', componentId: 'c0', languageCode: 'az', key: k, source: 'Оплата', target: 'Ödəniş' }]);
    openRowDetail('r1');
  }, key);
  const btn = page.locator('.modal .key-copy');
  await expect(btn).toHaveText(key);
  const box = await btn.boundingBox(), modal = await page.locator('.modal').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(modal.x + modal.width);   // не вылезает за окно
  await btn.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  expectNoErrors(errors);
});

test('историю проверок можно очистить — строки и проблемы остаются', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['kk'] });
  await uploadPo(page, { lang: 'kk', text: po('kk', [['a', 'Корзина', '']]) });
  await uploadPo(page, { lang: 'kk', text: po('kk', [['a', 'Корзина', 'Себет ']]) });
  const before = await page.evaluate(() => [dbList('runs').length, dbList('rows').length, dbList('issues').length]);
  expect(before[0]).toBeGreaterThan(1);
  await page.evaluate(() => { location.hash = '#/runs'; });
  await page.click('button:has-text("Очистить историю")');
  await page.click('.dialog [data-ok]');
  expect(await page.evaluate(() => [dbList('runs').length, dbList('rows').length, dbList('issues').length])).toEqual([0, before[1], before[2]]);
  await expect(page.locator('#content')).toContainText('Проверок пока не было');
  expectNoErrors(errors);
});
