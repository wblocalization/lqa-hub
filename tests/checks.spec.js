// Техническая проверка строк: переменные, числа, пробелы, правила языков, «игнорировать».
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, po, uploadPo, issuesByKey, expectNoErrors } = require('./helpers');

test('находит типичные ошибки перевода', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['kk'] });
  await uploadPo(page, { lang: 'kk', text: po('kk', [
    ['ok', 'Корзина', 'Себет'],
    ['var', 'Привет, {{name}}!', 'Сәлем!'],
    ['num', 'Цена 12 990 ₽', 'Бағасы 12 900 ₸'],
    ['space', 'Оформить заказ', 'Тапсырыс  беру'],
    ['empty', 'Доставка', ''],
    ['homoglyph', 'Товар', 'Тауaр'],
  ]) });
  const issues = await issuesByKey(page);
  const types = key => issues.filter(i => i.key === key).map(i => i.type);
  expect(types('ok')).toEqual([]);
  expect(types('var')).toContain('Переменные');
  expect(types('num')).toContain('Числа');
  expect(types('space')).toContain('Пробелы');
  expect(types('homoglyph')).toContain('Правила языка');
  expectNoErrors(errors);
});

test('правила конкретных языков: апостроф в узбекском и свои правила', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => saveSettings({ customLangRules: 'uz ; /\\bsum\\b/i ; Пишем «soʻm»' }));
  await seedProject(page, { langs: ['uz'] });
  await uploadPo(page, { lang: 'uz', text: po('uz', [
    ['apos', 'Заказ оформлен', "Buyurtma qabul qilindi, o'zgartirish mumkin"],
    ['custom', 'Цена 100 сум', 'Narxi 100 sum'],
    ['good', 'Заказ', 'Buyurtma'],
  ]) });
  const issues = await issuesByKey(page);
  expect(issues.filter(i => i.key === 'apos').map(i => i.type)).toContain('Правила языка');
  expect(issues.find(i => i.key === 'custom' && i.type === 'Правила языка').text).toContain('soʻm');
  expect(issues.filter(i => i.key === 'good')).toEqual([]);
  expectNoErrors(errors);
});

test('правила «игнорировать» убирают проблемы при следующей загрузке', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['kk'] });
  await page.evaluate(() => saveSettings({ ignoreRules: [{ id: 'r1', keyPattern: 'debug.*', type: '', text: '', action: 'skip' }] }));
  await uploadPo(page, { lang: 'kk', text: po('kk', [
    ['debug.one', 'Тест  тест', 'Тест  тест'],
    ['real', 'Оформить заказ', 'Тапсырыс  беру'],
  ]) });
  const issues = await issuesByKey(page);
  expect(issues.filter(i => i.key === 'debug.one')).toEqual([]);
  expect(issues.filter(i => i.key === 'real').length).toBeGreaterThan(0);
  expectNoErrors(errors);
});

test('процент с суффиксом — не переменная: «7%-dək», «50% dən»', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(() => ({
    az: extractAll('WB balları ilə 7%-dək keşbek və 50% dən çox', VAR_RE),
    other: extractAll('7 %dan boshlab · 7%dan · 5 %-дан бастап · 50 % de réduction · %50\'ye varan · %0 faizli', VAR_RE),
    real: extractAll('Осталось %d шт., %s и %1$s, %-5d, %.2f', VAR_RE),
  }));
  expect(r.az).toEqual([]);
  expect(r.other).toEqual([]);
  expect(r.real).toEqual(['%d', '%s', '%1$s', '%-5d', '%.2f']);
  await seedProject(page, { langs: ['az'] });
  await uploadPo(page, { lang: 'az', text: po('az', [['cb', 'До 7% кешбэка баллами ВБ', 'WB balları ilə 7%-dək keşbek']]) });
  expect((await issuesByKey(page)).filter(i => i.key === 'cb' && /еременн/.test(i.type))).toEqual([]);
  expectNoErrors(errors);
});
