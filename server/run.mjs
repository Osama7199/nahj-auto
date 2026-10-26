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
// يحوّل روابط المشاركة (Google Drive / Dropbox) إلى روابط تحميل مباشر
const direct = u => {
  u = u.trim();
  let m = u.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) || u.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([^&#]+)/);
  if (m) return 'https://drive.google.com/uc?export=download&confirm=t&id=' + m[1];
  if (/dropbox\.com/.test(u)) { const x = new URL(u); x.searchParams.delete('dl'); x.searchParams.set('dl', '1'); return x.toString(); }
  return u;
};
const EXT = { 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/json': '.json' };
const dlDir = path.join(root, 'dl');
async function download(url, base, fallbackExt) {
  fs.mkdirSync(dlDir, { recursive: true });
  console.log('⬇ تحميل ' + base + ' ...');
  const r = await fetch(direct(url), { redirect: 'follow' });
  if (!r.ok) fail('تعذّر تحميل ' + base + ' (HTTP ' + r.status + '). تأكد أن الرابط عام (Anyone with the link)');
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct === 'text/html') fail('رابط ' + base + ' يفتح صفحة ويب وليس الملف. اجعل الرابط عامًا لأي شخص معه الرابط، ثم أعد المحاولة');
  const ext = EXT[ct] || path.extname(new URL(r.url).pathname) || fallbackExt;
  const f = path.join(dlDir, base + ext);
  fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  console.log('   تم: ' + (fs.statSync(f).size / 1048576).toFixed(1) + 'MB');
  return f;
}
// الرابط يتقدم على ملف مجلد inputs إن وُجد الاثنان
const get = async (envUrl, base, ext) => envUrl && envUrl.trim() ? await download(envUrl, base, ext) : pick(base);
const audio = await get(E.AUDIO_URL, 'audio', '.mp3'), person = await get(E.IMAGE_URL, 'person', '.jpg'), bgm = await get(E.BGM_URL, 'bgm', '.mp3'), settingsPath = await get(E.SETTINGS_URL, 'settings', '.json');
if (!audio) fail('أدخل رابط الصوت (audio_url) عند تشغيل الـworkflow، أو ضع audio.mp3 في مجلد inputs');
if (!person) fail('الصورة إلزامية: أدخل رابط صورة القارئ (image_url) أو ضع person.jpg في مجلد inputs');
if (!E.GEMINI_KEY) fail('ينقص السرّ GEMINI_KEY');
if (!E.BP_KEY) fail('ينقص السرّ BP_KEY');
if (!E.START_DATE) fail('أدخل تاريخ أول نشر');
let settings = {}; try { if (settingsPath) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) { fail('ملف settings.json غير صالح: ' + e.message); }
fs.mkdirSync(path.join(root, 'out'), { recursive: true });

// مفتاح ElevenLabs الصحيح يبدأ بـ sk_ . إن وُضع «معرّف المفتاح» بالخطأ يُهمَل هنا بدل أن يفشل الطلب (400)، ويكمل التحليل بـGemini وحده
let elKey = (E.ELEVEN_KEY || '').trim();
if (elKey && !elKey.startsWith('sk_')) { console.log('⚠ ELEVEN_KEY لا يبدأ بـ sk_ (غالباً وُضع معرّف المفتاح وليس المفتاح نفسه). تم تجاهله وسيكمل العمل بـGemini وحده. أنشئ مفتاحاً جديداً وانسخه لحظة ظهوره.'); elKey = ''; }
const keys = { gemini: E.GEMINI_KEY, el: elKey, bp: E.BP_KEY, ntfy: E.NTFY_TOPIC || '' };
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
// خطة التقسيم التي تطبعها الأداة (عدد الفصول ونسبة تغطية الصوت) تظهر في سجل GitHub
page.on('console', m => { const t = m.text(); if (t.startsWith('[plan]') || t.startsWith('[bp]') || t.startsWith('[audio]')) console.log(t); });
// الأداة تنزّل كل فيديو وغلاف كأنها تحفظهما على الجهاز؛ نلتقطها هنا لتظهر في Artifacts
page.on('download', async d => { try { await d.saveAs(path.join(root, 'out', d.suggestedFilename())); console.log('💾 حُفظ: ' + d.suggestedFilename()); } catch (e) { console.log('⚠ تعذّر حفظ ' + d.suggestedFilename() + ': ' + e.message); } });
await page.goto(`http://127.0.0.1:${PORT}/tool.html`, { waitUntil: 'load' });
await page.waitForSelector('#wzStart', { timeout: 60000 });
// تأكيد أن إعداداتك (الخطوط والألوان) وصلت للأداة فعلاً، لا أن تُستخدم الافتراضية دون أن تعلم
{
  const got = await page.evaluate(() => ({ font: (document.getElementById('mainFontSelect') || {}).value, color: (document.getElementById('mainColorPicker') || {}).value }));
  const want = settings.template || {};
  console.log(`⚙ الإعدادات: ${settingsPath ? 'مُحمَّلة من settings_url' : 'افتراضية'} — قالب ${Object.keys(want).length} حقل، فيديو ${Object.keys(settings.video || {}).length} حقل — خط العنوان: ${got.font} ولونه: ${got.color}`);
  if (!settingsPath) console.log('⚠ لم تُدخل settings_url، فلن تُطبَّق خطوطك وألوانك المخصصة وستُستخدم الافتراضية');
  if (want.mainFontSelect && want.mainFontSelect !== got.font) console.log(`⚠ خط العنوان في إعداداتك (${want.mainFontSelect}) لم يُطبَّق، المطبَّق: ${got.font}`);
  if (want.mainColorPicker && String(want.mainColorPicker).toLowerCase() !== String(got.color || '').toLowerCase()) console.log(`⚠ لون العنوان في إعداداتك (${want.mainColorPicker}) لم يُطبَّق، المطبَّق: ${got.color}`);
}

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
const finalNote = await page.evaluate(() => document.getElementById('wzNote').textContent || '').catch(() => '');
await browser.close();
const unsched = (finalNote.match(/فشل النشر\/الجدولة/g) || []).length;
if (failed) fail(failed + ' من الفصول فشلت. راجع السجل', 1);
if (unsched) fail(unsched + ' من الفيديوهات أُنشئت لكن لم تُجدول في BulkPublish. راجع السبب في السجل (مثلاً امتلاء مساحة الوسائط في الخطة المجانية)، والفيديوهات محفوظة في Artifacts', 1);
console.log('✅ انتهى');
