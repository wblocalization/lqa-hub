// Общие помощники для тестов: открыть платформу, создать проект, загрузить .po.
const path = require('path');
const { expect } = require('@playwright/test');

const APP_URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

// Открывает платформу с чистыми данными: без тура для новичка, с заменой CDN, если задан LQA_CDN.
async function openApp(page, hash = '#/') {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ cdn, tessdata }) => {
    try { localStorage.setItem('lqa_tour_done', '1'); } catch (e) {}
    if (cdn) window.LQA_CDN = cdn;
    if (tessdata) window.LQA_TESSDATA = tessdata;
  }, { cdn: process.env.LQA_CDN || '', tessdata: process.env.LQA_TESSDATA || '' });
  await page.goto(APP_URL + hash);
  await page.waitForFunction(() => typeof dbList === 'function' && document.querySelector('.side-link'));
  return errors;
}

// Проект с одной папкой; языки — массив кодов.
async function seedProject(page, { id = 'p0', name = 'WB', langs = ['kk'], folder = 'web' } = {}) {
  await page.evaluate(({ id, name, langs, folder }) => {
    dbUpsert('projects', { id, name, languages: langs.map(code => ({ code, name: languageLabel(code) })) });
    dbUpsert('components', { id: 'c0', projectId: id, name: folder });
  }, { id, name, langs, folder });
}

// Собирает .po: пары [ключ, исходник, перевод].
function po(lang, pairs) {
  const q = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `msgid ""\nmsgstr ""\n"Language: ${lang}\\n"\n\n` +
    pairs.map(([k, s, t]) => `msgctxt "${q(k)}"\nmsgid "${q(s)}"\nmsgstr "${q(t)}"\n`).join('\n');
}

// Загружает .po в папку так же, как кнопка на странице «Файлы».
async function uploadPo(page, { projectId = 'p0', folderId = 'c0', lang = 'kk', name, text }) {
  await page.evaluate(h => { location.hash = h; }, `#/project/${projectId}/folder/${folderId}/files`);
  await page.waitForSelector('#folderUploadStatus', { state: 'attached' });
  await page.evaluate(async ({ projectId, folderId, lang, name, text }) => {
    await handleFolderPoFiles(projectId, folderId, [{ name: name || lang + '.po', languageCode: lang, source: text }]);
  }, { projectId, folderId, lang, name, text });
}

// Проблемы с ключом строки: [{key, type, severity, text, status}]
async function issuesByKey(page) {
  return page.evaluate(() => dbList('issues').map(i => {
    const r = i.rowId ? dbGet('rows', i.rowId) : null;
    return { key: r ? r.key : null, type: i.type, severity: i.severity, text: i.text, status: i.status };
  }));
}

function expectNoErrors(errors) { expect(errors, 'ошибки JavaScript на странице').toEqual([]); }

module.exports = { APP_URL, openApp, seedProject, po, uploadPo, issuesByKey, expectNoErrors };
