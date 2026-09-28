// Глоссарий со словоформами и выгрузка исправленного .po.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, po, uploadPo, issuesByKey, expectNoErrors } = require('./helpers');

test('глоссарий понимает склонения в исходнике и в переводе', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['kk'] });
  await page.evaluate(() => {
    dbUpsert('glossaries', { id: 'g1', name: 'WB', projectId: 'p0', language: 'kk' });
    dbUpsert('glossaryTerms', { id: 't1', glossaryId: 'g1', term: 'корзина', approved: 'себет', forbidden: ['кәрзеңке'], status: 'Активен' });
    dbUpsert('glossaryTerms', { id: 't2', glossaryId: 'g1', term: 'книга', approved: 'кітап', forbidden: [], status: 'Активен' });
    dbUpsert('glossaryTerms', { id: 't3', glossaryId: 'g1', term: 'кот', approved: 'мысық', forbidden: [], status: 'Активен' });
  });
  await uploadPo(page, { lang: 'kk', text: po('kk', [
    ['inflected', 'Товар добавлен в корзину', 'Тауар себетке қосылды'],     // форма перевода — это не ошибка
    ['alternation', 'Обложка книги', 'Кітабы мұқабасы'],                   // п → б
    ['missing', 'В корзине пусто', 'Бұл жерде бос'],                        // термин из исходника в падеже, перевода нет
    ['forbidden', 'Корзина', 'Кәрзеңке'],
    ['substring', 'Который час?', 'Сағат нешеде?'],                        // «кот» внутри «который» — не термин
  ]) });
  const byKey = k => issuesByKey(page).then(list => list.filter(i => i.key === k && i.type === 'Терминология'));
  expect(await byKey('inflected')).toEqual([]);
  expect(await byKey('alternation')).toEqual([]);
  expect((await byKey('missing')).map(i => i.text).join()).toContain('себет');
  expect((await byKey('forbidden')).map(i => i.text).join()).toContain('запрещённый');
  expect(await byKey('substring')).toEqual([]);
  expectNoErrors(errors);
});

test('скачивание .po: меняются только исправленные строки, остальное как в оригинале', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['kk'] });
  const original = [
    '# Файл для теста',
    'msgid ""', 'msgstr ""', '"Language: kk\\n"', '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"', '',
    '#: src/cart.js:10', '#, fuzzy', 'msgctxt "cart.title"', 'msgid "Корзина"', 'msgstr "Себет  "', '',
    '#. комментарий переводчику', 'msgctxt "cart.empty"', 'msgid "Корзина пуста"', 'msgstr ""', '"Себет "', '"бос"', '',
    'msgctxt "items"', 'msgid "%d товар"', 'msgid_plural "%d товара"', 'msgstr[0] "%d тауар"', 'msgstr[1] "%d тауар"', '',
  ].join('\n');
  await uploadPo(page, { lang: 'kk', name: 'cart.po', text: original });

  // исправляем одну строку так же, как кнопка «Исправить»
  const issueId = await page.evaluate(() => dbList('issues').find(i => dbGet('rows', i.rowId).key === 'cart.title').id);
  await page.evaluate(id => openFixModal(id), issueId);
  await page.fill('#fixTarget', 'Себет');
  await page.evaluate(id => applyFix(id), issueId);

  await page.evaluate(() => { location.hash = '#/project/p0/folder/c0/files'; });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button[title="Скачать .po с исправлениями"]')]);
  expect(dl.suggestedFilename()).toBe('cart.po');
  const out = fs.readFileSync(await dl.path(), 'utf8');
  const expected = original
    .replace('#, fuzzy\n', '')                           // флаг fuzzy снимается с исправленной строки
    .replace('msgstr "Себет  "', 'msgstr "Себет"');
  expect(out).toBe(expected);
  expectNoErrors(errors);
});
