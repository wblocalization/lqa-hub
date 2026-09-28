// Массовое удаление: все проблемы по фильтру, строки целиком, несколько файлов сразу.
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, po, uploadPo, expectNoErrors } = require('./helpers');

async function seed(page) {
  await seedProject(page, { langs: ['kk', 'uz'] });
  const pairs = [['a', 'Корзина', 'Себет '], ['b', 'Оплата', ''], ['c', 'Доставка {n}', 'Жеткізу']];
  await uploadPo(page, { lang: 'kk', text: po('kk', pairs) });
  await uploadPo(page, { lang: 'uz', text: po('uz', pairs) });
}

test('«Удалить всё по фильтру» удаляет проблемы на всех страницах без выделения', async ({ page }) => {
  const errors = await openApp(page);
  await seed(page);
  const before = await page.evaluate(() => dbList('issues').length);
  expect(before).toBeGreaterThan(1);
  await page.evaluate(() => { location.hash = '#/issues'; });
  await page.click('#issuesRoot button:has-text("Удалить всё по фильтру")');
  await expect(page.locator('.dialog')).toContainText(String(before));
  await page.click('.dialog [data-ok]');
  expect(await page.evaluate(() => dbList('issues').length)).toBe(0);
  expect(await page.evaluate(() => dbList('rows').length)).toBe(6);            // строки на месте
  expectNoErrors(errors);
});

test('«Строки»: удалить строки целиком вместе с проблемами', async ({ page }) => {
  const errors = await openApp(page);
  await seed(page);
  await page.evaluate(() => { location.hash = '#/project/p0/content/strings'; });
  await page.click('#projTabStrings button:has-text("Удалить всё по фильтру")');
  await page.check('.dialog input[value=rows]');
  await page.click('.dialog [data-ok]');
  expect(await page.evaluate(() => [dbList('rows').length, dbList('issues').length])).toEqual([0, 0]);
  expect(await page.evaluate(() => dbList('files').map(f => f.rowCount))).toEqual([0, 0]);
  expectNoErrors(errors);
});

test('файлы: выбрать несколько и удалить разом', async ({ page }) => {
  const errors = await openApp(page);
  await seed(page);
  await page.evaluate(() => { location.hash = '#/project/p0/content/files'; });
  const card = page.locator('.card', { has: page.locator('h3', { hasText: 'Загруженные файлы' }) });
  await card.locator('thead input[type=checkbox]').check();
  await card.locator('.file-bulk-del').click();
  await expect(page.locator('.dialog')).toContainText('Удалить 2 файла');
  await page.click('.dialog [data-ok]');
  expect(await page.evaluate(() => [dbList('files').length, dbList('rows').length])).toEqual([0, 0]);
  expectNoErrors(errors);
});
