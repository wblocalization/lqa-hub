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
    saveSettings({ glossaryHints: false });
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
  expect(byRow.rephrased).toBeUndefined();                                                // обычное слово перефразировано — по умолчанию молчим
  // подсказки включаются в Настройках
  const hints = await page.evaluate(async () => {
    saveSettings({ glossaryHints: true }); await runGlossaryCheck('p0');
    return dbList('issues').filter(i => i.rowId === 'rephrased').map(i => i.severity);
  });
  expect(hints).toEqual(['Низкая']);
  expectNoErrors(errors);
});

test('CSV: ячейки в кавычках с переносами строк и запятыми не разваливаются', async ({ page }) => {
  const errors = await openApp(page);
  const csv = '﻿key,source,target\r\n' +
    'a,"Нажмите «Пополнить», укажите номер,\nсумму и получателя.","Tap Top Up, enter your number,\namount and recipient."\r\n' +
    'b,"Скажите ""да""",Say yes\r\n';
  const rows = await page.evaluate(text => parseCsvEntries(text), csv);
  expect(rows).toEqual([
    { key: 'a', source: 'Нажмите «Пополнить», укажите номер,\nсумму и получателя.', target: 'Tap Top Up, enter your number,\namount and recipient.' },
    { key: 'b', source: 'Скажите "да"', target: 'Say yes' },
  ]);
  expectNoErrors(errors);
});

test('числа, переносы <br> и рубли в английском — без ложных тревог', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['en'] });
  const ROWS2 = {
    date: ['С 28 сентября 2012 года', 'Since September 28, 2012'],
    once: ['Сработает 1 раз до {{date}}', 'Can be used once until {{date}}'],
    thousands: ['Цена 12 990', 'Price 12,990'],
    rub: ['1 ягодка = 1 рубль', '1 berry = 1 ₽'],
    br: ['Отправьте жалобу,<br>если что-то не так', 'Report if something is wrong'],
    lostNum: ['Минимум 2 фото', 'Upload photos'],
  };
  const issues = await page.evaluate(async rows => {
    dbSave('rows', Object.entries(rows).map(([id, [s, t]]) => ({ id, projectId: 'p0', componentId: 'c0', languageCode: 'en', key: id, source: s, target: t })));
    await runTechnicalCheckOnRows(Object.keys(rows));
    return dbList('issues').map(i => [i.rowId, i.type, i.severity]);
  }, ROWS2);
  expect(issues.filter(i => ['date', 'once', 'thousands', 'rub'].includes(i[0]))).toEqual([]);
  expect(issues.filter(i => i[0] === 'br')).toEqual([['br', 'Разметка', 'Низкая']]);
  expect(issues.filter(i => i[0] === 'lostNum')).toEqual([['lostNum', 'Числа', 'Высокая']]);
  expectNoErrors(errors);
});
