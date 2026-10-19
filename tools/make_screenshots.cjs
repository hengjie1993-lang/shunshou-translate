/**
 * 生成 README 里用的设置页截图：
 *   docs/screenshots/1-options-light.png   1280×800
 *   docs/screenshots/2-options-dark.png    1280×800
 *
 * 先灌一份演示配置（两家服务商 + 实测延迟），再重启后台 Service Worker
 * —— 否则截到的是空状态和「测速中」骨架条。
 *
 * 技巧：viewport 设 800×500 + deviceScaleFactor 1.6 → 输出正好 1280×800，
 * 但页面按 800 CSS px 排版，640px 的设置页容器不会显得空荡。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PROFILE = path.join(require('os').tmpdir(), 'shunshou-shot');
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

  await b.close();
})().catch((e) => {
  console.error('异常:', e.message);
  process.exit(1);
});
