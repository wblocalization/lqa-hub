// Большой файл: 20 000 строк загружаются и перезагружаются новой версией за разумное время.
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, uploadPo, expectNoErrors } = require('./helpers');

test('20 000 строк: загрузка и новая версия', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openApp(page);
  await seedProject(page);
  let text = 'msgid ""\nmsgstr ""\n"Language: kk\\n"\n\n';
  for (let i = 0; i < 20000; i++) text += `msgctxt "k.${i}"\nmsgid "Товар ${i} стоит {0} ₽"\nmsgstr "Тауар  ${i} бағасы {0} ₸"\n\n`;
  let t = Date.now();
  await uploadPo(page, { text });
  const first = Date.now() - t;
  t = Date.now();
  await uploadPo(page, { text: text.replace(/₸"/g, '₸."') });
  const second = Date.now() - t;
  console.log(`20k строк: загрузка ${first} мс, новая версия ${second} мс`);
  expect(await page.evaluate(() => dbList('rows').length)).toBe(20000);
  expect(second).toBeLessThan(20_000);
  t = Date.now();
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('.kpi');
  expect(Date.now() - t).toBeLessThan(5_000);
  // «Показывать: все» — все 20 000 строк одной таблицей
  await page.evaluate(() => { location.hash = '#/project/p0/content/strings'; });
  await page.waitForSelector('.pager-size select');
  t = Date.now();
  await page.selectOption('.pager-size select', '0');
  await expect(page.locator('#projTabStrings tbody tr')).toHaveCount(500);   // сразу первые 500, остальные — по мере прокрутки
  const all = Date.now() - t;
  console.log(`20k строк: «показывать все» открылось за ${all} мс`);
  expect(all).toBeLessThan(5_000);
  await expect(page.locator('.lazy-more')).toContainText('из 20');
  await page.locator('.lazy-more').scrollIntoViewIfNeeded();
  await expect(page.locator('#projTabStrings tbody tr')).toHaveCount(1000);
  await expect(page.locator('.pager')).toContainText('20000 строк');
  expectNoErrors(errors);
});
