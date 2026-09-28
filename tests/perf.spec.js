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
  expectNoErrors(errors);
});
