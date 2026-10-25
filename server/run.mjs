// يشغّل المحرر نفسه على خادم GitHub بمتصفح بلا شاشة: يحلّل الصوت، يقسّمه فصولاً، ينشئ الفيديوهات ويجدولها في BulkPublish.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = process.env;
const pick = base => { const d = path.join(root, 'inputs'); if (!fs.existsSync(d)) return null; const f = fs.readdirSync(d).find(x => x.toLowerCase().startsWith(base + '.')); return f ? path.join(d, f) : null; };
const fail = (m, code = 2) => { console.error('❌ ' + m); process.exit(code); };
const audio = pick('audio'), person = pick('person'), bgm = pick('bgm'), settingsPath = pick('settings');
if (!audio) fail('ضع ملف الصوت داخل مجلد inputs باسم audio.mp3 (أو m4a أو wav)');
if (!E.GEMINI_KEY) fail('ينقص السرّ GEMINI_KEY');
if (!E.BP_KEY) fail('ينقص السرّ BP_KEY');
if (!E.START_DATE) fail('أدخل تاريخ أول نشر');
let settings = {}; try { if (settingsPath) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) { fail('ملف settings.json غير صالح: ' + e.message); }
fs.mkdirSync(path.join(root, 'out'), { recursive: true });

const keys = { gemini: E.GEMINI_KEY, el: E.ELEVEN_KEY || '', bp: E.BP_KEY, ntfy: E.NTFY_TOPIC || '' };
// نخدم المجلد عبر http محلي بدل file:// حتى يعمل التخزين والشبكة كما في الموقع العادي
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.png': 'image/png' };
const srv = http.createServer((req, res) => { const f = path.join(root, req.url.split('?')[0] === '/' ? 'tool.html' : decodeURIComponent(req.url.split('?')[0])); if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const launchOpts = E.CHROME_PATH ? { executablePath: E.CHROME_PATH } : { channel: 'chrome' };
const browser = await chromium.launch({
  ...launchOpts, headless: true,
  args: ['--no-sandbox', '--disable-web-security', '--disable-site-isolation-trials', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--mute-audio']
});
const ctx = await browser.newContext({ timezoneId: E.TZ_ID || 'Asia/Riyadh', viewport: { width: 430, height: 900 }, locale: 'ar' });
await ctx.addInitScript(({ keys, settings }) => {
  try {
    localStorage.setItem('asr_key_gemini', keys.gemini); localStorage.setItem('asr_provider', 'gemini'); localStorage.setItem('bp_key', keys.bp);
    if (keys.el) localStorage.setItem('el_key', keys.el);
    if (settings.template) localStorage.setItem('tabiin_template_v3', JSON.stringify(settings.template));
    const v = Object.assign({}, settings.video || {}); if (keys.ntfy) v.wzNtfy = keys.ntfy; v.wzAutoMix = true;
    localStorage.setItem('tabiin_video_v1', JSON.stringify(v));
  } catch (e) {}
}, { keys, settings });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('⚠ خطأ في الصفحة:', e.message));
page.on('dialog', d => d.accept().catch(() => {}));
await page.goto(`http://127.0.0.1:${PORT}/tool.html`, { waitUntil: 'load' });
await page.waitForSelector('#wzStart', { timeout: 60000 });

let last = '';
const logTimer = setInterval(async () => {
  try { const t = await page.evaluate(() => (document.getElementById('wzNote') || {}).textContent || ''); const p = await page.evaluate(() => (document.getElementById('wzProgTxt') || {}).textContent || ''); const cur = (t + '\n' + p).trim(); if (cur && cur !== last) { last = cur; console.log('—'.repeat(20) + '\n' + cur); } } catch (e) {}
}, 15000);

if (E.RECITER) await page.fill('#wzReciter', E.RECITER);
if (person) await page.setInputFiles('#wzImg', person);
await page.setInputFiles('#wzAudio', audio);
if (bgm) { await page.setInputFiles('#wzBgm', bgm); await page.waitForTimeout(8000); }
// الحقلان داخل قسم مخفي حتى توجد مقاطع محفوظة، فنضبطهما برمجياً بدل الكتابة
await page.evaluate(({ d, t }) => { for (const [id, v] of [['wzSchedDate', d], ['wzSchedTime', t]]) { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }, { d: E.START_DATE, t: E.TIME || '19:00' });

console.log('▶ بدء التحليل...');
await page.click('#wzStart');
await page.waitForFunction(() => window.__apState === 'ready' || window.__apState === 'error', null, { timeout: 90 * 60 * 1000, polling: 3000 });
const st = await page.evaluate(() => window.__apState);
await page.screenshot({ path: path.join(root, 'out', 'after-analysis.png') }).catch(() => {});
console.log('حالة التحليل: ' + st);
if (st !== 'ready') { clearInterval(logTimer); console.log(await page.evaluate(() => document.getElementById('wzNote').textContent)); await browser.close(); fail('فشل التحليل. راجع السجل أعلاه', 1); }

console.log('▶ تنفيذ الخطة كاملة (إنشاء وجدولة)...');
await page.waitForSelector('#wzAuto', { state: 'attached', timeout: 60000 });
await page.evaluate(() => document.getElementById('wzAuto').click());
await page.waitForFunction(() => (window.__apDone || 0) >= 1, null, { timeout: 5 * 60 * 60 * 1000, polling: 5000 });
clearInterval(logTimer);
const failed = await page.evaluate(() => window.__apFailed || 0);
console.log(await page.evaluate(() => document.getElementById('wzNote').textContent));
await page.screenshot({ path: path.join(root, 'out', 'final.png') }).catch(() => {});
await browser.close();
if (failed) fail(failed + ' من الفصول فشلت. راجع السجل', 1);
console.log('✅ انتهى');
