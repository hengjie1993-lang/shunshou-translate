/**
 * Edge 兼容性验证 —— 真的把扩展装进 Edge，跑一遍核心链路。
 *
 * 为什么不用 `--load-extension`：
 * Chrome 137+ 移除了这个开关，Edge 跟着 Chromium 一起删了。现在唯一的办法是
 * CDP 的 `Extensions.loadUnpacked`，它要求启动时带 `--enable-unsafe-extension-debugging`。
 *
 * 为什么不用 puppeteer.launch()：
 * puppeteer 默认走 `--remote-debugging-pipe`，Edge 155 在 Windows 上接上这个管道就
 * 立刻退出（报 `Target closed`，退出码 0）。所以这里自己 spawn 一个带
 * `--remote-debugging-port` 的 Edge，再用 puppeteer.connect() 接上去 —— 这条路是通的。
 *
 * 验证项：
 *   1. Edge 能否接受这份 manifest（含 minimum_chrome_version）
 *   2. service worker 是否注册成功
 *   3. content script 是否注入到普通网页
 *   4. popup 能否正常渲染、识别为 Edge、给出 edge://extensions
 *   5. 设置页能否正常渲染、离线引擎名称是否跟随浏览器
 *   6. 三连空格是否真的触发翻译并回填（需联网）
 *
 * 运行：
 *   NODE_PATH="<node工作区>/node_modules" node tools/edge-test.cjs
 *   可选：EDGE_PATH 指定 msedge.exe 路径；HEADFUL=1 开有头模式（默认无头）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EDGE =
  process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HEADFUL = process.env.HEADFUL === '1';

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>t</title></head><body>
<h1>edge test</h1>
<input id="a" type="text" style="width:420px;padding:8px">
<textarea id="b" rows="3" style="width:420px;padding:8px"></textarea>
</body></html>`;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''));
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function servePage() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    const attempt = () => {
      const port = 20000 + Math.floor(Math.random() * 30000);
      srv.once('error', attempt);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', attempt);
        resolve({ srv, port });
      });
    };
    attempt();
  });
}

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const okJson = await new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/json/version', timeout: 1200 },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve(buf.includes('webSocketDebuggerUrl')));
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (okJson) return true;
    await sleep(300);
  }
  return false;
}

(async () => {
  if (!fs.existsSync(EDGE)) {
    console.error('找不到 msedge.exe：' + EDGE);
    process.exit(2);
  }

  const { srv, port: pagePort } = await servePage();
  const url = `http://127.0.0.1:${pagePort}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-ext-'));
  const dbgPort = await freePort();

  console.log('Edge   :', EDGE);
  console.log('扩展   :', ROOT);
  console.log('测试页 :', url);
  console.log('调试端口:', dbgPort);
  console.log('');

  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${dbgPort}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-features=DialMediaRouteProvider'
  ];
  if (!HEADFUL) args.unshift('--headless=new');

  const child = spawn(EDGE, args, { stdio: 'ignore', windowsHide: true });
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });

  let browser = null;
  try {
    const up = await waitForDevtools(dbgPort);
    ok('Edge 能起来并开出调试端口', up, { dbgPort, exitCode: exited });
    if (!up) throw new Error('Edge 未能启动');

    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${dbgPort}`,
      defaultViewport: { width: 1100, height: 780 }
    });

    // ---- 1. 装扩展 ----
    const session = await browser.target().createCDPSession();
    const res = await session.send('Extensions.loadUnpacked', { path: ROOT });
    const extId = res && res.id;
    ok('Edge 接受这份 manifest 并完成加载', !!extId, res);
    console.log('  extension id =', extId);

    // ---- 2. service worker ----
    let sw = null;
    for (let i = 0; i < 40 && !sw; i += 1) {
      sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId));
      if (!sw) await sleep(250);
    }
    ok('service worker 已注册', !!sw, browser.targets().map((t) => t.type()));

    // ---- 3. content script ----
    // 不能读 window.__shunshouTranslateLoaded：内容脚本跑在隔离世界（isolated world），
    // 它挂的全局变量 page.evaluate 根本看不见 —— 只能看两边共享的 DOM。
    // 清单里声明的 content.css 会被注入页面（以匿名 <style> 形式，没有 href），
    // 所以直接问「.sst-toast 这条规则在不在」，比翻 styleSheets 的 href 可靠。
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await sleep(1200);
    const injected = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'sst-toast';
      document.body.appendChild(probe);
      const z = getComputedStyle(probe).zIndex;
      probe.remove();
      // 只有 content.css 里那条规则会把它设成 2147483647
      return z === '2147483647';
    });
    ok('content script 样式已注入（.sst-toast 生效）', injected);

    // ---- 4. popup ----
    const popup = await browser.newPage();
    const popupErrors = [];
    popup.on('pageerror', (e) => popupErrors.push(String(e)));
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await sleep(900);

    const popupInfo = await popup.evaluate(() => {
      const el = (id) => document.getElementById(id);
      return {
        title: document.title,
        status: el('statusText') ? el('statusText').textContent : null,
        ua: navigator.userAgent,
        langCount: el('lang') ? el('lang').options.length : 0
      };
    });
    ok('popup 正常渲染（无 JS 报错）', popupErrors.length === 0, popupErrors);
    ok('popup 语种列表已填充', popupInfo.langCount > 0, popupInfo.langCount);
    ok('popup 识别为 Edge（UA 含 Edg/）', /Edg\//.test(popupInfo.ua), popupInfo.ua.slice(-50));

    const env = await popup.evaluate(async () => {
      const m = await import('../lib/browserEnv.js');
      return m.detectBrowser();
    });
    ok('detectBrowser() 判定为 edge', env.id === 'edge', env);
    ok('扩展管理页地址是 edge://extensions', env.extUrl === 'edge://extensions', env.extUrl);

    // ---- 5. 设置页 ----
    const opt = await browser.newPage();
    const optErrors = [];
    opt.on('pageerror', (e) => optErrors.push(String(e)));
    await opt.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
    await sleep(1500);
    const optInfo = await opt.evaluate(() => ({
      ver: document.getElementById('verText')?.textContent,
      engineName: document.getElementById('engineLocalName')?.textContent,
      cards: document.querySelectorAll('.card').length
    }));
    ok('设置页正常渲染（无 JS 报错）', optErrors.length === 0, optErrors);
    ok('设置页卡片齐全', optInfo.cards >= 3, optInfo);
    ok('离线引擎名称跟随浏览器（Edge 内置）', /Edge/.test(optInfo.engineName || ''), optInfo.engineName);

    // ---- 6. 三连空格真实翻译 ----
    await page.bringToFront();
    await page.click('#a');
    await page.type('#a', '你好世界', { delay: 30 });
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('Space');
      await sleep(60);
    }
    await sleep(6000);
    const translated = await page.evaluate(() => document.getElementById('a').value);
    ok('三连空格触发翻译并回填', /[a-zA-Z]{3,}/.test(translated), translated);
    console.log('  译文:', JSON.stringify(translated));
  } catch (e) {
    fail += 1;
    console.log('  ✗ 异常：' + ((e && e.message) || e));
  } finally {
    if (browser) await browser.disconnect();
    try {
      child.kill();
      // Windows 下子进程树要单独收，否则 Edge 会留着
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) {
      /* ignore */
    }
    srv.close();
    await sleep(500);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (_) {
      /* 文件被占用时留给人手动清，不影响测试结论 */
    }
  }

  console.log('');
  console.log(`Edge 验证：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
