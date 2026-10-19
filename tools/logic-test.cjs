/**
 * 内容脚本触发逻辑回归测试（8 个用例）
 *
 * 做法：用 Playwright 打开一个本地测试页，注入 mock 的 chrome API，
 * 再注入 content/content.js，然后模拟真实按键，验证触发与回填。
 * 不依赖真实扩展加载，因此不受 Chrome 版本限制。
 *
 * 依赖：playwright-core（在 node 隔离工作区）
 * 运行：
 *   NODE_PATH="<node工作区>/node_modules" \
 *   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" \
 *   node tools/logic-test.cjs "<插件目录绝对路径>"
 *
 * 覆盖：input / textarea / contenteditable / 受控组件 / 只敲两次 / 超时窗口 /
 *       中途打断 / 输入法组合态 / 重复注入守卫
 */

/* 隔离测试内容脚本逻辑：mock chrome API，注入 content.js，验证触发与回填 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT = process.argv[2];
const CONTENT_JS = fs.readFileSync(path.join(EXT, 'content/content.js'), 'utf8');

const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
<input id="a" type="text" style="width:420px;padding:8px">
<textarea id="b" rows="3" style="width:420px;padding:8px"></textarea>
<div id="c" contenteditable="true" style="width:420px;min-height:70px;border:1px solid #ccc;padding:8px"></div>
<input id="d" type="text" style="width:420px;padding:8px">
<script>
  // 模拟 React 受控组件：input 事件把值同步回状态，blur 时回写
  (function () {
    var el = document.getElementById('d'), state = '';
    el.addEventListener('input', function () { state = el.value; });
    el.addEventListener('blur', function () { el.value = state; });
  })();
</script>
</body></html>`;

const MOCK = `
window.chrome = {
  storage: {
    local: {
      get: function () {
        return Promise.resolve({
          enabled: true,
          providers: [{
            id: 'test', name: 'Test Provider',
            endpoint: 'https://example.com/v1/chat/completions',
            model: 'test-model', apiKey: 'test-key', enabled: true
          }],
          targetLang: 'en',
          triggerCount: 3, triggerWindow: 500, blacklist: [], maxChars: 8000,
          engines: { google: true, local: false }
        });
      }
    },
    onChanged: { addListener: function () {} }
  },
  runtime: {
    sendMessage: function (msg) {
      window.__sent = window.__sent || [];
      window.__sent.push(msg);
      // 免费通道故意返回失败 —— 这样才继续覆盖「回退到 AI 服务商」那条主链路。
      // 如果这里一律返回成功，测出来的就只是免费通道，AI 服务商那半边等于没测。
      if (msg && msg.type === 'translateFree') {
        return Promise.resolve({ ok: false, code: 'engine_off', error: '测试环境关闭' });
      }
      return Promise.resolve({ ok: true, text: '[EN] ' + msg.text, ms: 120 });
    },
    openOptionsPage: function () {}
  },
  i18n: {
    detectLanguage: function (text, cb) {
      const r = { isReliable: true, languages: [{ language: 'zh', percentage: 100 }] };
      if (typeof cb === 'function') cb(r);
      return Promise.resolve(r);
    }
  }
};
`;

const log = (...a) => console.log(...a);

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined
  });
  const page = await browser.newPage();
  page.on('console', (m) => log('[page]', m.text()));
  page.on('pageerror', (e) => log('[pageerror]', e.message));

  await page.addInitScript(MOCK);
  await page.goto(url);
  await page.addScriptTag({ content: CONTENT_JS });
  // 故意重复注入第二次，验证防重复守卫（若失效，2 次空格就会触发）
  await page.addScriptTag({ content: CONTENT_JS });
  await page.addScriptTag({ content: CONTENT_JS });
  await page.waitForTimeout(300);

  log('mock chrome 注入完成，content.js 已重复注入 3 次\n');

  async function space(n, gap) {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(' ');
      if (i < n - 1) await page.waitForTimeout(gap);
    }
  }

  // 用例 1：input 正常触发
  log('=== 用例1：input + 三连空格 ===');
  const a = page.locator('#a');
  await a.click();
  await page.keyboard.type('今天天气很好', { delay: 20 });
  await page.waitForTimeout(60);
  await space(3, 60);
  await page.waitForTimeout(600);
  log('  结果:', JSON.stringify(await a.inputValue()));

  // 用例 2：textarea
  log('=== 用例2：textarea ===');
  const b = page.locator('#b');
  await b.click();
  await page.keyboard.type('请确认会议时间', { delay: 20 });
  await page.waitForTimeout(60);
  await space(3, 60);
  await page.waitForTimeout(600);
  log('  结果:', JSON.stringify(await b.inputValue()));

  // 用例 3：contenteditable
  log('=== 用例3：contenteditable ===');
  const c = page.locator('#c');
  await c.click();
  await page.keyboard.type('这个功能很好用', { delay: 20 });
  await page.waitForTimeout(60);
  await space(3, 60);
  await page.waitForTimeout(600);
  log('  结果:', JSON.stringify(await c.innerText()));

  // 用例 4：受控组件
  log('=== 用例4：模拟受控组件 ===');
  const d = page.locator('#d');
  await d.click();
  await page.keyboard.type('受控组件测试', { delay: 20 });
  await page.waitForTimeout(60);
  await space(3, 60);
  await page.waitForTimeout(600);
  log('  结果:', JSON.stringify(await d.inputValue()));

  // 用例 5：只敲两次空格，不该触发
  log('=== 用例5：只敲两次空格（应不触发）===');
  await a.fill('');
  await a.click();
  await page.keyboard.type('两次不该触发', { delay: 20 });
  await page.waitForTimeout(60);
  await space(2, 60);
  await page.waitForTimeout(600);
  log('  结果:', JSON.stringify(await a.inputValue()), '（期望仍是中文+空格）');

  // 用例 6：间隔超过时间窗口，不该触发
  log('=== 用例6：空格间隔 700ms（应不触发）===');
  await a.fill('');
  await a.click();
  await page.keyboard.type('慢速不该触发', { delay: 20 });
  await page.waitForTimeout(60);
  await space(3, 700);
  await page.waitForTimeout(600);
  log('  结果:', JSON.stringify(await a.inputValue()), '（期望仍是中文+空格）');

  // 用例 7：非空格键打断计数
  log('=== 用例7：空格-空格-字母-空格（应不触发）===');
  await a.fill('');
  await a.click();
  await page.keyboard.type('打断测试', { delay: 20 });
  await page.waitForTimeout(60);
  await page.keyboard.press(' ');
  await page.waitForTimeout(60);
  await page.keyboard.press(' ');
  await page.waitForTimeout(60);
  await page.keyboard.press('x');
  await page.waitForTimeout(60);
  await page.keyboard.press(' ');
  await page.waitForTimeout(600);
  log('  结果:', JSON.stringify(await a.inputValue()));

  // 用例 8：IME 组合态不触发（模拟 isComposing）
  log('=== 用例8：isComposing 时不计数 ===');
  await a.fill('');
  await a.click();
  await page.keyboard.type('输入法测试', { delay: 20 });
  await page.evaluate(() => {
    const el = document.getElementById('a');
    for (let i = 0; i < 3; i++) {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ', code: 'Space', keyCode: 32, isComposing: true, bubbles: true, cancelable: true
      }));
    }
  });
  await page.waitForTimeout(600);
  log('  结果:', JSON.stringify(await a.inputValue()), '（期望未触发翻译）');

  const sent = await page.evaluate(() => window.__sent || []);
  log('\n实际发给后台的请求数:', sent.length, JSON.stringify(sent));

  /* ---- 校验「免费引擎优先」的调用顺序 ---- */
  // 每次翻译都应该先试 translateFree；它失败后才回退到 translate（AI 服务商）。
  // 顺序反了的话，免费引擎就形同虚设 —— 每次都在白等 AI 接口。
  const freeCalls = sent.filter((m) => m.type === 'translateFree');
  const aiCalls = sent.filter((m) => m.type === 'translate');
  const orderOk = freeCalls.every((m, i) => {
    const idxFree = sent.indexOf(m);
    const next = sent[idxFree + 1];
    return next && next.type === 'translate' && next.text === m.text;
  });
  const problems = [];
  if (freeCalls.length === 0) problems.push('免费引擎一次都没被调用');
  if (aiCalls.length === 0) problems.push('免费引擎失败后没有回退到 AI 服务商');
  if (freeCalls.length && !orderOk) problems.push('调用顺序不对：不是「先免费、后 AI」');
  if (freeCalls.length !== aiCalls.length) {
    problems.push(`免费通道 ${freeCalls.length} 次 vs AI 回退 ${aiCalls.length} 次，数量对不上`);
  }

  log('免费通道调用:', freeCalls.length, '次 | AI 服务商回退:', aiCalls.length, '次');
  log(
    problems.length
      ? '\n❌ 免费引擎链路有问题: ' + problems.join('; ')
      : '\n✅ 免费引擎链路正常（先免费通道、失败自动回退 AI 服务商）'
  );

  await browser.close();
  server.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e);
  process.exit(1);
});
