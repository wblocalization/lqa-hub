// Выбор файла кликом по полю загрузки (а не перетаскиванием): окно выбора открывается один раз, файл попадает в список и загружается.
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, po, expectNoErrors } = require('./helpers');
const text = po('kk', [['a', 'Корзина', 'Себет'], ['b', 'Заказ', 'Тапсырыс']]);

for (const where of ['folder', 'project']) {
  test('загрузка файла через окно выбора: ' + (where === 'folder' ? 'страница папки' : 'страница проекта'), async ({ page }) => {
    const errors = await openApp(page);
    await seedProject(page);
    await page.evaluate(w => { location.hash = w === 'folder' ? '#/project/p0/folder/c0/files' : '#/project/p0/content/files'; }, where);
    const drop = page.locator(where === 'folder' ? '#folderPoDrop' : '#poDrop');
    await drop.waitFor();
    let choosers = 0; page.on('filechooser', () => choosers++);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), drop.click()]);
    await fc.setFiles({ name: 'kk.po', mimeType: 'text/plain', buffer: Buffer.from(text) });
    const wrap = page.locator(where === 'folder' ? '#folderPendingWrap' : '#projectPendingWrap');
    await expect(wrap).toContainText('Выбрано файлов: 1');
    expect(choosers).toBe(1);                                   // окно выбора — ровно одно
    await wrap.locator('button:has-text("Загрузить")').click();
    await expect.poll(() => page.evaluate(() => dbList('files').length)).toBe(1);
    expect(await page.evaluate(() => dbList('rows').length)).toBe(2);
    expectNoErrors(errors);
  });
}
