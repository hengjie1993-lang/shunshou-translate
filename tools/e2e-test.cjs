/**
 * 全链路端到端测试：真实加载扩展 + 真实调用 Agnes API
 *
 * 验证：清单是否合法、service worker 是否注册、内容脚本是否注入、
 *       三连空格是否触发、真实译文是否回填。
 *
 * 依赖：playwright-core
 * 运行：
 *   NODE_PATH="<node工作区>/node_modules" \
 *   CHROME_PATH="<支持 --load-extension 的 Chromium 路径>" \
 *   AGNES_API_KEY="sk-..." NODE_USE_ENV_PROXY=1 \
 *   node tools/e2e-test.cjs "<插件目录绝对路径>"
 *
 * 注意：Chrome 137+ 已移除命令行 --load-extension 开关，
 *       用系统 Chrome 会加载不上扩展。需改用较旧的 Chromium
 *       （例如 Playwright 缓存的 chromium-xxxx/chrome-win64/chrome.exe）。
 *       仅验证触发逻辑的话，用 tools/logic-test.cjs 即可。
 */

/* 端到端复现测试：真实 Chromium 加载插件，验证三连空格翻译 */
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT = process.argv[2];
const KEY = process.env.AGNES_API_KEY || '';

const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>t</title></head><body>
<h1>test</h1>
<input id="a" type="text" style="width:420px;padding:8px">
<textarea id="b" rows="3" style="width:420px;padding:8px"></textarea>
<div id="c" contenteditable="true" style="width:420px;min-height:70px;border:1px solid #ccc;padding:8px"></div>
</body></html>`;

const log = (...a) => console.log(...a);

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  log('serving at', url);

  const userDataDir = path.join(require('os').tmpdir(), 'pw-ext-' + Date.now());
  log('extension path:', EXT);

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch,DialMediaRouteProvider',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    viewport: { width: 1100, height: 760 }
  });

  log('--- 等待 service worker ---');
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    } catch (e) {
      log('!! 没等到 service worker —— 插件可能加载失败');
    }
  }

  let extId = '(unknown)';
  if (sw) {
    extId = new URL(sw.url()).host;
    log('Extension ID:', extId);
    log('SW url:', sw.url());
  }

  if (sw && KEY) {
    await sw.evaluate(async (k) => {
      await chrome.storage.local.set({
        enabled: true,
        apiKey: k,
        targetLang: 'en',
        triggerCount: 3,
        triggerWindow: 500,
        blacklist: [],
        maxChars: 8000
      });
    }, KEY);
    const back = await sw.evaluate(async () => await chrome.storage.local.get(['apiKey']));
    log('API key 写入后读回:', JSON.stringify(back));
  }

  const page = await ctx.newPage();
  page.on('console', (m) => log('[page:' + m.type() + ']', m.text()));
  page.on('pageerror', (e) => log('[pageerror]', e.message));
  if (sw) sw.on('console', (m) => log('[sw:' + m.type() + ']', m.text()));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // 等 onInstalled 的 ensureDefaults 跑完后再写 Key，避免竞态覆盖
  if (sw && KEY) {
    await sw.evaluate(async (k) => {
      await chrome.storage.local.set({
        enabled: true,
        apiKey: k,
        targetLang: 'en',
        triggerCount: 3,
        triggerWindow: 500,
        blacklist: [],
        maxChars: 8000
      });
    }, KEY);
    await page.waitForTimeout(500);
    const back = await sw.evaluate(async () => await chrome.storage.local.get(['apiKey']));
    log('API key 读回:', JSON.stringify(back));
  }

  // 判断内容脚本是否注入：检查 content.css 是否进入 document.styleSheets
  const cssInjected = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText && rule.cssText.indexOf('agnes-toast') !== -1) return true;
        }
      } catch (e) { /* 跨域样式表 */ }
    }
    return false;
  });
  log('内容脚本 CSS 是否注入:', cssInjected);

  // 检查 storage 实际值
  if (sw) {
    const st = await sw.evaluate(async () => await chrome.storage.local.get(null));
    log('storage:', JSON.stringify(st));
  }

  log('--- 开始测试 input ---');
  const input = page.locator('#a');
  await input.click();
  await page.keyboard.type('今天天气很好', { delay: 25 });
  await page.waitForTimeout(80);
  await page.keyboard.press(' ');
  await page.waitForTimeout(50);
  await page.keyboard.press(' ');
  await page.waitForTimeout(50);
  await page.keyboard.press(' ');
  log('已连敲三次空格，等待翻译…');
  await page.waitForTimeout(8000);

  const v1 = await input.inputValue();
  log('input 结果:', JSON.stringify(v1));

  const toast = await page.evaluate(() => {
    const el = document.querySelector('.agnes-toast');
    return el ? el.textContent : null;
  });
  log('toast:', JSON.stringify(toast));

  log('--- 开始测试 textarea ---');
  const ta = page.locator('#b');
  await ta.click();
  await page.keyboard.type('请确认会议时间', { delay: 25 });
  await page.waitForTimeout(80);
  await page.keyboard.press(' ');
  await page.waitForTimeout(50);
  await page.keyboard.press(' ');
  await page.waitForTimeout(50);
  await page.keyboard.press(' ');
  await page.waitForTimeout(8000);
  log('textarea 结果:', JSON.stringify(await ta.inputValue()));

  log('--- 开始测试 contenteditable ---');
  const ed = page.locator('#c');
  await ed.click();
  await page.keyboard.type('这个功能很好用', { delay: 25 });
  await page.waitForTimeout(80);
  await page.keyboard.press(' ');
  await page.waitForTimeout(50);
  await page.keyboard.press(' ');
  await page.waitForTimeout(50);
  await page.keyboard.press(' ');
  await page.waitForTimeout(8000);
  log('contenteditable 结果:', JSON.stringify(await ed.innerText()));

  await page.screenshot({ path: path.join(require('os').tmpdir(), 'agnes-e2e.png') });
  log('截图已保存');

  await ctx.close();
  server.close();
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
