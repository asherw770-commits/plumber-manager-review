// The new look lives in ui2.css; index.html links it as ui2.css?v=<hash>. Browsers and the service worker keep a copy per URL, so
// when the file changes the link must change too — otherwise phones keep showing the old look.  Fix:  node tests/ui2-version-check.js --fix
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'ui2.css'));
const want = crypto.createHash('sha1').update(css).digest('hex').slice(0, 8);
const file = path.join(root, 'index.html');
let html = fs.readFileSync(file, 'utf8');
const m = html.match(/ui2\.css\?v=([0-9a-z]+)/);
if (!m) { console.error('❌ ui2-version-check: index.html does not link ui2.css?v=…'); process.exit(1); }
if (m[1] === want) { console.log('✅ ui2-version-check: ui2.css?v=' + want + ' מעודכן'); process.exit(0); }
if (process.argv.includes('--fix')) {
  html = html.replace(/ui2\.css\?v=[0-9a-z]+/, 'ui2.css?v=' + want);
  fs.writeFileSync(file, html);
  console.log('🔧 ui2-version-check: עודכן ל-' + want + ' — לבצע commit');
  process.exit(0);
}
console.error('❌ ui2-version-check: ui2.css השתנה אבל הקישור ב-index.html עדיין ?v=' + m[1] + ' (צריך ?v=' + want + '). להריץ: node tests/ui2-version-check.js --fix');
process.exit(1);
