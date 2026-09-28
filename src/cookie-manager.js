const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_KEYS = ['sessionid', 'sessionid_ss'];

async function loadCookies(context, cookieFile) {
  if (!fs.existsSync(cookieFile)) {
    return { loaded: false, count: 0, reason: 'File not found' };
  }
  try {
    const raw = fs.readFileSync(cookieFile, 'utf-8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return { loaded: false, count: 0, reason: 'Empty cookie array' };
    }
    await context.addCookies(cookies);
    return { loaded: true, count: cookies.length };
  } catch (e) {
    return { loaded: false, count: 0, reason: e.message };
  }
}

async function saveCookies(context, cookieFile) {
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2), 'utf-8');
    return { saved: true, count: cookies.length };
  } catch (e) {
    return { saved: false, count: 0, reason: e.message };
  }
}

async function checkLogin(context) {
  try {
    const cookies = await context.cookies();
    return cookies.some(c => SESSION_KEYS.includes(c.name));
  } catch {
    return false;
  }
}

async function clearCookiesFor(context, url) {
  try {
    const cookies = await context.cookies(url);
    if (cookies.length === 0) return 0;
    const past = Math.floor(Date.now() / 1000) - 86400;
    await context.addCookies(cookies.map(c => ({ ...c, expires: past })));
    return cookies.length;
  } catch {
    return 0;
  }
}

function deleteCookieFile(cookieFile) {
  try {
    if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);
    return true;
  } catch {
    return false;
  }
}

async function getCookieHeader(context) {
  try {
    const cookies = await context.cookies();
    return cookies
      .filter(c => !c.name.startsWith('__'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

module.exports = { loadCookies, saveCookies, checkLogin, getCookieHeader, clearCookiesFor, deleteCookieFile };

if (require.main === module) {
  const assert = require('assert');
  const tmp = path.join(os.tmpdir(), 'cookie-manager-selfcheck.json');
  fs.writeFileSync(tmp, '[]');
  deleteCookieFile(tmp);
  assert.strictEqual(fs.existsSync(tmp), false, 'deleteCookieFile should remove file');

  (async () => {
    let added = null;
    const fake = {
      cookies: async () => [{ name: 'sessionid', value: 'x', domain: '.douyin.com', path: '/' }],
      addCookies: async (c) => { added = c; }
    };
    const n = await clearCookiesFor(fake, 'https://www.douyin.com/');
    assert.strictEqual(n, 1, 'should expire 1 cookie');
    assert.ok(added[0].expires < Math.floor(Date.now() / 1000), 'expires must be in the past');
    console.log('cookie-manager self-check OK');
  })().catch(e => { console.error(e); process.exit(1); });
}
