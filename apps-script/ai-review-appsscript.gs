/**
 * LQA Hub — ИИ-backend для Google Apps Script.
 *
 * Хранит ключ API у себя (в свойствах скрипта), принимает запросы от платформы
 * и возвращает найденные проблемы. Ключ никогда не попадает в браузер.
 *
 * Режимы запроса (поле `mode`):
 *   - 'ping'    — проверка подключения из Настроек платформы;
 *   - 'visual'  — проверка одного скриншота (картинка → проблемы с рамками);
 *   - 'summary' — общий вывод по сессии скриншотов (список проблем → короткий разбор);
 *   - 'styleguide' — прочитать редполитику (ссылка на Google Документ или текст) и сказать, сколько вышло;
 *   - 'sync'    — командное хранилище: браузер отправляет свои изменения и получает чужие.
 *                 Данные лежат на Google Диске в папке «LQA Hub — данные» (или DATA_FOLDER_ID).
 *   - без mode  — проверка пачки строк перевода (как раньше).
 *
 * Настройка — Project Settings → Script Properties (подробно в README.md рядом):
 *   PROVIDER           anthropic | openai            (по умолчанию anthropic)
 *   ANTHROPIC_API_KEY  ключ Claude API               (если PROVIDER=anthropic)
 *   OPENAI_API_KEY     ключ OpenAI API               (если PROVIDER=openai)
 *   MODEL              необязательно: своя модель вместо модели по умолчанию
 *   ACCESS_TOKEN       необязательно, но очень желательно: тот же текст вписывается
 *                      в Настройках платформы, без него backend не отвечает чужим
 *   DATA_FOLDER_ID     необязательно: id папки Google Диска для командного хранилища
 *   ADMIN_EMAILS       необязательно: почты администраторов через запятую. Если задано, данные отдаются
 *                      только тем, кто вошёл через Google с почтой из списка доступа (ключ доступа
 *                      тогда не нужен). Список доступа администраторы ведут в хабе: Настройки → Доступ
 *   GOOGLE_CLIENT_ID   Client ID входа через Google (тот же, что в хабе) — вход из чужих приложений не примется
 *   ALLOWED_EMAILS     список доступа; заполняется из хаба, вручную менять не нужно
 *
 * Командное хранилище работает и без ключа ИИ — PROVIDER/ключи нужны только для ИИ-проверок.
 */

var DEFAULT_MODELS = { anthropic: 'claude-opus-5', openai: 'gpt-4o-mini' };

var SEVERITIES = ['Критическая', 'Высокая', 'Средняя', 'Низкая'];
var TEXT_TYPES = ['Смысл', 'Точность перевода', 'Терминология', 'Грамматика', 'Стиль', 'Пропуск', 'Добавление', 'Согласованность'];
var VISUAL_TYPES = ['Обрезанный текст', 'Не помещается / наезжает', 'Не переведено', 'Смешение языков', 'Видна переменная / тег / ключ',
  'Формат числа, даты, валюты', 'Склонение / множественное число', 'Шрифт / символы', 'Вёрстка', 'Бренд / глоссарий', 'Смысл / перевод', 'Другое'];

/* ---------------- entry point ---------------- */

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var cfg = readConfig_();
    var who = null;
    if (cfg.admins.length) {
      // access by approved Google accounts: the sign-in Google gave the browser is checked with Google itself
      who = verifyGoogleSignIn_(req.idToken, cfg);
      if (who.error) return json_({ error: who.error, code: who.code, auth: 'google', clientId: cfg.clientId });
      if (!isAllowed_(who.email, cfg)) return json_({ error: 'Почты ' + who.email + ' нет в списке доступа — попроси менеджера добавить её', code: 'not_allowed', auth: 'google', email: who.email, clientId: cfg.clientId });
    } else if (cfg.accessToken && req.token !== cfg.accessToken) {
      return json_({ error: 'Неверный ключ доступа — проверь поле «Ключ доступа» в Настройках платформы' });
    }
    if (req.mode === 'ping') {
      return json_({ ok: true, provider: cfg.provider, model: pickModel_(cfg, req.model), aiKey: !!cfg.apiKey, sync: true,
        auth: cfg.admins.length ? 'google' : 'token', email: who ? who.email : null, admin: who ? isAdmin_(who.email, cfg) : false });
    }
    if (req.mode === 'access') {
      return json_(access_(req, cfg, who));
    }
    if (req.mode === 'styleguide') {
      var guide = styleGuideText_(req.styleGuide);
      return json_({ ok: true, chars: guide.length, preview: guide.slice(0, 300) });
    }
    if (req.mode === 'sync') {
      return json_(sync_(req));
    }
    if (req.mode === 'visual') {
      return json_({ findings: reviewScreenshot_(cfg, req) });
    }
    if (req.mode === 'summary') {
      return json_(summarizeSession_(cfg, req));
    }
    return json_({ results: reviewRows_(cfg, req) });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, message: 'LQA Hub AI backend работает. Платформа обращается сюда POST-запросами.' });
}

/* ---------------- access by Google account ----------------
   With ADMIN_EMAILS set, every request must carry the ID token Google gave the browser at sign-in.
   The token is checked by Google's tokeninfo endpoint (signature, expiry, audience = our Client ID),
   then the e-mail is looked up in the approved list. Admins are always allowed and edit the list. */

function emailList_(v) {
  return String(v || '').split(/[\s,;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(function (x) { return x.indexOf('@') > 0; });
}
function allowedEmails_() { return emailList_(PropertiesService.getScriptProperties().getProperty('ALLOWED_EMAILS')); }
function isAdmin_(email, cfg) { return cfg.admins.indexOf(String(email || '').toLowerCase()) >= 0; }
function isAllowed_(email, cfg) { return isAdmin_(email, cfg) || allowedEmails_().indexOf(String(email || '').toLowerCase()) >= 0; }

function verifyGoogleSignIn_(idToken, cfg) {
  if (!idToken) return { error: 'Войди через Google — доступ к данным только по одобренным почтам', code: 'auth_required' };
  var cache = CacheService.getScriptCache();
  var key = 'idt_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 40);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { error: 'Вход через Google истёк — войди ещё раз', code: 'auth_expired' };
  var info = JSON.parse(res.getContentText());
  if (cfg.clientId && info.aud !== cfg.clientId) return { error: 'Вход выполнен для другого приложения', code: 'auth_required' };
  if (String(info.email_verified) !== 'true' || !info.email) return { error: 'Google не подтвердил почту', code: 'auth_required' };
  var left = Number(info.exp) - Math.floor(Date.now() / 1000);
  if (!(left > 0)) return { error: 'Вход через Google истёк — войди ещё раз', code: 'auth_expired' };
  var who = { email: String(info.email).toLowerCase() };
  cache.put(key, JSON.stringify(who), Math.max(1, Math.min(left, 600)));
  return who;
}

// {action:'get'} — the list and who is asking; {action:'set', allowed:[…]} — admins only
function access_(req, cfg, who) {
  if (!cfg.admins.length) return { auth: 'token', admins: [], allowed: [], admin: false };
  if (req.action === 'set') {
    if (!isAdmin_(who.email, cfg)) return { error: 'Менять список может только администратор (ADMIN_EMAILS в свойствах скрипта)' };
    var list = emailList_((req.allowed || []).join(','));
    PropertiesService.getScriptProperties().setProperty('ALLOWED_EMAILS', list.join(','));
  }
  return { auth: 'google', admins: cfg.admins, allowed: allowedEmails_(), email: who.email, admin: isAdmin_(who.email, cfg) };
}

/* ---------------- config ---------------- */

function readConfig_() {
  var p = PropertiesService.getScriptProperties();
  var provider = String(p.getProperty('PROVIDER') || 'anthropic').trim().toLowerCase();
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error('PROVIDER должен быть anthropic или openai');
  var key = provider === 'anthropic' ? p.getProperty('ANTHROPIC_API_KEY') : p.getProperty('OPENAI_API_KEY');
  return {
    provider: provider,
    apiKey: String(key || '').trim(),
    model: String(p.getProperty('MODEL') || '').trim(),
    accessToken: String(p.getProperty('ACCESS_TOKEN') || '').trim(),
    // ADMIN_EMAILS turns on access by Google accounts; the approved list itself is edited from the hub
    admins: emailList_(p.getProperty('ADMIN_EMAILS')),
    clientId: String(p.getProperty('GOOGLE_CLIENT_ID') || '').trim()
  };
}

// MODEL из свойств скрипта важнее всего; модель из Настроек платформы берём, только если
// она от того же провайдера (старое значение gpt-4o-mini не сломает режим Claude).
function pickModel_(cfg, requested) {
  if (cfg.model) return cfg.model;
  requested = String(requested || '').trim();
  var isClaude = /^claude/i.test(requested);
  if (requested && (cfg.provider === 'anthropic') === isClaude) return requested;
  return DEFAULT_MODELS[cfg.provider];
}

/* ---------------- screenshot check ---------------- */

function reviewScreenshot_(cfg, req) {
  var m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(String(req.image || ''));
  if (!m) throw new Error('Не пришла картинка (ожидается data URL PNG/JPEG/WebP)');
  var glossary = (req.glossary || []).slice(0, 300).map(function (t) { return '- ' + t.term + ' → ' + t.approved; }).join('\n');

  var prompt = [
    'Ты — эксперт по проверке качества локализации (LQA) интерфейсов маркетплейса.',
    'Перед тобой скриншот страницы «' + (req.page || '') + '»' + (req.pageUrl ? ' (' + req.pageUrl + ')' : '') +
      ', интерфейс должен быть на языке: ' + (req.languageName || req.language) + ' (' + req.language + ').',
    '',
    'Найди проблемы локализации, которые видны на экране:',
    '- обрезанный текст, многоточие вместо конца фразы, текст не помещается в кнопку или наезжает на соседние элементы;',
    '- непереведённый текст (например, русский в казахском интерфейсе), смешение языков или алфавитов;',
    '- видимые переменные, теги или ключи перевода ({count}, %s, <b>, catalog.menu.title);',
    '- неверные для языка и страны форматы чисел, дат и валюты;',
    '- ошибки склонения и множественного числа («5 товар»);',
    '- квадратики и битые символы вместо букв, поломанная вёрстка;',
    '- нарушения глоссария и явные ошибки перевода.',
    'Не придумывай проблем: пользовательский контент (названия товаров продавцов, отзывы) и бренды оставляй в покое,',
    'если только в них не видно технической ошибки. Если проблем нет — верни пустой список.',
    '',
    'Для каждой проблемы укажи:',
    '- type — один из: ' + VISUAL_TYPES.join('; '),
    '- severity — одна из: ' + SEVERITIES.join(', '),
    '- text — коротко по-русски, что не так;',
    '- found — текст на экране ровно как написан (пустая строка, если текста нет);',
    '- expected — как должно быть (пустая строка, если не знаешь);',
    '- box — рамка вокруг проблемного места в долях от размера картинки: x, y — левый верхний угол, w, h — ширина и высота, всё от 0 до 1.',
    glossary ? '\nУтверждённые термины глоссария (термин → перевод):\n' + glossary : '',
    req.instructions ? '\nДополнительно: ' + req.instructions : '',
    styleGuidesPrompt_(req.styleGuides, [req.language])
  ].join('\n');

  var schema = {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: VISUAL_TYPES },
            severity: { type: 'string', enum: SEVERITIES },
            text: { type: 'string' },
            found: { type: 'string' },
            expected: { type: 'string' },
            box: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
              required: ['x', 'y', 'w', 'h'],
              additionalProperties: false
            }
          },
          required: ['type', 'severity', 'text', 'found', 'expected', 'box'],
          additionalProperties: false
        }
      }
    },
    required: ['findings'],
    additionalProperties: false
  };

  var out = askModel_(cfg, req.model, prompt, { mediaType: m[1], data: m[2] }, schema);
  return (out.findings || []).map(function (f) {
    return { type: f.type, severity: f.severity, text: f.text, found: f.found || '', expected: f.expected || '', box: clampBox_(f.box) };
  });
}

function clampBox_(b) {
  if (!b) return null;
  var c = function (v) { v = Number(v); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
  // some models answer in percent — normalise that too
  if ([b.x, b.y, b.w, b.h].some(function (v) { return Number(v) > 1.5; })) b = { x: b.x / 100, y: b.y / 100, w: b.w / 100, h: b.h / 100 };
  return { x: c(b.x), y: c(b.y), w: c(b.w), h: c(b.h) };
}

/* ---------------- style guides ----------------
   Редполитика языка — ссылка на Google Документ или просто текст. Документ читается от имени владельца
   скрипта (ему нужен доступ на чтение) и кэшируется на 6 часов. */

var STYLE_GUIDE_MAX = 30000;

function styleGuideText_(value) {
  value = String(value || '').trim();
  if (!value) return '';
  var m = /docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/.exec(value);
  if (!m) return value.slice(0, STYLE_GUIDE_MAX);
  var cache = CacheService.getScriptCache(), key = 'sg_' + m[1];
  var hit = cache.get(key);
  if (hit !== null) return hit;
  var text;
  try {
    text = DocumentApp.openById(m[1]).getBody().getText();
  } catch (err) {
    throw new Error('Не получилось открыть редполитику: дай доступ на чтение аккаунту, от которого развёрнут скрипт, ' +
      'и проверь, что это Google Документ, а не загруженный .docx (Файл → Сохранить как Google Документ)');
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim().slice(0, STYLE_GUIDE_MAX);
  try { cache.put(key, text, 21600); } catch (e) {}
  return text;
}

// {kk: 'https://docs.google.com/…', az: 'текст'} → блок для промпта по языкам, которые есть в запросе
function styleGuidesPrompt_(guides, langs) {
  if (!guides) return '';
  var parts = [];
  langs.forEach(function (lang) {
    var text = styleGuideText_(guides[String(lang || '').toLowerCase()]);
    if (text) parts.push('Редполитика для языка ' + lang + ' — проверяй стиль, обращение, термины и оформление по ней:\n' + text);
  });
  return parts.length ? '\n' + parts.join('\n\n') : '';
}

/* ---------------- team storage (sync) ----------------
   Каждая таблица платформы — файл <таблица>.json в папке данных:
     {records:{id:запись}, revs:{id:номер}, deleted:{id:номер}}
   Номер (SYNC_REV в свойствах скрипта) растёт с каждым изменением; браузер присылает свои
   изменения и номер, до которого он уже всё знает, и получает всё, что новее.
   Картинки скриншотов (таблица visualShotImages) лежат отдельными файлами, чтобы не
   переписывать мегабайты при каждом изменении. */

var BLOB_TABLES = { visualShotImages: true };

function sync_(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var folder = dataFolder_();
    var props = PropertiesService.getScriptProperties();
    var rev = Number(props.getProperty('SYNC_REV') || 0);
    var push = req.push || {};
    var pushedIds = {};
    Object.keys(push).forEach(function (t) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(t)) throw new Error('Неверное имя таблицы: ' + t);
      var store = readTable_(folder, t);
      pushedIds[t] = {};
      (push[t].upserts || []).forEach(function (rec) {
        if (!rec || rec.id == null) return;
        var id = String(rec.id);
        rev++;
        if (BLOB_TABLES[t]) { writeBlob_(folder, t, id, rec); store.records[id] = { id: id, _blob: true }; }
        else store.records[id] = rec;
        store.revs[id] = rev; delete store.deleted[id];
        pushedIds[t][id] = true;
      });
      (push[t].deletes || []).forEach(function (id) {
        id = String(id);
        rev++;
        if (BLOB_TABLES[t]) deleteBlob_(folder, t, id);
        delete store.records[id]; store.revs[id] = rev; store.deleted[id] = rev;
        pushedIds[t][id] = true;
      });
      writeTable_(folder, t, store);
    });
    props.setProperty('SYNC_REV', String(rev));

    var changes = {};
    if (req.pull !== false) {
      var since = Number(req.since || 0);
      listTables_(folder).forEach(function (t) {
        var store = readTable_(folder, t), ups = [], dels = [];
        Object.keys(store.revs).forEach(function (id) {
          if (store.revs[id] <= since || (pushedIds[t] && pushedIds[t][id])) return;
          if (store.deleted[id]) dels.push(id);
          else if (store.records[id]) ups.push(BLOB_TABLES[t] ? readBlob_(folder, t, id) : store.records[id]);
        });
        ups = ups.filter(function (x) { return x; });
        if (ups.length || dels.length) changes[t] = { upserts: ups, deletes: dels };
      });
    }
    return { rev: rev, changes: changes };
  } finally {
    lock.releaseLock();
  }
}

function dataFolder_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('DATA_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var it = DriveApp.getFoldersByName('LQA Hub — данные');
  var f = it.hasNext() ? it.next() : DriveApp.createFolder('LQA Hub — данные');
  p.setProperty('DATA_FOLDER_ID', f.getId());
  return f;
}
function fileIn_(folder, name) { var it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; }
function readTable_(folder, t) {
  var f = fileIn_(folder, t + '.json');
  if (!f) return { records: {}, revs: {}, deleted: {} };
  var d = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
  d.records = d.records || {}; d.revs = d.revs || {}; d.deleted = d.deleted || {};
  return d;
}
function writeTable_(folder, t, store) {
  var text = JSON.stringify(store), f = fileIn_(folder, t + '.json');
  if (f) f.setContent(text); else folder.createFile(t + '.json', text, 'application/json');
}
function listTables_(folder) {
  var out = [], it = folder.getFiles();
  while (it.hasNext()) { var n = it.next().getName(); if (/^[A-Za-z][A-Za-z0-9]*\.json$/.test(n)) out.push(n.replace(/\.json$/, '')); }
  return out;
}
function blobFolder_(folder, t) { var it = folder.getFoldersByName(t); return it.hasNext() ? it.next() : folder.createFolder(t); }
function writeBlob_(folder, t, id, rec) {
  var bf = blobFolder_(folder, t), f = fileIn_(bf, id + '.json'), text = JSON.stringify(rec);
  if (f) f.setContent(text); else bf.createFile(id + '.json', text, 'application/json');
}
function readBlob_(folder, t, id) { var f = fileIn_(blobFolder_(folder, t), id + '.json'); return f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : null; }
function deleteBlob_(folder, t, id) { var f = fileIn_(blobFolder_(folder, t), id + '.json'); if (f) f.setTrashed(true); }

/* ---------------- session summary ---------------- */

function summarizeSession_(cfg, req) {
  var items = (req.findings || []).slice(0, 300).map(function (f, n) {
    return (n + 1) + '. [' + f.severity + '; ' + f.type + '; ' + (f.screen || '') + '] ' + f.text +
      (f.found ? ' — на экране: «' + f.found + '»' : '') + (f.expected ? ' → «' + f.expected + '»' : '') + (f.status ? ' (статус: ' + f.status + ')' : '');
  }).join('\n');
  var prompt = [
    'Ты — ведущий специалист по качеству локализации. Ниже проблемы, найденные на скриншотах страницы «' + (req.page || '') + '»',
    'на языке ' + (req.languageName || req.language) + ' (' + req.language + '). Скриншотов: ' + (req.shots || '?') + '.',
    '',
    'Напиши по-русски короткий разбор для команды:',
    '- summary — 2–4 предложения: общее состояние страницы и главные закономерности (например, «системно обрезаются кнопки в карточках товара», «валюта не локализована»);',
    '- priorities — 3–5 конкретных действий по порядку важности, каждое одной фразой;',
    '- verdict — одно из: «Можно выпускать», «Выпускать после исправления критичных», «Не готово».',
    'Опирайся только на список ниже, ничего не выдумывай. Если проблем нет — так и скажи.',
    '',
    'Проблемы:',
    items || '(нет)'
  ].join('\n');
  var schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      priorities: { type: 'array', items: { type: 'string' } },
      verdict: { type: 'string', enum: ['Можно выпускать', 'Выпускать после исправления критичных', 'Не готово'] }
    },
    required: ['summary', 'priorities', 'verdict'],
    additionalProperties: false
  };
  return askModel_(cfg, req.model, prompt, null, schema);
}

/* ---------------- string check ---------------- */

function reviewRows_(cfg, req) {
  var items = req.items || [];
  if (!items.length) return [];
  var lines = items.map(function (it) {
    return JSON.stringify({
      id: it.id, language: it.language, source: it.source, target: it.target,
      context: it.context || '', component: it.component || '',
      glossary: (it.glossary || []).slice(0, 50)
    });
  }).join('\n');

  var prompt = [
    'Ты — эксперт по проверке качества перевода интерфейсов (LQA). Исходный язык — русский.',
    'Проверь каждую строку ниже: смысл, точность, терминологию и глоссарий, грамматику, стиль, пропуски и добавления.',
    'Технические вещи (переменные, теги, пробелы, пунктуацию) уже проверил автомат — на них не отвлекайся.',
    'Если со строкой всё хорошо, has_issue = false, остальные поля пустые.',
    'Для каждой строки верни объект с тем же id:',
    '- has_issue — есть ли проблема;',
    '- type — один из: ' + TEXT_TYPES.join('; '),
    '- severity — одна из: ' + SEVERITIES.join(', '),
    '- explanation — коротко по-русски, что не так;',
    '- suggestion — исправленный перевод целиком;',
    '- confidence — уверенность от 0 до 100.',
    '',
    styleGuidesPrompt_(req.styleGuides, uniq_(items.map(function (it) { return it.language; }))),
    '',
    'Строки (по одной JSON-записи на строку):',
    lines
  ].join('\n');

  var schema = {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            has_issue: { type: 'boolean' },
            type: { type: 'string', enum: TEXT_TYPES },
            severity: { type: 'string', enum: SEVERITIES },
            explanation: { type: 'string' },
            suggestion: { type: 'string' },
            confidence: { type: 'integer' }
          },
          required: ['id', 'has_issue', 'type', 'severity', 'explanation', 'suggestion', 'confidence'],
          additionalProperties: false
        }
      }
    },
    required: ['results'],
    additionalProperties: false
  };

  var out = askModel_(cfg, req.model, prompt, null, schema);
  return out.results || [];
}

/* ---------------- providers ---------------- */

function askModel_(cfg, requestedModel, prompt, image, schema) {
  if (!cfg.apiKey) throw new Error('В свойствах скрипта не задан ' + (cfg.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'));
  var model = pickModel_(cfg, requestedModel);
  return cfg.provider === 'anthropic'
    ? askClaude_(cfg.apiKey, model, prompt, image, schema)
    : askOpenAI_(cfg.apiKey, model, prompt, image, schema);
}

function askClaude_(apiKey, model, prompt, image, schema) {
  var content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  content.push({ type: 'text', text: prompt });
  var body = {
    model: model,
    max_tokens: 16000,
    // medium keeps a single screenshot well inside Apps Script's request time limit
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: schema } },
    messages: [{ role: 'user', content: content }]
  };
  var headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  // if a safety classifier declines, the API retries the request on a suitable model itself
  if (/^claude-(opus-5|fable-5-1)/.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', headers: headers,
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var data = parseHttp_(res, 'Claude API');
  if (data.stop_reason === 'refusal') throw new Error('Модель отказалась обрабатывать запрос' + (data.stop_details && data.stop_details.category ? ' (' + data.stop_details.category + ')' : ''));
  if (data.stop_reason === 'max_tokens') throw new Error('Ответ модели оборвался — уменьши размер пачки в Настройках');
  var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  return parseJson_(text);
}

function askOpenAI_(apiKey, model, prompt, image, schema) {
  var content = [{ type: 'text', text: prompt }];
  if (image) content.push({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } });
  var body = {
    model: model,
    messages: [{ role: 'user', content: content }],
    response_format: { type: 'json_schema', json_schema: { name: 'lqa_result', strict: true, schema: schema } }
  };
  var res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var data = parseHttp_(res, 'OpenAI API');
  var msg = data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) throw new Error('OpenAI вернул пустой ответ');
  if (msg.refusal) throw new Error('Модель отказалась: ' + msg.refusal);
  return parseJson_(msg.content);
}

/* ---------------- helpers ---------------- */

function uniq_(arr) {
  return arr.filter(function (x, i) { return x && arr.indexOf(x) === i; });
}

function parseHttp_(res, who) {
  var code = res.getResponseCode();
  var text = res.getContentText();
  var data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (code >= 300) {
    var msg = data && data.error ? (data.error.message || JSON.stringify(data.error)) : text.slice(0, 300);
    if (code === 401) msg = 'неверный ключ API';
    if (code === 429) msg = 'слишком много запросов или закончился лимит — подожди минуту';
    throw new Error(who + ' ответил ' + code + ': ' + msg);
  }
  return data;
}

function parseJson_(text) {
  text = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try { return JSON.parse(text); } catch (e) { throw new Error('Модель вернула не JSON: ' + text.slice(0, 200)); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- manual test ----------------
   Выбери функцию testConnection в редакторе и нажми «Выполнить» — в журнале будет ответ модели. */
function testConnection() {
  var cfg = readConfig_();
  var out = reviewRows_(cfg, { items: [
    { id: 't1', language: 'en', source: 'Добавить в корзину', target: 'Add to basket of goods', context: 'product.addToCart' }
  ] });
  Logger.log('Провайдер: ' + cfg.provider + ', модель: ' + pickModel_(cfg, ''));
  Logger.log(JSON.stringify(out, null, 2));
}
