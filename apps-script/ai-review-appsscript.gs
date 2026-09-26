/**
 * LQA Hub — ИИ-backend для Google Apps Script.
 *
 * Хранит ключ API у себя (в свойствах скрипта), принимает запросы от платформы
 * и возвращает найденные проблемы. Ключ никогда не попадает в браузер.
 *
 * Три режима запроса (поле `mode`):
 *   - 'ping'   — проверка подключения из Настроек платформы;
 *   - 'visual' — проверка одного скриншота (картинка → проблемы с рамками);
 *   - без mode — проверка пачки строк перевода (как раньше).
 *
 * Настройка — Project Settings → Script Properties (подробно в README.md рядом):
 *   PROVIDER           anthropic | openai            (по умолчанию anthropic)
 *   ANTHROPIC_API_KEY  ключ Claude API               (если PROVIDER=anthropic)
 *   OPENAI_API_KEY     ключ OpenAI API               (если PROVIDER=openai)
 *   MODEL              необязательно: своя модель вместо модели по умолчанию
 *   ACCESS_TOKEN       необязательно, но очень желательно: тот же текст вписывается
 *                      в Настройках платформы, без него backend не отвечает чужим
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
    if (cfg.accessToken && req.token !== cfg.accessToken) {
      return json_({ error: 'Неверный ключ доступа — проверь поле «Ключ доступа» в Настройках платформы' });
    }
    if (req.mode === 'ping') {
      return json_({ ok: true, provider: cfg.provider, model: pickModel_(cfg, req.model) });
    }
    if (req.mode === 'visual') {
      return json_({ findings: reviewScreenshot_(cfg, req) });
    }
    return json_({ results: reviewRows_(cfg, req) });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function doGet() {
  return json_({ ok: true, message: 'LQA Hub AI backend работает. Платформа обращается сюда POST-запросами.' });
}

/* ---------------- config ---------------- */

function readConfig_() {
  var p = PropertiesService.getScriptProperties();
  var provider = String(p.getProperty('PROVIDER') || 'anthropic').trim().toLowerCase();
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error('PROVIDER должен быть anthropic или openai');
  var key = provider === 'anthropic' ? p.getProperty('ANTHROPIC_API_KEY') : p.getProperty('OPENAI_API_KEY');
  if (!key) throw new Error('В свойствах скрипта не задан ' + (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'));
  return {
    provider: provider,
    apiKey: String(key).trim(),
    model: String(p.getProperty('MODEL') || '').trim(),
    accessToken: String(p.getProperty('ACCESS_TOKEN') || '').trim()
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
    req.instructions ? '\nДополнительно: ' + req.instructions : ''
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
