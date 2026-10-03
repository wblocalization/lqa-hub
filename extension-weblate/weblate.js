// Выгрузка строк из Weblate в .po. Файл подключается на открытую вкладку Weblate (кнопкой расширения)
// и ходит в API Weblate с той же сессией, что у тебя в браузере, — ключ не нужен, если ты вошла.
// Никуда, кроме этой вкладки, данные не уходят: готовый файл скачивается здесь же.
(function () {
  if (self.lqaWeblate) return;

  const STATE = { empty: 0, fuzzy: 10, translated: 20, approved: 30, readonly: 100 };

  // где живёт Weblate и что открыто: /projects/<проект>/<компонент>/<язык>/, /translate/…, /projects/<проект>/-/<язык>/
  function parseLocation(href) {
    const u = new URL(href);
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const at = parts.findIndex(p => ['projects', 'translate', 'zen', 'browse', 'source', 'settings'].includes(p));
    const base = '/' + (at > 0 ? parts.slice(0, at).join('/') + '/' : '');
    const rest = at >= 0 ? parts.slice(at + 1) : [];
    return { origin: u.origin, base, project: rest[0] || '', rest: rest.slice(1) };
  }

  function makeApi(loc, token) {
    const root = loc.origin + loc.base + 'api/';
    async function get(path, tries = 0) {
      const url = /^https?:/.test(path) ? sameOrigin(path) : root + path;
      const res = await fetch(url, { credentials: 'include', headers: Object.assign({ Accept: 'application/json' }, token ? { Authorization: 'Token ' + token } : {}) });
      if (res.status === 429 && tries < 5) { await sleep((+res.headers.get('Retry-After') || 5) * 1000); return get(path, tries + 1); }
      if (res.status === 401 || res.status === 403) throw new Error('Weblate не пускает в API (' + res.status + '). Войди в Weblate в этом браузере или впиши API-ключ из своего профиля Weblate.');
      if (res.status === 404) { const e = new Error('не найдено: ' + url.replace(root, '')); e.notFound = true; throw e; }
      if (!res.ok) throw new Error('Weblate ответил ' + res.status + ' на ' + url.replace(root, ''));
      return res.json();
    }
    // ссылки «next» Weblate может отдавать с http:// за прокси — ходим всегда на свой адрес
    function sameOrigin(u) { const x = new URL(u); return loc.origin + x.pathname + x.search; }
    async function all(path, onPage) {
      const out = []; let next = path + (path.includes('?') ? '&' : '?') + 'page_size=1000';
      while (next) { const data = await get(next); (data.results || []).forEach(r => out.push(r)); if (onPage) onPage(out.length, data.count); next = data.next; }
      return out;
    }
    return { get, all, root };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const enc = s => encodeURIComponent(s);   // компонент в категории: «категория/компонент» → «категория%2Fкомпонент»

  // что открыто: проект, компонент (в т. ч. в категории), язык — проверяем по API, а не угадываем
  async function detect(href, token) {
    const loc = parseLocation(href);
    const api = makeApi(loc, token);
    try { await api.get(''); } catch (e) { if (e.notFound) return { weblate: false }; throw e; }
    const out = { weblate: true, origin: loc.origin, project: null, component: null, language: null };
    if (!loc.project) return out;
    const project = await api.get('projects/' + enc(loc.project) + '/').catch(() => null);
    if (!project) return out;
    out.project = { slug: project.slug, name: project.name };
    const rest = loc.rest;
    if (rest[0] === '-') { out.language = rest[1] || null; }
    else {
      for (let n = rest.length; n >= 1 && !out.component; n--) {
        const slug = rest.slice(0, n).join('/');
        const comp = await api.get('components/' + enc(project.slug) + '/' + enc(slug) + '/').catch(() => null);
        if (comp) { out.component = { slug, name: comp.name }; out.language = rest[n] || null; }
      }
    }
    out.components = await components(api, out.project.slug);
    out.languages = await languages(api, out.project.slug, null);   // языки всего проекта: можно выбрать несколько компонентов
    return out;
  }
  // компоненты проекта без глоссариев; у компонента в категории путь «категория/компонент»
  async function components(api, project) {
    const list = await api.all('projects/' + enc(project) + '/components/');
    const cats = {};
    const catPath = async url => {
      if (!url) return '';
      if (!(url in cats)) {
        cats[url] = '';
        try { const c = await api.get(url); cats[url] = (c.category ? await catPath(c.category) + '/' : '') + c.slug; } catch (e) {}
      }
      return cats[url];
    };
    const out = [];
    for (const c of list) {
      if (c.is_glossary) continue;
      const cat = await catPath(c.category);
      out.push({ slug: (cat ? cat + '/' : '') + c.slug, name: (cat ? cat + ' / ' : '') + c.name });
    }
    return out;
  }
  async function languages(api, project, component) {
    if (component) {
      const list = await api.all('components/' + enc(project) + '/' + enc(component) + '/translations/');
      return list.map(t => ({ code: t.language_code || (t.language && t.language.code), name: t.language && t.language.name, translated: t.translated_percent, isSource: !!t.is_source }));
    }
    const list = await api.get('projects/' + enc(project) + '/languages/').catch(() => []);
    return (Array.isArray(list) ? list : list.results || []).map(l => ({ code: l.code, name: l.name, translated: l.translated_percent }));
  }

  /* ---------- .po ---------- */
  const q = s => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  function poHeader(lang, plural, project) {
    const lines = ['Project-Id-Version: ' + project, 'Language: ' + lang, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit'];
    if (plural && plural.number && plural.formula) lines.push('Plural-Forms: nplurals=' + plural.number + '; plural=(' + plural.formula + ');');
    lines.push('X-Generator: LQA Hub — выгрузка из Weblate');
    return 'msgid ""\nmsgstr ""\n' + lines.map(l => q(l + '\n')).join('\n') + '\n';
  }
  function poEntry(u, ctx, fuzzy) {
    const src = Array.isArray(u.source) ? u.source : [u.source || ''];
    const tgt = Array.isArray(u.target) ? u.target : [u.target || ''];
    const out = [];
    [u.explanation, u.note].filter(Boolean).forEach(t => String(t).split('\n').forEach(l => out.push('#. ' + l)));
    if (u.location) out.push('#: ' + String(u.location).replace(/\s*,\s*/g, ' '));
    if (fuzzy) out.push('#, fuzzy');
    if (ctx) out.push('msgctxt ' + q(ctx));
    out.push('msgid ' + q(src[0]));
    if (src.length > 1) {
      out.push('msgid_plural ' + q(src[1]));
      const n = Math.max(tgt.length, 2);
      for (let i = 0; i < n; i++) out.push('msgstr[' + i + '] ' + q(tgt[i] || ''));
    } else out.push('msgstr ' + q(tgt[0]));
    return out.join('\n');
  }
  const stateOf = u => typeof u.state === 'number' ? u.state : u.approved ? STATE.approved : u.translated ? STATE.translated : u.fuzzy ? STATE.fuzzy : STATE.empty;
  const hasText = u => (Array.isArray(u.target) ? u.target : [u.target]).some(t => String(t || '').trim());

  /* ---------- export ----------
     opts: {href, token, project, components:[slug]|'all', languages:[code], strings:'translated'|'fuzzy'|'all', split:true|false, download}
     На каждый язык — свой файл; split — ещё и отдельный файл на каждый компонент.
     Возвращает {files:[{name, text, count}], total} — для проверки и чтобы показать итог. */
  async function exportPo(opts, progress) {
    const loc = parseLocation(opts.href);
    const api = makeApi(loc, opts.token);
    const say = progress || (() => {});
    const project = opts.project;
    let comps = opts.components;
    if (comps === 'all') { say('Список компонентов…'); comps = (await components(api, project)).map(c => c.slug); }
    const langs = opts.languages || [opts.language];
    const files = [], skipped = []; let total = 0;
    for (let li = 0; li < langs.length; li++) {
      const r = await exportLanguage(api, Object.assign({}, opts, { language: langs[li] }), comps, (t) => say((langs.length > 1 ? langs[li] + ' (' + (li + 1) + ' из ' + langs.length + ') · ' : '') + t));
      r.files.forEach(f => files.push(f)); r.skipped.forEach(x => skipped.push(langs[li] + ': ' + x)); total += r.total;
    }
    if (opts.download !== false) for (const f of files) { download(f.name, f.text); await sleep(400); }
    return { files: files.map(f => opts.download === false ? f : { name: f.name, count: f.count }), total, skipped };
  }
  async function exportLanguage(api, opts, comps, say) {
    const project = opts.project;
    const query = opts.strings === 'translated' ? 'state:>=translated' : opts.strings === 'fuzzy' ? 'state:>=needs-editing' : '';
    const minState = opts.strings === 'translated' ? STATE.translated : opts.strings === 'fuzzy' ? STATE.fuzzy : STATE.empty;
    const parts = [], skipped = []; let plural = null, total = 0;
    for (let i = 0; i < comps.length; i++) {
      const comp = comps[i];
      const base = 'translations/' + enc(project) + '/' + enc(comp) + '/' + enc(opts.language) + '/';
      say('Компонент ' + (i + 1) + ' из ' + comps.length + ': ' + comp);
      let info;
      try { info = await api.get(base); } catch (e) { if (e.notFound) { skipped.push(comp); continue; } throw e; }
      if (!plural && info.language && info.language.plural) plural = info.language.plural;
      const units = await api.all(base + 'units/' + (query ? '?q=' + enc(query) : ''), (n, count) => say('Компонент ' + (i + 1) + ' из ' + comps.length + ': ' + comp + ' — ' + n + (count ? ' из ' + count : '') + ' строк'));
      // «только для чтения» с текстом — это готовый перевод
      const level = u => { const st = stateOf(u); return st === STATE.readonly ? (hasText(u) ? STATE.translated : STATE.empty) : st; };
      const keep = units.filter(u => level(u) >= minState && (opts.strings === 'all' || hasText(u)));
      parts.push({ comp, units: keep });
      total += keep.length;
    }
    // один файл на всё: одинаковые строки из разных компонентов различаются по msgctxt
    const files = [];
    const build = list => {
      const seen = new Set(), entries = [];
      list.forEach(({ comp, units }) => units.forEach(u => {
        const src0 = Array.isArray(u.source) ? u.source[0] : u.source;
        let ctx = u.context || '';
        if (seen.has(ctx + '\u0004' + src0)) ctx = comp + (ctx ? '/' + ctx : '');
        seen.add(ctx + '\u0004' + src0);
        entries.push(poEntry(u, ctx, stateOf(u) === STATE.fuzzy));
      }));
      return poHeader(opts.language, plural, project) + (entries.length ? '\n' + entries.join('\n\n') + '\n' : '');
    };
    const safe = s => String(s).replace(/[\\/:*?"<>|]+/g, '_');
    if (!parts.length) return { files, total, skipped };
    if (opts.split && parts.length > 1) parts.forEach(p => files.push({ name: safe(project + '_' + p.comp + '_' + opts.language) + '.po', text: build([p]), count: p.units.length }));
    else files.push({ name: safe(project + (comps.length === 1 ? '_' + comps[0] : '') + '_' + opts.language) + '.po', text: build(parts), count: total });
    return { files, total, skipped };
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/x-gettext-translation;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // полоска с ходом выгрузки прямо на странице: видно, даже если окошко расширения закрылось
  function banner(text, done) {
    let el = document.getElementById('lqa-weblate-banner');
    if (!el) {
      el = document.createElement('div'); el.id = 'lqa-weblate-banner';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:12px 16px;border-radius:12px;background:#4c1d95;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      document.body.appendChild(el);
    }
    el.textContent = 'LQA Hub · ' + text;
    if (done) setTimeout(() => el.remove(), 6000);
  }

  self.lqaWeblate = { parseLocation, detect, exportPo, poEntry, poHeader, banner };
})();
