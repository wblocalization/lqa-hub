// Орфография и распознавание текста скачивают словари и движок из CDN (jsDelivr).
// Эти тесты идут, когда есть интернет: в GitHub Actions (CI=true) или с RUN_ONLINE_TESTS=1.
// Без интернета можно указать зеркало: LQA_CDN=http://localhost:8765/ LQA_TESSDATA=http://localhost:8765/tessdata
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, po, uploadPo, issuesByKey, expectNoErrors } = require('./helpers');

test.skip(!process.env.CI && !process.env.RUN_ONLINE_TESTS && !process.env.LQA_CDN, 'нужен интернет или LQA_CDN');
test.setTimeout(180_000);

test('орфография: опечатки в переводе и исходнике, «В словарь»', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => saveSettings({ checkSpelling: true, spellSource: true }));
  await seedProject(page, { langs: ['en'] });
  await uploadPo(page, { lang: 'en', text: po('en', [
    ['a', 'Корзина пуста', 'Your baskte is empty'],
    ['b', 'Доставкаа завтра', 'Delivery tomorrow'],
    ['c', 'Оформить заказ', 'Place order on Wildberries'],
  ]) });
  const issues = (await issuesByKey(page)).filter(i => i.type === 'Орфография');
  expect(issues.find(i => i.key === 'a').text).toContain('baskte');
  expect(issues.find(i => i.key === 'a').text).toContain('basket');
  expect(issues.find(i => i.key === 'b').text).toContain('Доставкаа');
  expect(issues.filter(i => i.key === 'c')).toEqual([]);

  const id = await page.evaluate(() => dbList('issues').find(i => i.type === 'Орфография' && i.highlightText === 'baskte').id);
  await page.evaluate(id => openIssueDetail(id), id);
  await page.click('button:has-text("В словарь")');
  expect(await page.evaluate(() => getSettings().spellWords)).toContain('baskte');
  expect(await page.evaluate(id => dbGet('issues', id).status, id)).toBe('Ложное срабатывание');
  expectNoErrors(errors);
});

test('распознавание текста: связь со строками и непереведённое на скриншоте', async ({ page, browser }) => {
  // скриншот «приложения»: один непереведённый заголовок, одна видимая переменная
  const shotPage = await browser.newPage({ viewport: { width: 900, height: 360 } });
  await shotPage.setContent(`<body style="font:22px Arial;padding:30px;margin:0;background:#fff">
    <div style="font-size:30px;font-weight:bold;margin-bottom:22px">Себет бос</div>
    <div style="margin:14px 0">Оформить заказ</div>
    <div style="margin:14px 0">Сәлеметсіз бе, {{name}}!</div></body>`);
  const png = await shotPage.screenshot();
  await shotPage.close();

  const errors = await openApp(page);
  await seedProject(page, { langs: ['kk'] });
  await uploadPo(page, { lang: 'kk', text: po('kk', [['cart', 'Корзина пуста', 'Себет бос'], ['checkout', 'Оформить заказ', 'Тапсырысты рәсімдеу'], ['hello', 'Здравствуйте, {{name}}!', 'Сәлеметсіз бе, {{name}}!']]) });
  await page.evaluate(() => { dbUpsert('visualSessions', { id: 's0', projectId: 'p0', name: 'Корзина', languageCode: 'kk', createdAt: nowISO() }); location.hash = '#/visual/s0/shots'; });
  await page.setInputFiles('#shotFileInput', { name: 'cart.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.shot-card')).toHaveCount(1);
  await page.click('button:has-text("Найти текст на скриншотах")');
  await page.waitForFunction(() => dbList('visualShots')[0] && dbList('visualShots')[0].ocr, null, { timeout: 150_000 });

  const lines = await page.evaluate(() => dbList('visualShots')[0].ocr.lines.map(l => ({ t: l.t, key: l.rowId ? dbGet('rows', l.rowId).key : null, kind: l.kind })));
  expect(lines.find(l => l.key === 'cart')).toBeTruthy();
  expect(lines.find(l => l.key === 'checkout' && l.kind === 'source')).toBeTruthy();
  const types = await page.evaluate(() => dbList('issues').filter(i => i.visual).map(i => i.type));
  expect(types).toContain('Не переведено');
  expect(types).toContain('Видна переменная / тег / ключ');
  expectNoErrors(errors);
});

test('распознавание текста: обрезанный текст и нормальный перенос', async ({ page, browser }) => {
  const shotPage = await browser.newPage({ viewport: { width: 900, height: 420 } });
  await shotPage.setContent(`<body style="font:22px Arial;padding:30px;margin:0;background:#fff">
    <div style="width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:26px">Тапсырысты рәсімдеу және төлеу</div>
    <div style="width:170px;white-space:nowrap;overflow:hidden;margin-bottom:26px">Жеткізу мекенжайын өзгерту</div>
    <div style="width:330px;margin-bottom:26px">Тапсырысыңыз қабылданды, жақын арада хабарласамыз</div></body>`);
  const png = await shotPage.screenshot();
  await shotPage.close();

  const errors = await openApp(page);
  await seedProject(page, { langs: ['kk'] });
  await uploadPo(page, { lang: 'kk', text: po('kk', [
    ['ellipsis', 'Оформить и оплатить заказ', 'Тапсырысты рәсімдеу және төлеу'],
    ['clipped', 'Изменить адрес доставки', 'Жеткізу мекенжайын өзгерту'],
    ['wrapped', 'Заказ принят, скоро свяжемся', 'Тапсырысыңыз қабылданды, жақын арада хабарласамыз'],
  ]) });
  await page.evaluate(() => { dbUpsert('visualSessions', { id: 's0', projectId: 'p0', name: 'Заказ', languageCode: 'kk', createdAt: nowISO() }); location.hash = '#/visual/s0/shots'; });
  await page.setInputFiles('#shotFileInput', { name: 'order.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.shot-card')).toHaveCount(1);
  await page.click('button:has-text("Найти текст на скриншотах")');
  await page.waitForFunction(() => dbList('visualShots')[0] && dbList('visualShots')[0].ocr, null, { timeout: 150_000 });

  const cut = await page.evaluate(() => dbList('issues').filter(i => i.type === 'Обрезанный текст').map(i => dbGet('rows', i.rowId).key).sort());
  expect(cut).toEqual(['clipped', 'ellipsis']);
  expectNoErrors(errors);
});

// минимальный PDF с одной строкой текста
function tinyPdf(text) {
  const stream = `BT /F1 18 Tf 40 760 Td (${text}) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`, 'latin1');
}

test('редполитика из PDF читается в браузере', async ({ page }) => {
  const errors = await openApp(page, '#/glossaries/styleguides');
  await page.evaluate(() => editStyleGuide('ka'));
  await page.setInputFiles('#sgFile', { name: 'redpolitika.pdf', mimeType: 'application/pdf', buffer: tinyPdf('Quotes: use low-high quotes') });
  await expect(page.locator('#sgFileStatus')).toContainText('✓', { timeout: 60_000 });
  await expect(page.locator('#sgValue')).toHaveValue(/use low-high quotes/);
  await page.click('.dialog [data-ok]');
  expect(await page.evaluate(() => getSettings().styleGuides.ka)).toContain('low-high quotes');
  expectNoErrors(errors);
});
