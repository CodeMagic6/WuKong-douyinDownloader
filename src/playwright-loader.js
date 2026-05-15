const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  const searchPaths = [
    path.join(path.dirname(process.execPath), 'node_modules'),
    path.join(__dirname, '..', '..', 'node_modules'),
    path.join(process.cwd(), 'node_modules')
  ];
  for (const p of searchPaths) {
    const pwPath = path.join(p, 'playwright');
    try {
      if (fs.existsSync(path.join(pwPath, 'index.js'))) {
        return require(pwPath);
      }
    } catch {}
  }
  return require('playwright');
}

module.exports = { loadPlaywright };
