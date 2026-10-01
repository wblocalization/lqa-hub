// Apps Script backend: доступ по одобренным Google-почтам. Скрипт запускается в Node с заглушками сервисов Google.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function backend(props, tokens) {
  const store = Object.assign({}, props), cache = {};
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] ?? null, setProperty: (k, v) => { store[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    Utilities: { base64EncodeWebSafe: b => Buffer.from(b).toString('base64'), computeDigest: (a, s) => [...require('crypto').createHash('sha256').update(s).digest()], DigestAlgorithm: { SHA_256: 1 } },
    UrlFetchApp: { fetch: url => { const t = decodeURIComponent(url.split('id_token=')[1]); const info = tokens[t];
      return { getResponseCode: () => info ? 200 : 400, getContentText: () => JSON.stringify(info || {}) }; } },
    ContentService: { createTextOutput: s => ({ setMimeType: () => JSON.parse(s) }), MimeType: { JSON: 1 } },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'ai-review-appsscript.gs'), 'utf8'), ctx);
  return { call: req => ctx.doPost({ postData: { contents: JSON.stringify(req) } }), store };
}
const future = Math.floor(Date.now() / 1000) + 3000;
const tok = (email, extra) => Object.assign({ email, email_verified: 'true', aud: 'cid', exp: String(future) }, extra);

test('без ADMIN_EMAILS — как раньше, по ключу доступа', () => {
  const b = backend({ ACCESS_TOKEN: 'k' }, {});
  expect(b.call({ mode: 'ping', token: 'k' }).ok).toBe(true);
  expect(b.call({ mode: 'ping', token: 'x' }).error).toContain('ключ');
});

test('с ADMIN_EMAILS — только вошедшие через Google и только из списка', () => {
  const b = backend({ ADMIN_EMAILS: 'boss@gmail.com', GOOGLE_CLIENT_ID: 'cid', ACCESS_TOKEN: 'k' }, {
    t_boss: tok('Boss@gmail.com'), t_ed: tok('ed@gmail.com'), t_other: tok('other@gmail.com'),
    t_foreign: tok('ed@gmail.com', { aud: 'someone-else' }), t_unverified: tok('ed@gmail.com', { email_verified: 'false' }),
  });
  expect(b.call({ mode: 'ping', token: 'k' }).code).toBe('auth_required');            // ключа больше недостаточно
  expect(b.call({ mode: 'ping', idToken: 'forged' }).code).toBe('auth_expired');      // Google не подтвердил
  expect(b.call({ mode: 'ping', idToken: 't_foreign' }).code).toBe('auth_required');
  expect(b.call({ mode: 'ping', idToken: 't_unverified' }).code).toBe('auth_required');
  expect(b.call({ mode: 'ping', idToken: 't_ed' }).code).toBe('not_allowed');
  const boss = b.call({ mode: 'ping', idToken: 't_boss' });
  expect([boss.ok, boss.auth, boss.email, boss.admin]).toEqual([true, 'google', 'boss@gmail.com', true]);

  // администратор добавляет редактора; редактор входит, но список менять не может
  expect(b.call({ mode: 'access', action: 'set', allowed: ['Ed@gmail.com', 'не почта'], idToken: 't_boss' }).allowed).toEqual(['ed@gmail.com']);
  expect(b.call({ mode: 'ping', idToken: 't_ed' }).ok).toBe(true);
  expect(b.call({ mode: 'access', action: 'set', allowed: ['other@gmail.com'], idToken: 't_ed' }).error).toContain('администратор');
  expect(b.call({ mode: 'ping', idToken: 't_other' }).code).toBe('not_allowed');
});
