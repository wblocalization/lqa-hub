// Подрядчики: оценка перевода по MQM, выборочная проверка, оценка чужой проверки (LQA), импорт из таблицы.
const { test, expect } = require('@playwright/test');
const XLSX = require('xlsx');
const { openApp, seedProject, po, uploadPo, expectNoErrors } = require('./helpers');

const src = Array.from({ length: 30 }, (_, i) => [`k${i}`, `Товар номер ${i} добавлен в корзину`, `Тауар нөмірі ${i}${i % 6 === 0 ? '  ' : ' '}себетке қосылды`]);

async function uploadAs(page, vendorId, delivery, pairs) {
  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0/files'; });
  await page.waitForSelector('#folderUploadVendor');
  await page.selectOption('#folderUploadVendor', vendorId);
  await page.selectOption('#folderUploadDelivery', delivery);
  await uploadPo(page, { text: po('kk', pairs) });
}

test('перевод подрядчика: выборка, оценка и вердикт; проверка другим подрядчиком', async ({ page }) => {
  const errors = await openApp(page, '#/vendors');
  await expect(page.locator('tbody tr')).toHaveCount(5);                      // подрядчики по умолчанию
  await seedProject(page);
  await uploadAs(page, 'v_logrusit', 'translation', src);
  const f = await page.evaluate(() => dbList('files')[0]);
  expect([f.vendorId, f.delivery, f.words]).toEqual(['v_logrusit', 'translation', 180]);

  // выборочная проверка: 20 строк, в двух — ошибки «Высокая» (штраф 5) → 100 − 10×100/120 слов
  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0/files'; });
  await page.click('button:has-text("Выборка")');
  await page.click('.dialog [data-ok]');
  await expect(page).toHaveURL(/#\/sample\//);
  for (let i = 0; i < 20; i++) {
    await expect(page.locator('.kpi .num').first()).toHaveText(`${i} / 20`);
    if (i === 3 || i === 7) {
      await page.keyboard.press('2');
      await expect(page.locator('#smpErr')).toBeVisible();
      await page.fill('#smpComment', 'Неверный падеж');
      await page.selectOption('#smpSev', 'Высокая');
      await page.locator('#smpComment').press('Enter');
    } else await page.keyboard.press('1');
  }
  await expect(page.locator('.kpi .num').first()).toHaveText('20 / 20');
  const st = await page.evaluate(() => sampleStats(dbList('samples')[0]));
  expect([st.done, st.ok, st.err, st.finished, st.pass]).toEqual([20, 18, 2, true, false]);
  expect(Math.round(st.score * 10) / 10).toBe(91.7);
  expect(await page.evaluate(() => dbList('issues').filter(i => i.sampleId && i.status === 'Принята').length)).toBe(2);

  // проверка (LQA) другим подрядчиком: убрал одну ошибку из пяти
  await uploadAs(page, 'v_janusww', 'review', src.map(([k, s, t], i) => [k, s, i === 0 ? t.replace('  ', ' ') : t]));
  const r = await page.evaluate(() => reviewStats(dbList('files').find(x => !x.supersededBy)));
  expect([r.changed, r.fixed, r.left, r.added]).toEqual([1, 1, 4, 0]);
  // оценка перевода LogrusIT сохранилась после замены файла
  const q = await page.evaluate(() => dbList('files').find(x => x.supersededBy).quality);
  expect([q.words, q.confirmed]).toEqual([180, 2]);

  // выборка правок проверяющего: берутся только изменённые строки, правка показана как было → стало
  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0/files'; });
  await page.click('button:has-text("Выборка")');
  await page.click('.dialog [data-ok]');
  await expect(page.locator('.sample-card del, .sample-card ins').first()).toBeVisible();
  await page.keyboard.press('3');                                              // лишняя правка
  const rs = await page.evaluate(() => { const s = dbList('samples').find(x => x.kind === 'review'); return [s.rowIds.length, sampleStats(s).extra]; });
  expect(rs).toEqual([1, 1]);

  await page.evaluate(() => { location.hash = '#/vendors/v_janusww'; });
  await expect(page.locator('#content')).toContainText('Проверки (LQA) чужих переводов');
  await expect(page.locator('.kpi .num').nth(3)).toHaveText('20%');
  expectNoErrors(errors);
});

test('импорт подрядчиков из таблицы: языки берутся только из строк задач', async ({ page }) => {
  await page.route(/xlsx.*\.js/, r => r.fulfill({ path: require.resolve('xlsx/dist/xlsx.full.min.js'), contentType: 'text/javascript' }));
  const errors = await openApp(page, '#/vendors');
  await page.evaluate(() => { dbSave('vendors', []); saveSettings({ vendorsSeeded: true }); router(); });
  const wb = XLSX.utils.book_new();
  // лист-справочник: подрядчики и языки — независимые списки
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Продукт', 'Языки', 'Подрядчик'], ['Магазинка', 'Азербайджанский', 'Альфа'], ['WBP', 'Английский', 'Бета'], ['ПВЗ', 'Армянский', ''], ['СЦ', 'Грузинский', '']]), 'Списки');
  // журнал задач: у каждой строки подрядчик и его языки
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['№', 'Языки', 'Подрядчик'], ['1', 'Казахский, Узбекский', 'Альфа'], ['2', 'Армянский', 'Альфа']]), 'Задачи');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  await page.setInputFiles('#vendorImport', { name: 'vendors.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: buf });
  await expect.poll(() => page.evaluate(() => dbList('vendors').length)).toBe(2);
  const v = await page.evaluate(() => Object.fromEntries(dbList('vendors').map(x => [x.name, x.languages.slice().sort()])));
  expect(v).toEqual({ 'Альфа': ['hy', 'kk', 'uz'], 'Бета': [] });
  expectNoErrors(errors);
});
