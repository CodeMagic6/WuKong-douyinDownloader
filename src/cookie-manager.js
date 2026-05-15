const fs = require('fs');

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

module.exports = { loadCookies, saveCookies, checkLogin, getCookieHeader };
