// Окошко расширения: смотрит, какой проект Weblate открыт во вкладке, даёт выбрать языки и компоненты
// и запускает выгрузку на самой вкладке (weblate.js) — там есть твой вход в Weblate.
const $ = id => document.getElementById(id);
let tab = null, info = null;

const run = (func, args) => chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }).then(r => r[0] && r[0].result);
const inject = () => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['weblate.js'] });
const getToken = () => chrome.storage.local.get('tokens').then(x => ((x.tokens || {})[new URL(tab.url).origin]) || '');
async function saveToken(t) {
  const x = await chrome.storage.local.get('tokens'); const tokens = x.tokens || {};
  if (t) tokens[new URL(tab.url).origin] = t; else delete tokens[new URL(tab.url).origin];
  await chrome.storage.local.set({ tokens });
}
function msg(text, kind) { const m = $('msg'); m.textContent = text; m.className = 'msg' + (kind ? ' ' + kind : ''); }
function empty(text) { $('where').textContent = 'Weblate не найден'; $('main').hidden = true; const e = $('empty'); e.hidden = false; e.textContent = text; }

function checkList(el, items, checked) {
  el.innerHTML = '';
  items.forEach(it => {
    const l = document.createElement('label'); l.dataset.search = (it.label + ' ' + it.value).toLowerCase();
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = it.value; cb.checked = checked.includes(it.value);
    const t = document.createElement('span'); t.textContent = it.label;
    l.append(cb, t);
    if (it.extra) { const p = document.createElement('span'); p.className = 'pct'; p.textContent = it.extra; l.append(p); }
    el.append(l);
  });
}
const picked = el => [...el.querySelectorAll('input:checked')].map(x => x.value);
function filterList(input, el) { input.addEventListener('input', () => { const q = input.value.trim().toLowerCase(); el.querySelectorAll('label').forEach(l => { l.hidden = q && !l.dataset.search.includes(q); }); }); }
const setAll = (el, on) => el.querySelectorAll('label:not([hidden]) input').forEach(x => { x.checked = on; });

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) return empty('Открой Weblate во вкладке — страницу проекта, компонента или перевода — и нажми на расширение ещё раз.');
  const token = await getToken();
  $('token').value = token;
  try {
    await inject();
    info = await run((href, token) => self.lqaWeblate.detect(href, token).catch(e => ({ error: e.message })), [tab.url, token]);
  } catch (e) { return empty('На этой вкладке расширение не может работать: ' + e.message); }
  if (!info || info.error) return empty(info ? info.error : 'Не получилось прочитать страницу.');
  if (!info.weblate) return empty('Это не Weblate. Открой Weblate во вкладке — страницу проекта, компонента или перевода — и нажми на расширение ещё раз.');
  if (!info.project) return empty('Открой в Weblate нужный проект (или его компонент) и нажми на расширение ещё раз.');
  $('where').textContent = info.project.name + (info.component ? ' · ' + info.component.name : '') + (info.language ? ' · ' + info.language : '');
  checkList($('langs'), (info.languages || []).map(l => ({ value: l.code, label: (l.name || l.code) + ' (' + l.code + ')', extra: l.translated != null ? Math.round(l.translated) + '%' : '' })), info.language ? [info.language] : []);
  checkList($('comps'), (info.components || []).map(c => ({ value: c.slug, label: c.name })), info.component ? [info.component.slug] : (info.components || []).map(c => c.slug));
  $('main').hidden = false;
}

$('langAll').onclick = () => setAll($('langs'), true);
$('compAll').onclick = () => setAll($('comps'), true);
$('compNone').onclick = () => setAll($('comps'), false);
filterList($('langFilter'), $('langs'));
filterList($('compFilter'), $('comps'));
chrome.runtime.onMessage.addListener(m => { if (m && m.lqaWeblate) msg(m.lqaWeblate); });

$('go').onclick = async () => {
  const languages = picked($('langs')), comps = picked($('comps'));
  if (!languages.length) return msg('Выбери хотя бы один язык', 'err');
  if (!comps.length) return msg('Выбери хотя бы один компонент', 'err');
  const token = $('token').value.trim();
  await saveToken(token);
  const opts = {
    href: tab.url, token, project: info.project.slug, languages,
    components: comps.length === (info.components || []).length ? 'all' : comps,
    strings: document.querySelector('input[name=strings]:checked').value,
    split: document.querySelector('input[name=split]:checked').value === 'each',
  };
  $('go').disabled = true; msg('Начинаю…');
  try {
    await inject();
    const r = await run(opts => {
      const W = self.lqaWeblate;
      const say = t => { W.banner(t); try { chrome.runtime.sendMessage({ lqaWeblate: t }); } catch (e) {} };
      return W.exportPo(opts, say).then(res => { W.banner('Готово: ' + res.total + ' строк, файлов: ' + res.files.length, true); return res; },
        e => { W.banner('Ошибка: ' + e.message, true); return { error: e.message }; });
    }, [opts]);
    if (!r || r.error) msg('Не получилось: ' + (r ? r.error : 'вкладка не ответила'), 'err');
    else if (!r.files.length) msg('В выбранных компонентах нет таких языков' + (r.skipped.length ? ': ' + r.skipped.join(', ') : ''), 'err');
    else msg('Готово: ' + r.total + ' строк → ' + r.files.map(f => f.name + ' (' + f.count + ')').join(', ') + (r.skipped.length ? '\nНет перевода на этот язык: ' + r.skipped.join(', ') : '') + '\nФайлы в «Загрузках» — их можно сразу загрузить в LQA Hub.', 'ok');
  } catch (e) { msg('Не получилось: ' + e.message, 'err'); }
  $('go').disabled = false;
};

load();
