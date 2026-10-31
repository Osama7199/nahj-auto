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
// تحويل WebM إلى MP4 (تيك توك وفيسبوك لا يقبلان WebM). ffmpeg يُثبَّت في auto.yml
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
function convertB64(b64) {
  if (!HAS_FFMPEG) return '';
  try {
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    const inp = path.join(root, 'out', '_in.webm'), outp = path.join(root, 'out', '_out.mp4');
    fs.writeFileSync(inp, Buffer.from(b64, 'base64')); try { fs.unlinkSync(outp); } catch (_) {}
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', outp], { timeout: 240000, encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(outp)) { console.log('⚠ ffmpeg فشل: ' + String(r.stderr || r.error || '').slice(0, 300)); return ''; }
    const buf = fs.readFileSync(outp); try { fs.unlinkSync(inp); fs.unlinkSync(outp); } catch (_) {}
    return buf.toString('base64');
  } catch (e) { console.log('⚠ تعذّر التحويل: ' + e.message); return ''; }
}
// ===== ترميز الفيديو غير المتصل: الصفحة ترسل كل إطار JPEG بزمنه والصوت WAV، وffmpeg يبني MP4 بمعدل 30 إطارًا ثابتة =====
const framesDir = path.join(root, 'out', 'frames');
const encBegin = () => { fs.rmSync(framesDir, { recursive: true, force: true }); fs.mkdirSync(framesDir, { recursive: true }); };
const encFrame = (k, b64) => { fs.writeFileSync(path.join(framesDir, 'f' + String(k).padStart(6, '0') + '.jpg'), Buffer.from(b64, 'base64')); };
function encFinish(fps, wavB64) {
  if (!HAS_FFMPEG) return '';
  try {
    const wav = path.join(root, 'out', '_audio.wav'), outp = path.join(root, 'out', '_enc.mp4'); fs.writeFileSync(wav, Buffer.from(wavB64, 'base64')); try { fs.unlinkSync(outp); } catch (_) {}
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(framesDir, 'f%06d.jpg'), '-i', wav, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '3.2M', '-bufsize', '6M', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-shortest', outp], { timeout: 600000, encoding: 'utf8' });
    fs.rmSync(framesDir, { recursive: true, force: true }); try { fs.unlinkSync(wav); } catch (_) {}
    if (r.status !== 0 || !fs.existsSync(outp)) { console.log('⚠ ترميز ffmpeg فشل: ' + String(r.stderr || r.error || '').slice(0, 300)); return ''; }
    const buf = fs.readFileSync(outp); try { fs.unlinkSync(outp); } catch (_) {} return buf.toString('base64');
  } catch (e) { console.log('⚠ تعذّر الترميز: ' + e.message); return ''; }
}
const exposeEnc = async pg => { if (!HAS_FFMPEG) return; await pg.exposeFunction('__encBegin', async () => encBegin()); await pg.exposeFunction('__encFrame', async (k, b64) => encFrame(k, b64)); await pg.exposeFunction('__encFinish', async (fps, w) => encFinish(fps, w)); await pg.exposeFunction('__encAbort', async () => { fs.rmSync(framesDir, { recursive: true, force: true }); }); };
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
// ============ وضع «فحص الجاهزية» (SELFTEST=yes): يختبر كل الحلقات على بنية GitHub الحقيقية دون صوت ودون نشر ============
if ((E.SELFTEST || '').trim().toLowerCase() === 'yes') {
  const rows = []; const add = (st, name, detail) => { rows.push({ st, name, detail }); console.log((st === 'PASS' ? '✅' : st === 'WARN' ? '⚠️' : '❌') + ' ' + name + (detail ? ' — ' + detail : '')); };
  const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  console.log('═══ فحص الجاهزية ═══');
  add(Number(process.versions.node.split('.')[0]) >= 18 ? 'PASS' : 'FAIL', 'Node.js', process.version);
  { const f = sh('ffmpeg', ['-version']); add(f.status === 0 ? 'PASS' : 'FAIL', 'ffmpeg', f.status === 0 ? String(f.stdout).split('\n')[0].slice(0, 60) : 'غير مثبّت (يلزم لتحويل MP4 لتيك توك وفيسبوك)'); }
  // Gemini: نجاح طلب صغير على أول نموذجين (احتساب نسبة النجاح لا لقطة واحدة)
  if (!E.GEMINI_KEY) add('FAIL', 'Gemini', 'السرّ GEMINI_KEY غير موجود');
  else for (const model of ['gemini-3.6-flash', 'gemini-3.5-flash-lite']) {
    let ok = 0, last = '', ms = 0;
    for (let k = 0; k < 3; k++) {
      const t0 = Date.now();
      try { const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': E.GEMINI_KEY.trim() }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'أجب بكلمة واحدة: جاهز' }] }] }), signal: AbortSignal.timeout(60000) }); ms = Date.now() - t0; last = 'HTTP ' + r.status; if (r.ok) ok++; else if (r.status === 400 || r.status === 403 || r.status === 404) break; }
      catch (e) { last = e.name === 'TimeoutError' ? 'انتهت المهلة 60ث' : e.message; }
      await new Promise(r => setTimeout(r, 4000));
    }
    add(ok === 3 ? 'PASS' : ok > 0 ? 'WARN' : 'FAIL', 'Gemini ' + model, ok + '/3 طلبات نجحت (' + (ok ? ms + 'ms' : last) + ')' + (ok === 0 && /429/.test(last) ? ' — حصة المفتاح منتهية' : ''));
  }
  // ElevenLabs
  { const k = (E.ELEVEN_KEY || '').trim();
    if (!k) add('WARN', 'ElevenLabs', 'لا يوجد مفتاح: سيكون توقيت الكلمات تقديريًا ولا بديل لـGemini عند ازدحامه');
    else { try { const r = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': k }, signal: AbortSignal.timeout(20000) }); let j = {}; try { j = await r.json(); } catch (_) {}
      if (r.ok) add('PASS', 'ElevenLabs', 'المفتاح صالح (' + k.length + ' حرفًا)' + (j.subscription && j.subscription.character_limit != null ? '، الرصيد المتبقي ' + (j.subscription.character_limit - (j.subscription.character_count || 0)) + ' رمزًا' : ''));
      else if (r.status === 401 && j.detail && j.detail.status === 'missing_permissions') add('PASS', 'ElevenLabs', 'المفتاح صالح (بلا صلاحية قراءة الحساب، طبيعي)');
      else add('FAIL', 'ElevenLabs', 'رُفض المفتاح HTTP ' + r.status + ' — غالبًا وُضع «معرّف المفتاح» لا المفتاح السرّي'); } catch (e) { add('WARN', 'ElevenLabs', 'تعذّر الاتصال: ' + e.message); } } }
  // BulkPublish
  { const k = (E.BP_KEY || '').trim();
    if (!k) add('FAIL', 'BulkPublish', 'السرّ BP_KEY غير موجود');
    else { try { const r = await fetch('https://app.bulkpublish.com/api/channels', { headers: { Authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(30000) }); const j = await r.json().catch(() => ({}));
      if (!r.ok) add('FAIL', 'BulkPublish', 'HTTP ' + r.status + ' — المفتاح مرفوض');
      else { const chs = (j.channels || j.data || []).filter(c => c && c.id != null && c.platform), have = new Set(chs.map(c => String(c.platform).toLowerCase())), miss = ['youtube', 'tiktok', 'facebook'].filter(p => !have.has(p)); add(chs.length ? 'PASS' : 'FAIL', 'BulkPublish', chs.length + ' قناة: ' + [...have].join('، ') + (miss.length ? ' | غير مربوط: ' + miss.join('، ') : '')); } } catch (e) { add('FAIL', 'BulkPublish', e.message); } } }
  // المتصفح + مسار التصدير الحقيقي + التحويل + تحليل الناتج
  let browser = null;
  try {
    const toolPath = path.join(root, 'tool.html'); if (!fs.existsSync(toolPath)) throw new Error('tool.html غير موجود في جذر المستودع');
    const srv0 = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(toolPath).pipe(s); });
    await new Promise(r => srv0.listen(0, '127.0.0.1', r)); const port = srv0.address().port;
    browser = await chromium.launch({ ...(E.CHROME_PATH ? { executablePath: E.CHROME_PATH } : { channel: 'chrome' }), headless: true, args: ['--no-sandbox', '--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--mute-audio'] });
    add('PASS', 'Chrome', 'v' + browser.version());
    const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, acceptDownloads: false, locale: 'ar' }), pg = await ctx.newPage();
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    await pg.exposeFunction('__ffmpegConvert', async b64 => { fs.writeFileSync(path.join(root, 'out', 'selftest-raw.webm'), Buffer.from(b64, 'base64')); return convertB64(b64); });   // نحتفظ بالخام لقياس سلاسة الالتقاط الفعلية قبل التحويل لـ30 إطارًا ثابتة
    await exposeEnc(pg);
    pg.on('console', m => { const t = m.text(); if (t.startsWith('[export]') || t.startsWith('[convert]') || t.startsWith('[audio]')) console.log('   ' + t); });
    await pg.goto('http://127.0.0.1:' + port + '/tool.html', { waitUntil: 'load' }); await pg.waitForSelector('#wzStart', { timeout: 60000 });
    const t0 = Date.now(); const res = await pg.evaluate(() => window.__selftest()); const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const file = path.join(root, 'out', 'selftest.' + res.ext); fs.mkdirSync(path.join(root, 'out'), { recursive: true }); fs.writeFileSync(file, Buffer.from(res.b64, 'base64'));
    add(res.ext === 'mp4' ? 'PASS' : 'FAIL', 'صيغة الفيديو', res.ext === 'mp4' ? 'MP4 (يقبله تيك توك وفيسبوك)' : 'WebM: تيك توك وفيسبوك سيُتخطّيان. تحقق من خطوة تثبيت ffmpeg');
    const pj = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', file]).stdout || '{}'), vs = (pj.streams || []).find(s => s.codec_type === 'video') || {}, as = (pj.streams || []).find(s => s.codec_type === 'audio') || {};
    add(vs.width === 720 && vs.height === 1280 ? 'PASS' : 'FAIL', 'الدقة', vs.width + '×' + vs.height + ' (' + (vs.codec_name || '?') + ')');
    add(as.codec_name ? 'PASS' : 'FAIL', 'الصوت', as.codec_name ? as.codec_name : 'لا يوجد مسار صوت');
    add('PASS', 'المدة', Number((pj.format || {}).duration).toFixed(1) + ' ثانية (تصدير حقيقي استغرق ' + secs + ' ثانية)');
    // سلاسة الحركة: في التصدير غير المتصل كل إطار مرسوم بزمنه الدقيق؛ نتحقق من العدد والانتظام. وفي الاحتياط الحي نقيس الالتقاط الخام
    const offline = !!(res.report && res.report.mode === 'offline');
    if (offline) {
      const pk = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]).stdout.replace(/,/g, '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const dur = Number((pj.format || {}).duration) || 0, gaps = pk.slice(1).map((t, i) => t - pk[i]), mg = Math.max(0, ...gaps) * 1000, expect = Math.round(dur * 30);
      add('PASS', 'نمط التصدير', 'غير متصل: كل إطار مرسوم بزمنه الدقيق ثم مرمَّز بـffmpeg (لا يتأثر بحمل الجهاز)');
      add(Math.abs(pk.length - expect) <= 3 ? 'PASS' : 'FAIL', 'عدد الإطارات', pk.length + ' إطارًا لمدة ' + dur.toFixed(1) + 'ث (المتوقع ≈ ' + expect + ' بمعدل 30)');
      add(mg <= 40 ? 'PASS' : 'FAIL', 'انتظام الحركة', 'أطول فاصل بين إطارين ' + Math.round(mg) + ' م.ث (الحد 40، أي 30 إطارًا ثابتة)');
    } else {
      add('WARN', 'نمط التصدير', 'تسجيل حي (التصدير غير المتصل غير متاح): السلاسة تتأثر بحمل الجهاز');
      const rawF = path.join(root, 'out', 'selftest-raw.webm'), pk = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', fs.existsSync(rawF) ? rawF : file]).stdout.replace(/,/g, '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const tot = pk.length ? pk[pk.length - 1] : 0, fps = (a, b) => pk.filter(t => t >= a && t < b).length / Math.max(.1, b - a), gaps = pk.slice(1).map((t, i) => t - pk[i]);
      const fi = fps(.6, 2.3), fm = fps(4, Math.max(5, tot - 3)), fo = fps(Math.max(0, tot - 2.3), Math.max(.5, tot - .3)), mg = Math.max(0, ...gaps) * 1000;
      add(fi >= 18 ? 'PASS' : fi >= 12 ? 'WARN' : 'FAIL', 'سلاسة المقدمة', fi.toFixed(1) + ' إطار/ث (الحد الأدنى 18)');
      add(fm >= 22 ? 'PASS' : fm >= 15 ? 'WARN' : 'FAIL', 'سلاسة المشهد الرئيسي', fm.toFixed(1) + ' إطار/ث (الحد الأدنى 22)');
      add(fo >= 18 ? 'PASS' : fo >= 12 ? 'WARN' : 'FAIL', 'سلاسة الخاتمة', fo.toFixed(1) + ' إطار/ث (الحد الأدنى 18)');
      add(mg <= 250 ? 'PASS' : 'WARN', 'أطول توقف في الحركة', Math.round(mg) + ' م.ث (الحد 250)');
    }
    const bd = sh('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.1:pix_th=0.1', '-an', '-f', 'null', '-']); add(/black_start/.test(String(bd.stderr)) ? 'FAIL' : 'PASS', 'إطارات سوداء', /black_start/.test(String(bd.stderr)) ? 'وُجدت إطارات سوداء' : 'لا توجد');
    const eb = sh('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']), pm = String(eb.stderr).split('Summary:').pop().match(/Peak:\s+(-?[\d.]+)\s+dBFS/); const pkdb = pm ? Number(pm[1]) : null;
    add(pkdb == null ? 'WARN' : pkdb <= -1 ? 'PASS' : 'WARN', 'ذروة الصوت', pkdb == null ? 'تعذّر القياس' : pkdb + ' dBFS (المطلوب ≤ −1)');
    if (res.report) add(res.report.degraded ? 'WARN' : 'PASS', 'إعداد التصدير', res.report.w + '×' + res.report.h + '، معدل الرسم ' + res.report.drawFps + ' إطار/ث' + (res.report.degraded ? '، استُخدم إعداد بديل أخف' : ''));
    srv0.close();
  } catch (e) { add('FAIL', 'مسار التصدير', e.message); }
  finally { try { if (browser) await browser.close(); } catch (_) {} }
  const nf = rows.filter(x => x.st === 'FAIL').length, nw = rows.filter(x => x.st === 'WARN').length, np = rows.filter(x => x.st === 'PASS').length;
  fs.mkdirSync(path.join(root, 'out'), { recursive: true }); fs.writeFileSync(path.join(root, 'out', 'selftest-report.json'), JSON.stringify(rows, null, 2));
  console.log('═══ النتيجة: ' + np + ' نجح، ' + nw + ' تحذير، ' + nf + ' فشل ═══');
  console.log(nf ? '❌ النظام غير جاهز: أصلح بنود الفشل أعلاه ثم أعد الفحص.' : nw ? '⚠️ النظام جاهز للتشغيل مع ملاحظات في التحذيرات أعلاه.' : '✅ النظام جاهز للتشغيل الكامل.');
  notify('فحص الجاهزية', np + ' نجح / ' + nw + ' تحذير / ' + nf + ' فشل\n' + rows.filter(x => x.st !== 'PASS').map(x => x.name + ': ' + x.detail).join('\n'));
  process.exit(nf ? 1 : 0);
}
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

// مفتاح ElevenLabs: لا نشترط بادئة معيّنة (مفاتيح قديمة بلا sk_). نفحصه بطلب مجاني، ونتجاهله فقط إن رُفض صراحة (غالبًا وُضع «معرّف المفتاح» لا المفتاح نفسه)
let elKey = (E.ELEVEN_KEY || '').trim();
if (elKey && (/\s/.test(elKey) || elKey.length < 20)) { console.log('⚠ ELEVEN_KEY يبدو غير صالح (فيه مسافات أو قصير جدًا) فسيُتجاهل.'); elKey = ''; }
if (elKey) {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': elKey }, signal: AbortSignal.timeout(20000) });
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (r.ok) console.log('✔ ElevenLabs: المفتاح صالح (طوله ' + elKey.length + ' حرفًا)');
    else if (r.status === 401 && j.detail && j.detail.status === 'missing_permissions') console.log('✔ ElevenLabs: المفتاح صالح لكن بلا صلاحية قراءة الحساب (طبيعي)، سيُستخدم للمحاذاة والتفريغ');
    else if (r.status === 401) { console.log('⚠ ElevenLabs رفض المفتاح (401). غالبًا وُضع «معرّف المفتاح» بدل المفتاح السرّي. سيُتجاهل وسيبقى التوقيت تقديريًا.'); elKey = ''; }
    else console.log('⚠ ElevenLabs ردّ HTTP ' + r.status + ' عند الفحص؛ سيُستخدم المفتاح كما هو.');
  } catch (e) { console.log('⚠ تعذّر فحص ElevenLabs (' + e.message + ')؛ سيُستخدم المفتاح كما هو.'); }
}
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
  { const have = new Set(chs.map(c => String(c.platform).toLowerCase())), miss = ['youtube', 'tiktok', 'facebook'].filter(p => !have.has(p)); if (miss.length) console.log('⚠ منصات مستهدفة غير مربوطة في BulkPublish: ' + miss.join('، ')); }
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
    { const tp = Object.assign({}, settings.template || {}); if (keys.el) tp.elAuto = true; if (settings.template || keys.el) localStorage.setItem('tabiin_template_v3', JSON.stringify(tp)); }   // المحاذاة الدقيقة تُفعَّل دائمًا عند وجود مفتاح ElevenLabs
    const v = Object.assign({}, settings.video || {}); if (keys.ntfy) v.wzNtfy = keys.ntfy; v.wzAutoMix = true;
    localStorage.setItem('tabiin_video_v1', JSON.stringify(v));
  } catch (e) {}
}, { keys, settings });
const page = await ctx.newPage();
console.log(HAS_FFMPEG ? '✔ ffmpeg متاح: سيُحوَّل WebM إلى MP4' : '⚠ ffmpeg غير متاح: ستبقى الفيديوهات WebM وسيتخطى النشر تيك توك وفيسبوك');
await page.exposeFunction('__ffmpegConvert', async b64 => convertB64(b64));
await exposeEnc(page);   // يفعّل التصدير غير المتصل (30 إطارًا ثابتة ومزامنة دقيقة)
page.on('pageerror', e => console.log('⚠ خطأ في الصفحة:', e.message));
page.on('dialog', d => d.accept().catch(() => {}));
// خطة التقسيم التي تطبعها الأداة (عدد الفصول ونسبة تغطية الصوت) تظهر في سجل GitHub
page.on('console', m => { const t = m.text(); if (t.startsWith('[plan]') || t.startsWith('[bp]') || t.startsWith('[audio]') || t.startsWith('[export]') || t.startsWith('[timing]') || t.startsWith('[sync]') || t.startsWith('[convert]')) console.log(t); });
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

const seenLines = new Set(); let lastProg = '', lastPct = -1, lastPctAt = Date.now(), analyzing = true;
const logTimer = setInterval(async () => {
  try {
    const t = await page.evaluate(() => (document.getElementById('wzNote') || {}).textContent || ''); const p = await page.evaluate(() => (document.getElementById('wzProgTxt') || {}).textContent || '');
    t.split('\n').map(s => s.trim()).filter(Boolean).forEach(s => { if (!seenLines.has(s)) { seenLines.add(s); console.log(s); } });   // أسطر جديدة فقط
    const pp = p.trim(); if (pp && pp !== lastProg) { lastProg = pp; console.log('  ▸ ' + pp); }
    const m = pp.match(/(\d+)٪/); if (m) { const v = Number(m[1]); if (v !== lastPct) { lastPct = v; lastPctAt = Date.now(); } }
    // حارس التعثر: لا تقدّم في التحليل منذ 8 دقائق ⇒ توقف مبكر برسالة واضحة بدل انتظار المهلة الكاملة
    if (analyzing && lastPct >= 0 && Date.now() - lastPctAt > 12 * 60 * 1000) { clearInterval(logTimer); fail('توقف التحليل عند ' + lastPct + '٪ منذ أكثر من 12 دقيقة (غالبًا ازدحام أو حدّ استخدام Gemini: 503/429). أعد التشغيل بعد قليل أو استخدم مفتاحًا آخر.', 1); }
  } catch (e) {}
}, 15000);

if (E.RECITER) await page.fill('#wzReciter', E.RECITER);
if (person) await page.setInputFiles('#wzImg', person);
await page.setInputFiles('#wzAudio', audio);
if (bgm) { await page.setInputFiles('#wzBgm', bgm); await page.waitForTimeout(8000); }
// الحقلان داخل قسم مخفي حتى توجد مقاطع محفوظة، فنضبطهما برمجياً بدل الكتابة
await page.evaluate(({ d, t }) => { for (const [id, v] of [['wzSchedDate', d], ['wzSchedTime', t]]) { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }, { d: E.START_DATE, t: E.TIME || '19:00' });

console.log('▶ بدء التحليل...');
await page.click('#wzStart');
try { await page.waitForFunction(() => window.__apState === 'ready' || window.__apState === 'error', null, { timeout: 35 * 60 * 1000, polling: 3000 }); }
catch (e) { clearInterval(logTimer); await page.screenshot({ path: path.join(root, 'out', 'analysis-timeout.png') }).catch(() => {}); await browser.close().catch(() => {}); fail('انتهت مهلة التحليل (35 دقيقة) عند: ' + (lastProg || 'غير معروف'), 1); }
analyzing = false;
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
const unsched = (() => { const s = new Set(); for (const m of finalNote.matchAll(/(\d+)\. [^\n]*?فشل النشر\/الجدولة/g)) s.add(m[1]); return s.size; })();   // عدّ المقاطع الفاشلة دون تكرار
if (failed) fail(failed + ' من الفصول فشلت. راجع السجل', 1);
if (unsched) fail(unsched + ' من الفيديوهات أُنشئت لكن لم تُجدول في BulkPublish. راجع السبب في السجل (مثلاً امتلاء مساحة الوسائط في الخطة المجانية)، والفيديوهات محفوظة في Artifacts', 1);
console.log('✅ انتهى: الفيديوهات أُنشئت وقَبِل BulkPublish جدولتها. هذا لا يثبت النشر العام الفعلي على كل منصة؛ تحقق من لوحة BulkPublish ومن كل منصة عند موعد النشر.');
