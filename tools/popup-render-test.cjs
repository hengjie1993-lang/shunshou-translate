/* Popup 页渲染自检：
 *  场景 A —— 普通网页：自检显示「已就绪」，智能模式显示优先使用哪家
 *  场景 B —— 新标签页（chrome://newtab）：内容脚本无法注入，应引导用户用「快捷翻译」
 *             并验证快捷翻译框真的能翻译
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

function serve(root) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    if (rel === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    fs.readFile(path.join(root, rel), (err, buf) => {
      if (err) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(path.join(root, rel))] || 'application/octet-stream' });
      res.end(buf);
    });
  });

  // 端口必须落在 20000-60000：Chrome 有一份 unsafe port 黑名单（5060/5061/6000/10080…），
  // 用 listen(0) 随机到 5061 会直接被 ERR_UNSAFE_PORT 拒掉。
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      tries += 1;
      const port = 20000 + Math.floor(Math.random() * 30000);
      const onError = (err) => {
        if (tries < 10) attempt();
        else reject(err);
      };
      srv.once('error', onError);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', onError);
        resolve({ srv, port: srv.address().port });
      });
    };
    attempt();
  });
}

const problems = [];
const note = (msg) => problems.push(msg);

/* --------------------------------- mock 注入 --------------------------------- */

function mockChrome({ tabUrl, pingOk, swVersion, diskVersion = '9.9.9-test' }) {
  // 真实扩展里 manifest.json 是磁盘文件，这里用 fetch 拦截伪造「磁盘版本」。
  // 默认与页面版本一致 → 版本自检不该报警。
  const runningSw = swVersion === undefined ? '9.9.9-test' : swVersion;

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (u, init) => {
    if (/manifest\.json/.test(String(u))) {
      return Promise.resolve(
        new Response(JSON.stringify({ version: diskVersion }), {
          headers: { 'Content-Type': 'application/json' }
        })
      );
    }
    return realFetch(u, init);
  };

  const store = {
    enabled: true,
    targetLang: 'en',
    triggerCount: 3,
    providers: [
      { id: 'p1', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_x', enabled: true },
      { id: 'p2', name: 'Agnes AI', endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions', model: 'agnes-2.0-flash', apiKey: 'sk_y', enabled: true }
    ],
    providerStats: {
      p1: { emaMs: 1200, samples: 6, fails: 0, failStreak: 0, cooldownUntil: 0, updatedAt: Date.now() },
      p2: { emaMs: 3000, samples: 6, fails: 0, failStreak: 0, cooldownUntil: 0, updatedAt: Date.now() }
    }
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: (k) => {
          const l = Array.isArray(k) ? k : Object.keys(store);
          const o = {};
          l.forEach((x) => { if (x in store) o[x] = store[x]; });
          return Promise.resolve(o);
        },
        set: (o) => { Object.assign(store, o); return Promise.resolve(); }
      }
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: tabUrl }]),
      sendMessage: () => {
        if (!pingOk) return Promise.reject(new Error('Could not establish connection'));
        return Promise.resolve({ ok: true, active: true, enabled: true, hasKey: true, blacklisted: false, triggerCount: 3, targetLang: 'en', host: 'example.com' });
      },
      create: () => {}
    },
    runtime: {
      openOptionsPage: () => {},
      getURL: (p) => '/__disk__/' + p,
      getManifest: () => ({ version: '9.9.9-test' }),
      sendMessage: (msg) => {
        if (msg && msg.type === 'translate') {
          return Promise.resolve({ ok: true, text: '[EN] ' + msg.text, ms: 1200, triedCount: 1, providerName: 'Groq' });
        }
        if (msg && msg.type === 'swPing') {
          // 旧后台不认识这条消息 → 只回 {ok:true}，没有 version 字段
          return Promise.resolve(runningSw ? { ok: true, version: runningSw } : { ok: true });
        }
        return Promise.resolve({ ok: true });
      }
    }
  };
}

const snapshot = () => ({
  providerStatus: document.getElementById('keyStatusText')?.textContent.trim(),
  speedText: document.getElementById('speedText')?.textContent.trim(),
  speedTag: document.querySelector('.speed__tag')?.textContent.trim(),
  speedVisible: (() => {
    const el = document.getElementById('speedRow');
    return !!el && getComputedStyle(el).display !== 'none';
  })(),
  pageCheck: document.getElementById('pageText')?.textContent.trim(),
  pageCheckClass: document.getElementById('pageCheck')?.className,
  statusText: document.getElementById('statusText')?.textContent.trim(),
  langOptions: document.getElementById('lang')?.options.length,
  hint: document.getElementById('hint')?.textContent.trim(),
  quickFocused: document.getElementById('quickBox')?.classList.contains('quick--focus'),
  quickVisible: (() => {
    const el = document.getElementById('quickBox');
    return !!el && getComputedStyle(el).display !== 'none';
  })(),
  driftVisible: (() => {
    const el = document.getElementById('driftWarn');
    return !!el && getComputedStyle(el).display !== 'none';
  })(),
  driftText: document.getElementById('driftText')?.textContent.trim() || ''
});

/* --------------------------------- 主流程 --------------------------------- */

(async () => {
  const { srv, port } = await serve(ROOT);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const url = `http://127.0.0.1:${port}/popup/popup.html`;

  /* ============ 场景 A：普通网页 ============ */
  console.log('=== 场景 A：普通网页 (https://example.com/) ===');

  const ctxA = await browser.newContext();
  const errorsA = [];
  await ctxA.addInitScript(mockChrome, { tabUrl: 'https://example.com/', pingOk: true });
  const pageA = await ctxA.newPage();
  pageA.on('pageerror', (e) => errorsA.push(String(e)));
  pageA.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errorsA.push('console: ' + m.text()); });

  await pageA.goto(url, { waitUntil: 'load' });
  await pageA.waitForTimeout(600);
  const r = await pageA.evaluate(snapshot);

  console.log('服务商状态:', r.providerStatus);
  console.log('智能模式:', r.speedVisible ? `${r.speedTag} · ${r.speedText}` : '（未显示）');
  console.log('当前页面自检:', r.pageCheck, '| class:', r.pageCheckClass);
  console.log('总状态:', r.statusText, '| 语言选项:', r.langOptions);
  console.log('提示:', r.hint);

  if (!/2 \/ 2/.test(r.providerStatus)) note('[A] 服务商状态应显示 2 / 2 家可用');
  if (!r.speedVisible) note('[A] 应显示「优先使用哪家」');
  if (!/智能模式/.test(r.speedTag || '')) note('[A] 标签应为「智能模式」，实际: ' + r.speedTag);
  if (!/优先使用 Groq/.test(r.speedText)) note('[A] 实测更快的 Groq 应被优先，实际: ' + r.speedText);
  if (!/1\.2s/.test(r.speedText)) note('[A] 应显示实测延迟，实际: ' + r.speedText);
  if (!/已就绪/.test(r.pageCheck)) note('[A] 当前页面自检应为「已就绪」，实际: ' + r.pageCheck);
  if (!/pagecheck--ok/.test(r.pageCheckClass)) note('[A] 自检样式应为 ok');
  if (r.quickFocused) note('[A] 普通网页上不应高亮快捷翻译框');
  if (!r.quickVisible) note('[A] 快捷翻译框在任何页面都应可用');
  if (r.langOptions !== 14) note('[A] 语言选项应为 14');
  if (!/9\.9\.9-test/.test(r.statusText || '')) note('[A] 状态行应带实际加载的版本号，实际: ' + r.statusText);
  if (r.driftVisible) note('[A] 版本一致时不应显示「后台还在跑旧版本」告警，实际文案: ' + r.driftText);
  if (errorsA.length) note('[A] 页面报错: ' + errorsA.join(' | '));
  await ctxA.close();

  /* ============ 场景 A2：后台仍在跑旧版本 ============ */
  console.log('\n=== 场景 A2：后台跑的是旧版本（swVersion 为空）===');

  const ctxA2 = await browser.newContext();
  const errorsA2 = [];
  await ctxA2.addInitScript(mockChrome, {
    tabUrl: 'https://example.com/',
    pingOk: true,
    swVersion: '',
    diskVersion: '1.8.0'
  });
  const pageA2 = await ctxA2.newPage();
  pageA2.on('pageerror', (e) => errorsA2.push(String(e)));
  await pageA2.goto(url, { waitUntil: 'load' });
  await pageA2.waitForTimeout(600);
  const r2 = await pageA2.evaluate(snapshot);

  console.log('版本告警:', r2.driftVisible ? `已显示 ✓ (${r2.driftText})` : '未显示 ✗');
  if (!r2.driftVisible) note('[A2] 后台跑旧版本时必须显示告警（弹窗是用户最先看到的地方）');
  if (!/旧版本/.test(r2.driftText)) note('[A2] 告警文案应说明后台在跑旧版本，实际: ' + r2.driftText);
  if (!/v1\.0\.0|v9\.9\.9-test/.test(r2.driftText)) note('[A2] 告警应写出实际在跑的版本号，实际: ' + r2.driftText);
  if (errorsA2.length) note('[A2] 页面报错: ' + errorsA2.join(' | '));

  await pageA2.setViewportSize({ width: 420, height: 700 });
  const driftShot = path.join(ROOT, 'tools', 'popup-preview-stale.png');
  await pageA2.screenshot({ path: driftShot, fullPage: true });
  console.log('版本告警截图已保存:', driftShot);
  await ctxA2.close();

  /* ============ 场景 B：新标签页 ============ */
  console.log('\n=== 场景 B：新标签页 (chrome://newtab/) ===');

  const ctxB = await browser.newContext();
  const errorsB = [];
  await ctxB.addInitScript(mockChrome, { tabUrl: 'chrome://newtab/', pingOk: false });
  const pageB = await ctxB.newPage();
  pageB.on('pageerror', (e) => errorsB.push(String(e)));
  pageB.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errorsB.push('console: ' + m.text()); });

  await pageB.goto(url, { waitUntil: 'load' });
  await pageB.waitForTimeout(600);
  const b = await pageB.evaluate(snapshot);

  console.log('当前页面自检:', b.pageCheck, '| class:', b.pageCheckClass);
  console.log('快捷翻译框高亮:', b.quickFocused ? '是 ✓' : '否 ✗');
  console.log('提示:', b.hint);

  if (!/新标签页/.test(b.pageCheck)) note('[B] 应明确提示这是新标签页，实际: ' + b.pageCheck);
  if (!/快捷翻译/.test(b.pageCheck)) note('[B] 应引导用户使用「快捷翻译」，实际: ' + b.pageCheck);
  if (!/pagecheck--warn/.test(b.pageCheckClass)) note('[B] 自检样式应为 warn，实际: ' + b.pageCheckClass);
  if (!b.quickFocused) note('[B] 新标签页上应高亮快捷翻译框');
  if (!/快捷翻译/.test(b.hint)) note('[B] 底部提示应指向快捷翻译，实际: ' + b.hint);
  if (/连敲 3 次空格/.test(b.hint)) note('[B] 新标签页上不该再提「连敲空格」');

  /* ---- 验证快捷翻译真的能工作 ---- */
  await pageB.fill('#quickInput', '今天天气很好');
  await pageB.click('#quickGo');
  await pageB.waitForTimeout(400);

  const after = await pageB.evaluate(() => ({
    output: document.getElementById('quickOutput')?.textContent.trim() || '',
    outputHidden: document.getElementById('quickOutput')?.hidden,
    status: document.getElementById('quickStatus')?.textContent.trim() || '',
    copyHidden: document.getElementById('quickCopy')?.hidden
  }));

  console.log('快捷翻译结果:', after.output);
  console.log('状态:', after.status, '| 复制按钮:', after.copyHidden ? '隐藏' : '显示');

  if (after.outputHidden || !after.output) note('[B] 快捷翻译应输出译文');
  if (!/\[EN\]/.test(after.output)) note('[B] 快捷翻译结果不对: ' + after.output);
  if (!/完成/.test(after.status)) note('[B] 应显示完成状态，实际: ' + after.status);
  if (after.copyHidden) note('[B] 有译文后应显示复制按钮');

  /* ---- 截图（趁译文还在，展示实际效果） ---- */
  const shot = path.join(ROOT, 'tools', 'popup-preview.png');
  await pageB.setViewportSize({ width: 320, height: 640 });
  await pageB.screenshot({ path: shot, fullPage: true });
  console.log('截图已保存:', shot);

  /* ---- 空输入不应发请求 ---- */
  await pageB.fill('#quickInput', '   ');
  await pageB.click('#quickGo');
  await pageB.waitForTimeout(200);
  const emptyStatus = await pageB.evaluate(() => document.getElementById('quickStatus')?.textContent.trim());
  console.log('空输入提示:', emptyStatus);
  if (!/先输入/.test(emptyStatus || '')) note('[B] 空输入应给出提示，实际: ' + emptyStatus);

  if (errorsB.length) note('[B] 页面报错: ' + errorsB.join(' | '));
  await ctxB.close();

  /* ---- 暗色模式：令牌应当整片翻过来，不留纯白底 ---- */
  const ctxD = await browser.newContext({ colorScheme: 'dark' });
  await ctxD.addInitScript(mockChrome, { tabUrl: 'https://example.com/', pingOk: true });
  const pageD = await ctxD.newPage();
  const errorsD = [];
  pageD.on('pageerror', (e) => errorsD.push(String(e)));
  await pageD.goto(url, { waitUntil: 'load' });
  await pageD.waitForTimeout(500);

  const darkProbe = await pageD.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const whites = [];
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if (s.backgroundColor === 'rgb(255, 255, 255)') {
        whites.push(el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
      }
    }
    return { bg: cs.backgroundColor, fg: cs.color, scheme: cs.colorScheme, whites: [...new Set(whites)].slice(0, 8) };
  });

  const lum = (c) => {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(c);
    return m ? (+m[1] + +m[2] + +m[3]) / 3 : 255;
  };
  if (lum(darkProbe.bg) > 128) note('暗色下 body 背景仍是浅色: ' + darkProbe.bg);
  if (lum(darkProbe.fg) < 128) note('暗色下文字仍是深色: ' + darkProbe.fg);
  if (darkProbe.whites.length) note('暗色下仍有纯白底元素（漏改的硬编码色值）: ' + darkProbe.whites.join(', '));
  if (!/dark/.test(darkProbe.scheme)) note('color-scheme 未切到 dark: ' + darkProbe.scheme);

  const darkShot = path.join(ROOT, 'tools', 'popup-preview-dark.png');
  await pageD.setViewportSize({ width: 320, height: 640 });
  await pageD.screenshot({ path: darkShot, fullPage: true });
  console.log('暗色截图已保存:', darkShot);
  console.log(
    `暗色探针: bg=${darkProbe.bg} fg=${darkProbe.fg} color-scheme=${darkProbe.scheme} 纯白底元素=${darkProbe.whites.length}`
  );
  if (errorsD.length) note('暗色页面报错: ' + errorsD.join(' | '));
  await ctxD.close();

  console.log(problems.length ? '\n❌ 问题: ' + problems.join('; ') : '\n✅ 弹窗渲染正常（含新标签页引导 + 快捷翻译）');
  await browser.close();
  srv.close();
  process.exit(problems.length ? 1 : 0);
})();
