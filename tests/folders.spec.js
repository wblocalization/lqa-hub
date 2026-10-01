// Папки, подпапки, удаление файлов и история строки между версиями файла.
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, po, uploadPo, expectNoErrors } = require('./helpers');

const v1 = po('kk', [['a', 'Корзина', 'Себет '], ['b', 'Заказ', 'Тапсырыс']]);
const v2 = po('kk', [['a', 'Корзина', 'Себет'], ['b', 'Заказ', 'Тапсырыс'], ['c', 'Доставка', 'Жеткізу']]);

test('подпапка создаётся со страницы папки и считается в итогах родителя', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page);
  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0'; });
  await page.click('.subfolder-new');
  await page.fill('#compName', 'Каталог');
  await page.click('.modal-actions .btn:not(.secondary)');
  const sub = await page.evaluate(() => dbList('components').find(c => c.name === 'Каталог'));
  expect(sub.parentId).toBe('c0');

  await uploadPo(page, { folderId: sub.id, text: v1 });
  expect(await page.evaluate(() => folderCounts('c0').rows)).toBe(2);
  await expect(page.locator('#crumbs')).toContainText('Каталог');

  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0'; });
  await expect(page.locator('.subfolder-name')).toHaveText(['Каталог']);

  await page.evaluate(() => { location.hash = '#/project/p0/folders'; });
  await expect(page.locator('tbody tr')).toHaveCount(2);           // родитель раскрыт после создания подпапки
  await page.click('.tree-tg');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  expectNoErrors(errors);
});

test('удаление файла с отменой и удаление папки вместе с подпапками', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page);
  await page.evaluate(() => dbUpsert('components', { id: 'c1', projectId: 'p0', name: 'iOS', parentId: 'c0' }));
  await uploadPo(page, { folderId: 'c1', text: v1 });
  await page.evaluate(() => { location.hash = '#/project/p0/folder/c1/files'; });
  const count = () => page.evaluate(() => [dbList('files').length, dbList('rows').length]);
  expect(await count()).toEqual([1, 2]);

  await page.click('button[title="Удалить файл"]');
  await page.click('.dialog [data-ok]');
  expect(await count()).toEqual([0, 0]);
  await page.click('.toast button');                                // «Отменить»
  expect(await count()).toEqual([1, 2]);

  await page.evaluate(() => { location.hash = '#/project/p0/folders'; });
  await page.locator('tbody tr').first().locator('button[title="Удалить"]').click();
  await expect(page.locator('.dialog')).toContainText('1 подпапка');
  await page.click('.dialog [data-ok]');
  expect(await page.evaluate(() => [dbList('components').length, dbList('rows').length])).toEqual([0, 0]);
  expectNoErrors(errors);
});

test('история перевода: изменение между версиями и исправление в платформе', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page);
  await uploadPo(page, { text: v1 });
  await uploadPo(page, { text: v2 });
  const hist = await page.evaluate(() => Object.fromEntries(dbList('rows').map(r => [r.key, (r.targetHistory || []).map(h => [h.how, h.from, h.to])])));
  expect(hist.a).toEqual([['upload', 'Себет ', 'Себет']]);
  expect(hist.b).toEqual([]);
  expect(await page.evaluate(() => dbList('rows').length)).toBe(3);   // прежняя версия заменена, а не добавлена

  const rowId = await page.evaluate(() => dbList('rows').find(r => r.key === 'b').id);
  await page.evaluate(id => openRowDetail(id), rowId);
  await expect(page.locator('.modal')).toContainText('Перевод не менялся');
  expect(await page.evaluate(() => wordDiffHtml('Купить сейчас', 'Купить сегодня'))).toBe('Купить <del>сейчас</del><ins>сегодня</ins>');
  expectNoErrors(errors);
});

test('название и описание файла: при загрузке, правка и новая версия', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page);
  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0/files'; });
  await page.click('.file-meta summary');
  await page.fill('#folderUploadTitle', 'Корзина, релиз 5.2');
  await page.fill('#folderUploadDesc', 'Тексты новой корзины');
  await uploadPo(page, { text: v1 });
  let f = await page.evaluate(() => dbList('files')[0]);
  expect([f.title, f.description, f.filename]).toEqual(['Корзина, релиз 5.2', 'Тексты новой корзины', 'kk.po']);

  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0/files'; });
  await expect(page.locator('#content')).toContainText('Корзина, релиз 5.2');
  await page.click('button[title="Название, описание, подрядчик"]');
  await page.fill('#fmTitle', 'Корзина 5.3');
  await page.click('.dialog [data-ok]');
  await expect(page.locator('#content')).toContainText('Корзина 5.3');

  await uploadPo(page, { text: v2 });                                  // новая версия без названия — название остаётся
  f = await page.evaluate(() => dbList('files').find(x => !x.supersededBy));
  expect([f.title, f.description]).toEqual(['Корзина 5.3', 'Тексты новой корзины']);
  expectNoErrors(errors);
});

test('перед загрузкой: внутри файла не тот язык и одинаковые переводы у разных языков', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['az', 'kk', 'ka'] });
  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0/files'; });
  await page.waitForSelector('#folderPoDrop');
  const ka = po('ka', [['a', 'Добавить в корзину', 'კალათაში დამატება'], ['b', 'Оформить заказ', 'შეკვეთის გაფორმება'], ['c', 'Мои заказы', 'ჩემი შეკვეთები'], ['d', 'Оплатить картой', 'ბარათით გადახდა']]);
  const az = po('az', [['a', 'Добавить в корзину', 'Səbətə əlavə et'], ['b', 'Оформить заказ', 'Sifarişi rəsmiləşdir'], ['c', 'Мои заказы', 'Sifarişlərim'], ['d', 'Оплатить картой', 'Kartla ödə']]);
  await page.evaluate(({ ka, az }) => addFolderPendingFiles([
    new File([ka], 'app-az.po'), new File([ka], 'app-kk.po'), new File([ka], 'app-ka.po'), new File([az], 'web-az.po'),
  ]), { ka, az });
  const rows = page.locator('#folderPendingWrap .mono');
  await expect(rows).toHaveCount(4);
  const warn = page.locator('#folderPendingWrap .lang-warn');
  await expect(warn).toHaveCount(3);                                    // app-az, app-kk — грузинский внутри; app-ka — совпадает с ними
  await expect(warn.nth(0)).toContainText('грузинский (ka), а выбран az');
  await expect(warn.nth(2)).toContainText('совпадают с файлом');
  await page.click('#folderPendingWrap button:has-text("Загрузить")');
  await expect(page.locator('.dialog')).toContainText('не тот язык');
  await page.click('.dialog [data-cancel]');
  expect(await page.evaluate(() => dbList('files').length)).toBe(0);
  expectNoErrors(errors);
});
