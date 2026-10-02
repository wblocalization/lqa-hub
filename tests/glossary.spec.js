// Глоссарий: варианты через «/», аббревиатуры в скобках, названия экранов с заглавной буквы,
// перекрывающиеся термины и английские формы не дают ложных «Терминология».
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, expectNoErrors } = require('./helpers');

const TERMS = [
  ['обновить', 'update / refresh'], ['удалить', 'delete / remove'], ['ПВЗ / пункт выдачи', 'pickup point'],
  ['Выдача', 'Handover'], ['Стоимость', 'Fare'], ['стоимость доставки', 'delivery fee'],
  ['Товары', 'Items'], ['товар', 'item'], ['Покупки', 'History'], ['Данные', 'Advanced Analytics'],
  ['отмена', 'cancellation'], ['сбор', 'gift pool'], ['А/Б-тест', 'A/B test'], ['Wildberries', 'company'],
  ['полная стоимость кредита (ПСК)', 'true interest cost (TIC)'], ['оплата', 'payment'],
];
const ROWS = {
  ok1: ['Обновите экран', 'Please refresh the page'],
  ok2: ['Пункт выдачи', 'Pickup point'],
  ok3: ['Стоимость доставки', 'Delivery fee'],
  ok4: ['Товар добавлен', 'Item added'],
  ok5: ['Укажите все данные', 'Fill in all details'],
  ok6: ['К покупкам', 'Back to shopping'],
  ok7: ['Вы сможете его отменить', 'You can cancel it'],
  ok8: ['На сборке', 'Fulfillment'],
  ok9: ['А некоторые товары тяжёлые', 'Some items are heavy'],
  ok10: ['Договор с Wildberries', 'Agreement with Wildberries'],
  ok11: ['ПСК по кредиту', 'Loan TIC'],
  ok12: ['Товары', 'Items'],
  label: ['Откройте «Покупки»', 'Open Purchases'],
  missing: ['Стоимость доставки по городу', 'City shipping price'],
  rephrased: ['Оплата сейчас', 'Pay now'],
};

test('глоссарий без ложных срабатываний на реальных записях', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['en'] });
  const issues = await page.evaluate(async ({ TERMS, ROWS }) => {
    dbUpsert('glossaries', { id: 'g', name: 'RU-EN', language: '' });
    applyGlossaryImportRows('g', TERMS, 'replace');
    dbSave('rows', Object.entries(ROWS).map(([id, [s, t]]) => ({ id, projectId: 'p0', componentId: 'c0', languageCode: 'en', key: id, source: s, target: t })));
    dbSave('issues', []);
    await runGlossaryCheck('p0');
    return dbList('issues').map(i => ({ row: i.rowId, severity: i.severity, text: i.text }));
  }, { TERMS, ROWS });
  const byRow = {};
  issues.forEach(i => (byRow[i.row] = byRow[i.row] || []).push(i));
  for (const id of Object.keys(ROWS).filter(k => k.startsWith('ok'))) expect(byRow[id], id).toBeUndefined();
  expect(byRow.label.map(i => i.text)).toEqual([expect.stringContaining('«History»')]);     // «Покупки» в кавычках — название раздела
  expect(byRow.missing.map(i => [i.severity, i.text])).toEqual([['Высокая', expect.stringContaining('«delivery fee»')]]);   // одна, про длинный термин
  expect(byRow.rephrased.map(i => i.severity)).toEqual(['Низкая']);                       // обычное слово перефразировано — подсказка, не тревога
  expectNoErrors(errors);
});
