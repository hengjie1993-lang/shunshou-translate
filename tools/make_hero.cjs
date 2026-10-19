/**
 * 生成商店主图：真实页面里「中文 → 三下空格 → 英文」的前后对比。
 *
 * 不是 P 图 —— 真的在本地起一个页面、真的敲键、真的走谷歌免费通道翻译，
 * 截的是翻译完成那一刻的真实界面。
 *
 * 产物：docs/screenshots/0-hero.png  1280×800
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PROFILE = path.join(require('os').tmpdir(), 'shunshou-hero-shot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOURCE = '这个功能挺好用的，我以后写英文邮件就靠它了。';

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:#eef1f6;color:#1f2328;padding:44px 32px;min-height:100vh;
  }
  .card{
    max-width:620px;margin:0 auto;background:#fff;border-radius:14px;
    box-shadow:0 1px 2px rgba(16,24,40,.06),0 12px 32px rgba(16,24,40,.08);
    overflow:hidden;
  }
  .head{padding:20px 24px;border-bottom:1px solid #eceff4;display:flex;align-items:center;gap:11px}
  .avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#7c9cf5,#4f6fe0)}
  .who{font-weight:600;font-size:14px}
  .sub{font-size:12px;color:#8b93a1;margin-top:1px}
  .body{padding:20px 24px 24px}
  label{display:block;font-size:12.5px;color:#6b7280;margin-bottom:8px;letter-spacing:.2px}
  textarea{
    width:100%;height:190px;resize:none;padding:15px 16px;border-radius:10px;
    border:1px solid #d8dee8;font:inherit;line-height:1.75;color:#1f2328;
    outline:none;background:#fcfdff;transition:border-color .15s,box-shadow .15s;
  }
  textarea:focus{border-color:#5b7fe8;box-shadow:0 0 0 3px rgba(91,127,232,.14);background:#fff}
  .foot{display:flex;align-items:center;justify-content:space-between;margin-top:14px}
  .hint{font-size:12.5px;color:#8b93a1}
  .hint kbd{
    display:inline-block;padding:1px 6px;margin:0 1px;border-radius:4px;
    background:#eef1f6;border:1px solid #dfe4ec;border-bottom-width:2px;
    font:inherit;font-size:11.5px;color:#5b6472;
  }
  .btn{
    padding:8px 18px;border-radius:8px;background:#2f6bff;color:#fff;
    font-size:13.5px;font-weight:600;border:0;box-shadow:0 1px 2px rgba(47,107,255,.3)
  }
</style></head><body>
  <div class="card">
    <div class="head">
      <div class="avatar"></div>
      <div>
        <div class="who">回复 Jordan Lee</div>
        <div class="sub">Product Sync · 刚刚</div>
      </div>
    </div>
    <div class="body">
      <label>内容</label>
      <textarea id="t" autofocus>${SOURCE}</textarea>
      <div class="foot">
        <div class="hint">写完连敲 <kbd>空格</kbd><kbd>空格</kbd><kbd>空格</kbd> 自动翻译</div>
        <button class="btn">发送</button>
      </div>
    </div>
  </div>
</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('本地测试页:', `http://127.0.0.1:${port}/`);

  const b = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    userDataDir: PROFILE,
    pipe: true,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
      '--hide-scrollbars'
    ]
  });

  const cdp = await b.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
  await sleep(1500);

  // 灌设置：只开免费通道，不需要任何 Key
  const seed = await b.newPage();
  await seed.goto(`chrome-extension://${id}/options/options.html`, { waitUntil: 'load' });
  await sleep(700);
  await seed.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      enabled: true, targetLang: 'en', tone: 'natural',
      triggerCount: 3, triggerWindow: 500,
      blacklist: [], maxChars: 8000, cacheEnabled: true, deadlineMs: 45000,
      engines: { google: true, local: false },
      providers: []
    });
  });
  await seed.close();

  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos) {
    if (t.type === 'service_worker' && t.url.includes(id)) {
      await cdp.send('Target.closeTarget', { targetId: t.targetId });
    }
  }
  await sleep(900);

  const p = await b.newPage();
  await p.setViewport({ width: 800, height: 500, deviceScaleFactor: 1.6 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await sleep(1200);

  // 全选清空后重新输入，确保走的是「用户输入」路径而不是预填内容
  await p.click('#t');
  await p.evaluate(() => {
    const t = document.getElementById('t');
    t.value = '';
    t.focus();
  });
  await p.keyboard.type(SOURCE, { delay: 18 });
  await sleep(180);
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press('Space');
    await sleep(70);
  }
  console.log('已敲三次空格，等待翻译…');

  let value = '';
  let ms = 0;
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    value = await p.$eval('#t', (el) => el.value);
    if (value && !/[\u4e00-\u9fa5]/.test(value)) { ms = Date.now() - t0; break; }
  }

  console.log(`译文: ${value}`);
  console.log(`耗时: ${ms}ms`);

  if (!value || /[\u4e00-\u9fa5]/.test(value)) {
    console.error('❌ 没有翻译成功，主图不生成（避免截到失败画面）');
    await b.close();
    server.close();
    process.exit(1);
  }

  // 等 toast 淡出，只留干净的输入框
  await sleep(1600);

  // 加一条说明条 —— 否则看图的人只看到「一个填了英文的表单」，看不出是插件干的
  // 图标必须内联成 data URI：普通网页加载不了 chrome-extension:// 资源
  const iconB64 = fs.readFileSync(path.join(ROOT, 'icons', 'icon32.png')).toString('base64');
  await p.evaluate((icon) => {
    const bar = document.createElement('div');
    bar.style.cssText = `
      position:fixed;left:50%;bottom:26px;transform:translateX(-50%);
      display:flex;align-items:center;gap:10px;
      padding:11px 20px 11px 14px;border-radius:999px;
      background:#fff;border:1px solid #e3e8f0;
      box-shadow:0 2px 6px rgba(16,24,40,.06),0 14px 34px rgba(16,24,40,.12);
      font:600 15px/1 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      color:#1f2328;white-space:nowrap;z-index:999999;`;
    bar.innerHTML = `
      <img src="data:image/png;base64,${icon}"
           style="width:26px;height:26px;border-radius:7px;display:block">
      <span>连敲三下空格，<span style="color:#2f6bff">中文原地变英文</span></span>`;
    document.body.appendChild(bar);
  }, iconB64);
  await sleep(350);

  await p.screenshot({ path: path.join(OUT, '0-hero.png') });
  console.log('✅ 0-hero.png');

  await b.close();
  server.close();
})().catch((e) => {
  console.error('异常:', e.message);
  process.exit(1);
});
