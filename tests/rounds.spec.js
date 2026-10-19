// Проверки (LQA одного языка на одной платформе): создание, экраны, ошибка со скриншотом, сдача и разбор.
const { test, expect } = require('@playwright/test');
const { openApp, seedProject, po, uploadPo, issuesByKey, expectNoErrors } = require('./helpers');

// 2×2 PNG — настоящий скриншот не нужен, важно, что картинка читается
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDGgAQYGBgB/2gEDjAXt8gAAAABJRU5ErkJggg==', 'base64');

test('проверка: экраны, ошибка со скриншотом, строка и глоссарий сами находятся, сдача и разбор', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { name: 'Магазин WB', langs: ['ka'], folder: 'iOS' });
  await uploadPo(page, { lang: 'ka', text: po('ka', [['tabbar.cart', 'Корзина', 'ყუთი'], ['order', 'Заказ', 'შეკვეთა']]) });
  await page.evaluate(() => {
    dbUpsert('glossaries', { id: 'g1', name: 'Магазин · ka', language: 'ka', projectId: 'p0' });
    dbUpsert('glossaryTerms', { id: 't1', glossaryId: 'g1', term: 'Корзина', approved: 'კალათა', forbidden: ['ყუთი'] });
    location.hash = '#/round/new';
  });

  await page.selectOption('#rfLang', 'ka');
  await page.click('#rfPlatform button:has-text("iOS")');
  await page.fill('#rfName', 'Релиз 7.42 — корзина');
  await page.selectOption('#rfFolder', 'c0');
  await page.fill('#rfCases', 'Корзина\nОформление заказа');
  await page.check('#rfSaveTpl');
  await page.click('button:has-text("Создать проверку")');
  await expect(page.locator('.project-hero')).toContainText('Грузинский · iOS');
  await expect(page.locator('.case-row')).toHaveCount(2);
  expect(await page.evaluate(() => getSettings().caseTemplates.iOS)).toBe('Корзина\nОформление заказа');
  await expect(page.locator('.round-side')).toContainText('2 строки');

  // ошибка к экрану «Корзина»: подсказки по строке и глоссарию
  await page.locator('.case-row', { hasText: 'Корзина' }).locator('button:has-text("Ошибка")').click();
  await page.setInputFiles('#rfShotPick input', { name: 'cart.png', mimeType: 'image/png', buffer: PNG });
  await page.fill('#rfNow', 'ყუთი');
  await expect(page.locator('#rfHints')).toContainText('tabbar.cart');
  await expect(page.locator('#rfHints')).toContainText('კალათა');
  await page.fill('#rfNeed', 'კალათა');
  await page.selectOption('#rfCat', '1.1');
  await page.click('#rfSev button:has-text("Высокая")');
  await page.click('.modal button:text-is("Сохранить")');
  await expect(page.locator('.round-err')).toHaveCount(1);
  const issue = await page.evaluate(() => dbList('issues').find(i => i.round));
  expect(issue.type).toBe('1.1 Терминология · Неверный термин');
  expect(issue.severity).toBe('Высокая');
  expect(issue.shotId).toBeTruthy();
  expect(await page.evaluate(id => dbGet('rows', id).key, issue.rowId)).toBe('tabbar.cart');
  await expect(page.locator('.round-err')).toContainText('Корзина');

  await page.locator('.case-row', { hasText: 'Корзина' }).locator('input[type=checkbox]').check();
  await expect(page.locator('.round-cases')).toContainText('1 из 2');

  await page.click('button:has-text("Сдать проверку")');
  await page.click('.dialog [data-ok]');
  await expect(page.locator('.round-flow .st.cur')).toContainText('Разбор');
  await page.click('.round-err button:has-text("Принять")');
  await page.click('button:has-text("Завершить")');
  await expect(page.locator('.project-hero .page-head')).not.toContainText('Завершить');
  await page.evaluate(() => { location.hash = '#/'; });
  await expect(page.locator('#content')).toContainText('Завершённые');
  await expect(page.locator('#content')).toContainText('1 из 1');
  expectNoErrors(errors);
});

test('языки: суффикс, приклеенный к переменной, грузинская «заглавная», азербайджанская İ в глоссарии', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['az', 'ka'] });
  await page.evaluate(() => {
    dbUpsert('glossaries', { id: 'g1', name: 'az', language: 'az', projectId: 'p0' });
    dbUpsert('glossaryTerms', { id: 't1', glossaryId: 'g1', term: 'Возврат', approved: 'iadə' });
  });
  await uploadPo(page, { lang: 'az', text: po('az', [['a', '%@ товаров', '%@ın məhsulları'], ['b', 'Из %1$s', '%1$sdən'], ['c', 'Привет, %s', 'Salam'], ['d', 'Возврат товара', 'İadə məhsulu']]) });
  await uploadPo(page, { lang: 'ka', name: 'ka.po', text: po('ka', [['e', 'Корзина', 'Კალათა'], ['f', 'КОРЗИНА', 'ᲙᲐᲚᲐᲗᲐ']]) });
  const issues = await issuesByKey(page);
  const of = k => issues.filter(i => i.key === k).map(i => i.type);
  expect(of('a')).not.toContain('Переменные');
  expect(of('b')).not.toContain('Переменные');
  expect(of('c')).toContain('Переменные');
  expect(of('d')).not.toContain('Терминология');
  expect(issues.find(i => i.key === 'e' && i.type === 'Правила языка').text).toContain('нет заглавных');
  expect(of('f')).not.toContain('Правила языка');
  expectNoErrors(errors);
});

test('глоссарии: пересечения между проектами — «Сделать правильным» и «Оба верны»; чужой глоссарий не участвует в проверке', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { name: 'Магазин WB', langs: ['ka'] });
  await page.evaluate(() => {
    dbUpsert('glossaries', { id: 'g1', name: 'Магазин', language: 'ka', projectId: 'p0' });
    dbUpsert('glossaries', { id: 'g2', name: 'Портал', language: 'ka', projectId: null, scope: 'Портал продавца' });
    dbUpsert('glossaryTerms', { id: 't1', glossaryId: 'g1', term: 'Корзина', approved: 'კალათა' });
    dbUpsert('glossaryTerms', { id: 't2', glossaryId: 'g2', term: 'корзина', approved: 'ყუთი' });
    dbUpsert('glossaryTerms', { id: 't3', glossaryId: 'g1', term: 'Заказ', approved: 'შეკვეთა' });
    dbUpsert('glossaryTerms', { id: 't4', glossaryId: 'g2', term: 'Заказ', approved: 'ბრძანება' });
    dbUpsert('glossaryTerms', { id: 't5', glossaryId: 'g1', term: 'Цена', approved: 'ფასი' });
    dbUpsert('glossaryTerms', { id: 't6', glossaryId: 'g2', term: 'Цена', approved: 'ფასი' });
  });
  await uploadPo(page, { lang: 'ka', text: po('ka', [['a', 'Корзина', 'კალათა']]) });
  expect((await issuesByKey(page)).filter(i => i.type === 'Терминология')).toEqual([]);

  await page.evaluate(() => { location.hash = '#/glossaries/overlaps'; });
  await expect(page.locator('.tabbtn.active')).toContainText('2');
  await expect(page.locator('.overlap')).toHaveCount(2);
  const cart = page.locator('.overlap', { hasText: 'Корзина' });
  await cart.locator('tr', { hasText: 'კალათა' }).locator('button:has-text("Сделать правильным")').click();
  await page.click('.dialog [data-ok]');
  expect(await page.evaluate(() => dbGet('glossaryTerms', 't2').approved)).toBe('კალათა');
  expect(await page.evaluate(() => dbGet('glossaryTerms', 't2').comment)).toContain('ყუთი');

  await page.locator('.overlap', { hasText: 'Заказ' }).locator('button:has-text("Оба верны")').click();
  await page.fill('#uiPromptInput', 'в портале другой смысл');
  await page.click('.dialog [data-ok]');
  await expect(page.locator('.overlap')).toHaveCount(0);
  await page.click('.chip:has-text("Решённые")');
  await expect(page.locator('.overlap')).toHaveCount(2);
  await page.click('.chip:has-text("Совпадают")');
  await expect(page.locator('.overlap')).toHaveCount(1);
  // переводы поменялись — решение больше не действует
  await page.evaluate(() => { const t = dbGet('glossaryTerms', 't4'); t.approved = 'შეკვეთის'; dbUpsert('glossaryTerms', t); });
  expect(await page.evaluate(() => openOverlapCount())).toBe(1);
  expectNoErrors(errors);
});

test('грузинский по редполитике: кавычки, валюта, переменная с послелогом, число + мн. ч., тире, «უნდა»', async ({ page }) => {
  const errors = await openApp(page);
  await seedProject(page, { langs: ['ka'] });
  await uploadPo(page, { lang: 'ka', text: po('ka', [
    ['q', 'Статус «В пути»', 'სტატუსი «გზაშია»'], ['cur', 'Цена: 100₽', 'ფასი: 100₾'], ['var', 'Выберите в %s', 'აირჩიეთ %s-ში'],
    ['pl', '5 товаров', '5 პროდუქტები'], ['dash', 'Заказ - в пути', 'შეკვეთა - გზაშია'], ['must', 'Вы должны ввести пароль', 'თქვენ უნდა შეიყვანოთ პაროლი'],
    ['ok', 'Выберите: %s', 'აირჩიეთ: %s'], ['ok2', '5 товаров за 100 ₽', '5 პროდუქტი 100 ₾-ად'],
  ]) });
  const issues = await issuesByKey(page);
  const rules = k => issues.filter(i => i.key === k && i.type === 'Правила языка').map(i => i.text).join(' | ');
  expect(rules('q')).toContain('„…“');
  expect(rules('cur')).toContain('после суммы');
  expect(rules('var')).toContain('послелог');
  expect(rules('pl')).toContain('единственном числе');
  expect(rules('dash')).toContain('Тире');
  expect(rules('must')).toContain('საჭიროა');
  expect(rules('ok')).toBe('');
  expect(rules('ok2')).toBe('');
  expectNoErrors(errors);
});
