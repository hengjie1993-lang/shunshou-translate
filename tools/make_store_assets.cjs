/**
 * 生成 Chrome 应用商店上架素材：
 *   docs/screenshots/1-options-light.png   1280×800
 *   docs/screenshots/2-options-dark.png    1280×800
 *   docs/promo-440x280.png                 440×280（小型宣传图块）
 *
 * 技巧：viewport 设 800×500 + deviceScaleFactor 1.6 → 输出正好 1280×800，
 * 但页面按 800 CSS px 排版，640px 的设置页容器不会显得空荡。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PROFILE = path.join(require('os').tmpdir(), 'agnes-store-shot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

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

  const optUrl = `chrome-extension://${id}/options/options.html`;

  // ---------- 灌一份「已配好两家、已测速」的演示数据 ----------
  // 空状态截图放到商店里等于告诉审核员「这东西还没做完」，必须先填。
  const now = Date.now();
  const stat = (emaMs, samples) => ({
    emaMs, samples, fails: 0, failStreak: 0, cooldownUntil: 0,
    lastOkAt: now, lastCode: '', probedAt: now, probeCode: '', updatedAt: now
  });
  const seed = await b.newPage();
  await seed.goto(optUrl, { waitUntil: 'load' });
  await sleep(800);
  await seed.evaluate(async (demo) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(demo);
  }, {
    enabled: true,
    targetLang: 'en',
    tone: 'natural',
    triggerCount: 3,
    triggerWindow: 500,
    blacklist: ['mail.google.com', 'docs.google.com'],
    maxChars: 8000,
    cacheEnabled: true,
    deadlineMs: 45000,
    engines: { google: true, local: true },
    providers: [
      {
        id: 'groq', name: 'Groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'openai/gpt-oss-120b',
        apiKey: 'gsk_demo_0000000000000000000000000000', enabled: true
      },
      {
        id: 'zhipu', name: '智谱 GLM',
        endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        model: 'glm-4-flash',
        apiKey: 'demo0000000000000000000000000000.abcdefghijklmnop', enabled: true
      }
    ],
    providerStats: { groq: stat(734, 10), zhipu: stat(1136, 5) }
  });
  await seed.close();
  console.log('已灌入演示配置（2 家服务商 + 实测延迟）');

  // 后台 Service Worker 把统计缓存在内存里，直接写 storage 它看不见。
  // 把 SW 关掉，下次页面发消息时它会冷启动并从 storage 重新读一遍。
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos) {
    if (t.type === 'service_worker' && t.url.includes(id)) {
      await cdp.send('Target.closeTarget', { targetId: t.targetId });
      console.log('已重启后台 Service Worker');
    }
  }
  await sleep(1200);

  const shoot = async (url, file, { dark = false, css = '', wait = 3500, scroll = 0 } = {}) => {
    const p = await b.newPage();
    await p.setViewport({ width: 800, height: 500, deviceScaleFactor: 1.6 });
    await p.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }
    ]);
    await p.goto(url, { waitUntil: 'load' });
    if (css) await p.addStyleTag({ content: css });
    await sleep(wait);
    if (scroll) {
      await p.evaluate((y) => window.scrollTo(0, y), scroll);
      await sleep(600);
    }
    await p.screenshot({ path: path.join(OUT, file) });
    console.log(`✅ ${file}`);
    await p.close();
  };

  await shoot(optUrl, '1-options-light.png');
  await shoot(optUrl, '2-options-dark.png', { dark: true, scroll: 620 });

  // 弹窗没截：popup.html 被当成普通标签页打开时，chrome.tabs.query 拿到的
  // active tab 就是它自己，界面会显示「此页面不支持翻译」。要截出正常状态
  // 得 monkey-patch chrome.tabs，那就不再是真实界面了，宁可不放。

  // ---------- 440×280 宣传图块 ----------
  const iconB64 = fs.readFileSync(path.join(ROOT, 'icons', 'icon128.png')).toString('base64');
  const promo = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{width:440px;height:280px;overflow:hidden}
    body{
      background:radial-gradient(130% 130% at 8% 0%, #33457a 0%, #1b2033 48%, #0e1016 100%);
      font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      color:#f2f4f8;display:flex;flex-direction:column;justify-content:center;
      padding:34px 34px 30px;position:relative;
    }
    .glow{position:absolute;width:300px;height:300px;border-radius:50%;
      background:radial-gradient(circle,#5b7cff55 0%,transparent 68%);
      right:-90px;top:-110px;filter:blur(6px)}
    .row{display:flex;align-items:center;gap:13px;position:relative}
    img{width:52px;height:52px;border-radius:13px;box-shadow:0 8px 22px #0006}
    h1{font-size:30px;letter-spacing:-0.5px;font-weight:700;line-height:1}
    .tag{margin-top:22px;font-size:19px;line-height:1.5;font-weight:600;
      color:#e8ecf5;position:relative}
    .tag b{color:#8fb0ff}
    .keys{margin-top:16px;display:flex;gap:7px;position:relative}
    .key{
      width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;
      background:#ffffff14;border:1px solid #ffffff22;font-size:12px;color:#c9d3e8;
      box-shadow:0 2px 0 #ffffff10 inset,0 3px 8px #0004;
    }
    .key.on{background:#4f74ff2e;border-color:#7f9dff88;color:#dbe5ff}
    .hint{margin-top:13px;font-size:12.5px;color:#98a3bb;letter-spacing:.2px;position:relative}
  </style></head><body>
    <div class="glow"></div>
    <div class="row">
      <img src="data:image/png;base64,${iconB64}">
      <h1>顺手翻译</h1>
    </div>
    <div class="tag">连敲三下空格，<b>原地变成英文</b></div>
    <div class="keys">
      <div class="key on">中</div><div class="key on">文</div>
      <div class="key">⎵</div><div class="key">⎵</div><div class="key on">⎵</div>
    </div>
    <div class="hint">任意网页输入框 · 零配置 · 断网可用</div>
  </body></html>`;

  const pp = await b.newPage();
  await pp.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
  await pp.setContent(promo, { waitUntil: 'load' });
  await sleep(400);
  await pp.screenshot({ path: path.join(ROOT, 'docs', 'promo-440x280.png') });
  console.log('✅ promo-440x280.png');
  await pp.close();

  await b.close();
})().catch((e) => {
  console.error('异常:', e.message);
  process.exit(1);
});
