// يشغّل المحرر نفسه على خادم GitHub بمتصفح بلا شاشة: يحلّل الصوت، يقسّمه فصولاً، ينشئ الفيديوهات ويجدولها في BulkPublish.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = process.env;
const pick = base => { const d = path.join(root, 'inputs'); if (!fs.existsSync(d)) return null; const f = fs.readdirSync(d).find(x => x.toLowerCase().startsWith(base + '.')); return f ? path.join(d, f) : null; };
// إشعار ntfy متزامن (curl) حتى يصل قبل إنهاء العملية
const notify = (title, body) => { const t = (E.NTFY_TOPIC || '').trim(); if (!t) return; try { spawnSync('curl', ['-s', '-m', '10', '-H', 'Content-Type: application/json', '-d', JSON.stringify({ topic: t, title, message: String(body).slice(0, 900), priority: 4, tags: ['warning'] }), 'https://ntfy.sh'], { stdio: 'ignore' }); } catch (_) {} };
const fail = (m, code = 2) => { console.error('❌ ' + m); notify('توقف الطيار الآلي', m); process.exit(code); };
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
const BPKEY = (E.BP_KEY || '').trim();
if (!BPKEY) fail('ينقص السرّ BP_KEY');
if (!E.START_DATE) fail('أدخل تاريخ أول نشر');
// التاريخ يجب أن يكون صيغته YYYY-MM-DD وأن يكون موعد أول نشر في المستقبل (حسب المنطقة الزمنية المختارة)
{
  const tz = E.TZ_ID || 'Asia/Riyadh', tm = (E.TIME || '19:00').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(E.START_DATE.trim())) fail('صيغة تاريخ البداية يجب أن تكون YYYY-MM-DD مثل 2026-10-29');
  let nowStr = ''; try { nowStr = new Date().toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16).replace(' ', 'T'); } catch (_) { fail('المنطقة الزمنية غير صالحة: ' + tz); }
  if (E.START_DATE.trim() + 'T' + tm <= nowStr) fail('موعد أول نشر (' + E.START_DATE.trim() + ' ' + tm + ') قد مضى. الآن عندك: ' + nowStr.replace('T', ' ') + '. اختر تاريخًا لاحقًا');
}
let settings = {}; try { if (settingsPath) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) { fail('ملف settings.json غير صالح: ' + e.message); }
fs.mkdirSync(path.join(root, 'out'), { recursive: true });

// مفتاح ElevenLabs الصحيح يبدأ بـ sk_ . إن وُضع «معرّف المفتاح» بالخطأ يُهمَل هنا بدل أن يفشل الطلب (400)، ويكمل التحليل بـGemini وحده
let elKey = (E.ELEVEN_KEY || '').trim();
if (elKey && !elKey.startsWith('sk_')) { console.log('⚠ ELEVEN_KEY لا يبدأ بـ sk_ (غالباً وُضع معرّف المفتاح وليس المفتاح نفسه). تم تجاهله وسيكمل العمل بـGemini وحده. أنشئ مفتاحاً جديداً وانسخه لحظة ظهوره.'); elKey = ''; }
const keys = { gemini: E.GEMINI_KEY, el: elKey, bp: BPKEY, ntfy: E.NTFY_TOPIC || '' };
// فحص مفتاح BulkPublish والقنوات الآن، قبل التحليل وقبل أي استهلاك: إن فشل نتوقف فورًا بدل انتظار ساعات
{
  let r, j = {};
  try { r = await fetch('https://app.bulkpublish.com/api/channels', { headers: { Authorization: 'Bearer ' + BPKEY }, signal: AbortSignal.timeout(30000) }); j = await r.json().catch(() => ({})); }
  catch (e) { fail('تعذّر الاتصال بـBulkPublish: ' + e.message); }
  if (r.status === 401 || r.status === 403) fail('مفتاح BulkPublish مرفوض (HTTP ' + r.status + '). أنشئ مفتاحًا جديدًا وضعه في السرّ BP_KEY دون مسافات');
  if (!r.ok) fail('BulkPublish ردّ بخطأ HTTP ' + r.status + '. تحقق من المفتاح والخدمة');
  const chs = (j.channels || j.data || []).filter(c => c && c.id != null && c.platform);
  if (!chs.length) fail('المفتاح صالح لكن لا توجد قنوات مربوطة في BulkPublish. اربط القنوات من لوحة BulkPublish ثم أعد التشغيل');
  console.log('✔ BulkPublish: ' + chs.length + ' قناة (' + chs.map(c => c.platform).join('، ') + ')');
  if (chs.length < 4) console.log('⚠ القنوات أقل من 4 (المتوقع YouTube وTikTok وInstagram وFacebook). تأكد أن المربوط هو ما تريده');
}
// نخدم المجلد عبر http محلي بدل file:// حتى يعمل التخزين والشبكة كما في الموقع العادي
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.png': 'image/png' };
// نجد ملف الأداة: tool.html في جذر المستودع، وإلا أي ملف html فيه الأداة (قد يُسمّى tool (1).html عند التنزيل من الهاتف)
const TOOL = (() => {
  const exact = path.join(root, 'tool.html'); if (fs.existsSync(exact)) return exact;
  const found = [];
  for (const d of [root, path.join(root, 'server')]) { try { for (const f of fs.readdirSync(d)) if (/\.html?$/i.test(f) && fs.readFileSync(path.join(d, f), 'utf8').includes('id="wzStart"')) found.push(path.join(d, f)); } catch (_) {} }
  if (!found.length) { let ls = []; try { ls = fs.readdirSync(root); } catch (_) {} fail('لم أجد ملف الأداة tool.html في جذر المستودع. الموجود في الجذر: ' + ls.join('، ') + '. ارفع tool.html إلى الجذر (وليس داخل server) وباسم tool.html تماماً'); }
  console.log('⚠ tool.html غير موجود في الجذر، سأستخدم: ' + path.relative(root, found[0]) + ' (غيّر اسمه إلى tool.html وانقله للجذر)');
  return found[0];
})();
if (!fs.readFileSync(TOOL, 'utf8').includes('deleteMediaAfterPublish')) console.log('⚠ نسخة tool.html قديمة (بلا الإصلاحات الأخيرة). ارفع النسخة الجديدة');
const srv = http.createServer((req, res) => {
  const p0 = req.url.split('?')[0], f = (p0 === '/' || p0 === '/tool.html') ? TOOL : path.join(root, decodeURIComponent(p0));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { console.log('404 للمسار: ' + p0); res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  const s = fs.createReadStream(f);
  s.on('error', e => { console.log('⚠ خطأ قراءة ' + f + ': ' + e.message); res.destroy(); });
  s.pipe(res);
});
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
page.on('console', m => { const t = m.text(); if (t.startsWith('[plan]') || t.startsWith('[bp]') || t.startsWith('[audio]') || t.startsWith('[export]') || t.startsWith('[timing]') || t.startsWith('[sync]')) console.log(t); });
// الأداة تنزّل كل فيديو وغلاف كأنها تحفظهما على الجهاز؛ نلتقطها هنا لتظهر في Artifacts
page.on('download', async d => { try { await d.saveAs(path.join(root, 'out', d.suggestedFilename())); console.log('💾 حُفظ: ' + d.suggestedFilename()); } catch (e) { console.log('⚠ تعذّر حفظ ' + d.suggestedFilename() + ': ' + e.message); } });

// تشخيص: نتأكد من ردّ السيرفر المحلي قبل فتح الصفحة
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/tool.html`);
  const body = await r.text();
  console.log('STATUS', r.status, '| TOOL =', TOOL, '| حجم الرد =', body.length, '| root =', root);
} catch (e) { console.log('⚠ فشل فحص السيرفر المحلي: ' + e.message); }

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
await page.waitForFunction(() => window.__apState === 'ready' || window.__apState === 'error', null, { timeout: 20 * 60 * 1000, polling: 3000 });
const st = await page.evaluate(() => window.__apState);
await page.screenshot({ path: path.join(root, 'out', 'after-analysis.png') }).catch(() => {});
console.log('حالة التحليل: ' + st);
if (st !== 'ready') { clearInterval(logTimer); console.log(await page.evaluate(() => document.getElementById('wzNote').textContent)); await browser.close(); fail('فشل التحليل. راجع السجل أعلاه', 1); }

{
  const nCh = await page.evaluate(() => document.querySelectorAll('#bpChannels input[type=checkbox]').length);
  if (!nCh) { clearInterval(logTimer); await page.screenshot({ path: path.join(root, 'out', 'no-channels.png') }).catch(() => {}); await browser.close(); fail('الأداة لم تحمّل قنوات النشر رغم نجاح الفحص المسبق. أوقفنا التشغيل قبل إنشاء الفيديوهات'); }
  console.log('✔ الأداة حمّلت ' + nCh + ' قناة نشر');
}
console.log('▶ تنفيذ الخطة كاملة (إنشاء وجدولة)...');
await page.waitForSelector('#wzAuto', { state: 'attached', timeout: 60000 });
await page.evaluate(() => document.getElementById('wzAuto').click());
await page.waitForFunction(() => (window.__apDone || 0) >= 1, null, { timeout: 90 * 60 * 1000, polling: 5000 });
clearInterval(logTimer);
{ const ml = await page.evaluate(() => window.__metaLog || []).catch(() => []); ml.forEach(m => console.log('📝 بيانات: ' + m.title + (m.errs.length ? ' ❌ ' + m.errs.join('؛') : ' ✔') + (m.warn.length ? ' ⚠ ' + m.warn.join('؛') : ''))); }
const failed = await page.evaluate(() => window.__apFailed || 0), abortMsg = await page.evaluate(() => window.__apAbortMsg || '');
if (abortMsg) { clearInterval(logTimer); await browser.close(); fail('توقفت الأداة قبل إنشاء الفيديوهات: ' + abortMsg, 1); }
console.log(await page.evaluate(() => document.getElementById('wzNote').textContent));
await page.screenshot({ path: path.join(root, 'out', 'final.png') }).catch(() => {});
const finalNote = await page.evaluate(() => document.getElementById('wzNote').textContent || '').catch(() => '');
await browser.close();
const unsched = (finalNote.match(/فشل النشر\/الجدولة/g) || []).length;
if (failed) fail(failed + ' من الفصول فشلت. راجع السجل', 1);
if (unsched) fail(unsched + ' من الفيديوهات أُنشئت لكن لم تُجدول في BulkPublish. راجع السبب في السجل (مثلاً امتلاء مساحة الوسائط في الخطة المجانية)، والفيديوهات محفوظة في Artifacts', 1);
console.log('✅ انتهى: الفيديوهات أُنشئت وقَبِل BulkPublish جدولتها. هذا لا يثبت النشر العام الفعلي على كل منصة؛ تحقق من لوحة BulkPublish ومن كل منصة عند موعد النشر.');
