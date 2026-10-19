/* Options 页渲染自检：用 mock chrome.storage 打开 options.html，检查多服务商 UI 是否正确生成 */
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
    const file = path.join(root, rel);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

(async () => {
  const { srv, port } = await serve(ROOT);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });

  // 注入 mock chrome API（promise 风格，与真实 MV3 一致）
  // 抽成常量：下面亮色 / 暗色两个 context 都要注入同一套 mock。
  // opts 用来模拟「版本不一致」：diskVersion 是磁盘上的 manifest，pageVersion 是页面内存里的，
  // swVersion 是后台 Service Worker 报回来的（空字符串代表后台是旧代码，不认识 swPing）。
  const MOCK_CHROME = (opts) => {
    const o = opts || {};
    const diskVersion = o.diskVersion || '9.9.9-test';
    const pageVersion = o.pageVersion || '9.9.9-test';
    const swVersion = o.swVersion === undefined ? '9.9.9-test' : o.swVersion;

    // 真实扩展里 manifest.json 是磁盘文件，这里用 fetch 拦截来伪造「磁盘版本」
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
      triggerCount: 3,
      triggerWindow: 500,
      targetLang: 'en',
      tone: 'natural',
      cacheEnabled: true,
      // 故意塞一个旧的 smartOrder=false：新版应当完全忽略它（智能模式常开）
      smartOrder: false,
      blacklist: ['mail.google.com'],
      // 三家都是「已经下线/改名」的旧模型名，用来验证自动迁移
      providers: [
        { id: 'p1', preset: 'groq', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_test', enabled: true },
        { id: 'p2', preset: 'agnes', name: 'Agnes AI', endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions', model: 'agnes-2.0-flash', apiKey: 'sk_test', enabled: true },
        { id: 'p3', preset: 'zhipu', name: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4.7-flash', apiKey: 'zm_test', enabled: true },
        { id: 'p4', preset: 'custom', name: '自定义服务', endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: '', enabled: true }
      ],
      // Groq 实测最快；GLM 限流冷却中（应排到最后）；没填 Key 的自定义服务不可用
      providerStats: {
        p1: { emaMs: 734, samples: 10, fails: 0, failStreak: 0, cooldownUntil: 0, lastOkAt: Date.now(), lastCode: '', probedAt: Date.now(), updatedAt: Date.now() },
        p2: { emaMs: 2055, samples: 3, fails: 0, failStreak: 0, cooldownUntil: 0, lastOkAt: Date.now(), lastCode: '', probedAt: Date.now(), updatedAt: Date.now() },
        p3: { emaMs: 2800, samples: 5, fails: 2, failStreak: 1, cooldownUntil: Date.now() + 30000, lastOkAt: Date.now(), lastCode: 'rate_limit', probedAt: Date.now(), updatedAt: Date.now() }
      }
    };
    // 允许按场景覆盖服务商列表（全新安装 / 只加不填 Key 两种边界）
    if (Array.isArray(o.providers)) store.providers = o.providers;

    const pick = (keys) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      list.forEach((k) => { if (k in store) out[k] = store[k]; });
      return out;
    };
    globalThis.chrome = {
      storage: {
        local: {
          get: (keys) => Promise.resolve(pick(keys)),
          set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
          remove: (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); return Promise.resolve(); }
        },
        onChanged: { addListener: () => {} }
      },
      runtime: {
        sendMessage: (msg) => {
          const t = msg && msg.type;
          if (t === 'swPing') {
            // 旧后台不认识这条消息 → 只回 {ok:true}，没有 version 字段
            return Promise.resolve(swVersion ? { ok: true, version: swVersion } : { ok: true });
          }
          if (t === 'cacheStats') return Promise.resolve({ ok: true, entries: 3, hits: 5, approxBytes: 2048 });
          if (t === 'providerStats') return Promise.resolve({ ok: true, stats: store.providerStats });
          return Promise.resolve({ ok: true });
        },
        lastError: null,
        getURL: (p) => '/__disk__/' + p,
        getManifest: () => ({ version: pageVersion })
      },
      tabs: { create: () => {} }
    };
  };

  await ctx.addInitScript(MOCK_CHROME, undefined);

  const url = `http://127.0.0.1:${port}/options/options.html`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(600);

  const result = await page.evaluate(() => {
    const presets = [...document.querySelectorAll('#presets .preset')].map(b => b.textContent.trim());
    const cards = [...document.querySelectorAll('#providers .provider')];
    const cardInfo = cards.map(c => ({
      name: c.querySelector('.provider__name')?.value,
      speed: c.querySelector('.provider__speed')?.textContent.trim() || '',
      speedClass: c.querySelector('.provider__speed')?.className || '',
      rank: c.querySelector('.provider__rank')?.textContent.trim() || '',
      model: c.querySelector('[data-field="model"]')?.value || '',
      hasKeyInput: !!c.querySelector('input[type="password"], input[data-field="apiKey"]'),
      hasTestBtn: !!c.querySelector('[data-act="test"]'),
      hasUp: !!c.querySelector('[data-act="up"]'),
      hasDown: !!c.querySelector('[data-act="down"]'),
      hasDel: !!c.querySelector('[data-act="del"]'),
      hasSignup: !!c.querySelector('[data-act="signup"]')
    }));
    return {
      presetCount: presets.length,
      presets,
      cardCount: cards.length,
      cardInfo,
      cacheStat: document.getElementById('cacheStat')?.textContent.trim(),
      targetLangOptions: document.getElementById('targetLang')?.options.length,
      smartDesc: document.getElementById('smartDesc')?.textContent.trim(),
      pageCardCount: document.querySelectorAll('.page > .card').length,
      pageCardTitles: [...document.querySelectorAll('.page > .card > .card__title, .page > .card > .card__head > .card__title')].map(t => t.textContent.trim()),
      // 精简掉的冗余 DOM，不该再出现
      hasSmartOrderList: !!document.getElementById('smartOrderList'),
      hasEngineBar: !!document.getElementById('engineBar') || !!document.getElementById('engineBarWrap'),
      hasEngineDesc: !!document.querySelector('.engine__desc'),
      hasCacheRow: !!document.querySelector('.cache-row'),
      // 手动测速相关的控件都应当已经消失
      hasBenchmarkBtn: !!document.getElementById('benchmark'),
      hasSmartToggle: !!document.getElementById('smartOrder'),
      hasCustomBtn: !!document.getElementById('addCustom'),
      hasResetLink: !!document.getElementById('resetSpeed'),
      resetLinkText: document.getElementById('resetSpeed')?.textContent.trim() || '',
      // 离线引擎状态：浏览器明明有 Translator API 时，不能报「环境不支持」。
      // （曾经的 bug：拿 en→en 去问 Chrome，同语种必然 unavailable，于是永远误报）
      hasTranslatorApi: typeof Translator !== 'undefined',
      offlineStat: document.getElementById('engineLocalStat')?.textContent.trim() || '',
      bannerVisible: (() => {
        const b = document.getElementById('banner');
        if (!b) return false;
        return getComputedStyle(b).display !== 'none';
      })()
    };
  });

  console.log('预设按钮数:', result.presetCount, '→', result.presets.join(', '));
  console.log('服务卡片数:', result.cardCount);
  result.cardInfo.forEach((c, i) => console.log(`  卡片${i + 1}: ${c.name} | 模型:${c.model} | 速度:${c.speed} | ${c.rank || '（不可用）'} | key输入:${c.hasKeyInput} 测试:${c.hasTestBtn} 申请入口:${c.hasSignup} 上移:${c.hasUp} 下移:${c.hasDown} 删除:${c.hasDel}`));
  console.log('缓存统计:', result.cacheStat);
  console.log('目标语言选项数:', result.targetLangOptions);
  console.log('智能模式说明:', result.smartDesc);
  console.log('页面卡片:', result.pageCardCount, '→', result.pageCardTitles.join(' / '));
  console.log('手动测速按钮:', result.hasBenchmarkBtn ? '仍存在 ✗' : '已移除 ✓', '| 智能开关:', result.hasSmartToggle ? '仍存在 ✗' : '已移除 ✓', '| 自定义入口:', result.hasCustomBtn ? '在 ✓' : '缺失 ✗', '| 重新学习入口:', result.resetLinkText);

  const problems = [];
  // 精简后：只剩实测跑通的 3 家（Groq / 智谱 GLM / Agnes AI）+ 1 个独立的自定义入口
  if (result.presetCount !== 3) problems.push('快速添加预设应为 3 个（只留实测可用的），实际: ' + result.presetCount);
  if (!result.hasCustomBtn) problems.push('应保留独立的「自定义服务」入口');
  if (!result.presets.some((p) => /智谱|GLM/.test(p))) problems.push('预设里应有智谱 GLM');
  for (const gone of ['OpenRouter', 'Gemini', 'Cerebras', '硅基流动', 'DeepSeek']) {
    if (result.presets.some((p) => p.includes(gone))) problems.push(`预设里不应再有 ${gone}（实测不可用或从未使用，已删）`);
  }
  if (result.cardCount !== 4) problems.push('服务卡片数应为 4');

  /* ---- 简洁性：卡片数量、顺序、冗余 DOM ---- */
  if (result.pageCardCount !== 4) problems.push('设置页应压到 4 张卡片，实际: ' + result.pageCardCount);
  // 顺序有业务含义：免费引擎是主路径，必须排在付费/需 Key 的 AI 服务前面
  const wantOrder = ['免费引擎', 'AI 翻译服务', '触发方式', '其他设置'];
  if (result.pageCardTitles.join('|') !== wantOrder.join('|')) {
    problems.push('卡片顺序应为「' + wantOrder.join(' / ') + '」，实际: ' + result.pageCardTitles.join(' / '));
  }
  if (result.hasSmartOrderList) problems.push('排序标签已删（与卡片上的「当前第 N 位」重复）');
  if (result.hasEngineBar) problems.push('离线模型进度条已删（进度直接写在状态行里）');
  if (result.hasEngineDesc) problems.push('免费引擎的说明行已合并进状态行，不该再有 .engine__desc');
  if (result.hasCacheRow) problems.push('缓存行已合并进「其他设置」卡，不该再有 .cache-row');

  /* ---- 离线引擎状态不得误报 ---- */
  if (result.hasTranslatorApi && /不支持/.test(result.offlineStat)) {
    problems.push(
      '浏览器有 Translator API，离线状态却报「不支持」—— 多半是又拿同语种（en→en）去问 availability 了。实际文案: ' +
        result.offlineStat
    );
  }
  if (result.hasTranslatorApi && !/zh→|en→/.test(result.offlineStat)) {
    problems.push('离线状态行应写清是哪对语向，实际: ' + result.offlineStat);
  }
  result.cardInfo.forEach((c, i) => {
    if (!c.hasKeyInput) problems.push(`卡片${i + 1} 缺 key 输入`);
    if (!c.hasTestBtn) problems.push(`卡片${i + 1} 缺测试按钮`);
    if (!c.hasDel) problems.push(`卡片${i + 1} 缺删除按钮`);
  });

  /* ---- 核心诉求：不需要用户手动测速 ---- */
  if (result.hasBenchmarkBtn) problems.push('不应再有「自动测速」按钮（改为全自动）');
  if (result.hasSmartToggle) problems.push('不应再有智能排序开关（智能模式常开）');
  if (!result.hasResetLink) problems.push('应保留一个低调的「重新学习」兜底入口');
  if (!/不用你选/.test(result.smartDesc)) problems.push('智能模式说明文案不对: ' + result.smartDesc);
  if (result.bannerVisible) problems.push('已有可用服务商时，顶部「还没有可用的翻译服务」横幅不应显示');

  /* ---- 排序与速度标记 ---- */
  if (!/实测 0\.7s/.test(result.cardInfo[0].speed)) problems.push('Groq 应显示实测 0.7s，实际: ' + result.cardInfo[0].speed);
  if (!/实测 2\.1s/.test(result.cardInfo[1].speed)) problems.push('Agnes 应显示实测 2.1s，实际: ' + result.cardInfo[1].speed);
  if (!/冷却中/.test(result.cardInfo[2].speed)) problems.push('智谱 GLM 应显示冷却中，实际: ' + result.cardInfo[2].speed);
  if (!/当前第 1 位/.test(result.cardInfo[0].rank)) problems.push('Groq 应标为当前第 1 位，实际: ' + result.cardInfo[0].rank);
  if (!/当前第 3 位/.test(result.cardInfo[2].rank)) problems.push('冷却中的 GLM 应排到第 3 位，实际: ' + result.cardInfo[2].rank);
  if (result.cardInfo[3].rank) problems.push('没填 Key 的自定义服务不应有排序标记，实际: ' + result.cardInfo[3].rank);
  if (!/Groq/.test(result.smartDesc)) problems.push('智能模式一行说明里应点名最快的那家，实际: ' + result.smartDesc);

  /* ---- 已下线模型必须被自动修好（boss 遇到的真实故障） ---- */
  if (result.cardInfo[0].model !== 'openai/gpt-oss-120b') {
    problems.push('Groq 已下线的 llama-3.3-70b-versatile 应被自动换成 openai/gpt-oss-120b，实际: ' + result.cardInfo[0].model);
  }
  if (result.cardInfo[1].model !== 'agnes-2.5-flash') {
    problems.push('Agnes 已下线的 agnes-2.0-flash 应被自动换成 agnes-2.5-flash，实际: ' + result.cardInfo[1].model);
  }
  if (result.cardInfo[2].model !== 'glm-4-flash') {
    problems.push('智谱高峰期限流的 glm-4.7-flash 应被自动换成 glm-4-flash，实际: ' + result.cardInfo[2].model);
  }

  /* ---- 截图（智能模式的自然状态） ---- */
  const shot = path.join(ROOT, 'tools', 'options-preview.png');
  await page.setViewportSize({ width: 900, height: 1500 });
  await page.screenshot({ path: shot, fullPage: true });
  console.log('截图已保存:', shot);

  /* ---- 旧版 smartOrder=false 不应影响任何行为 ---- */
  const afterLegacy = await page.evaluate(() => ({
    desc: document.getElementById('smartDesc')?.textContent.trim() || ''
  }));
  if (!/不用你选/.test(afterLegacy.desc)) problems.push('旧版 smartOrder=false 被误当成关闭状态: ' + afterLegacy.desc);
  if (!/Groq/.test(afterLegacy.desc)) problems.push('说明里应仍以最快的 Groq 为先，实际: ' + afterLegacy.desc);

  /* ---- 页头必须显示实际加载的版本号（排查「改了没生效」时靠它） ---- */
  const verShown = await page.evaluate(() => document.getElementById('verText')?.textContent.trim() || '');
  console.log('页头版本号:', verShown);
  if (!/9\.9\.9-test/.test(verShown)) problems.push('页头应显示实际加载的版本号，实际: ' + verShown);

  /* ---- 版本一致时，绝不该误报「后台还在跑旧版本」 ---- */
  const noDrift = await page.evaluate(() => {
    const b = document.getElementById('staleBanner');
    return { exists: !!b, visible: !!b && getComputedStyle(b).display !== 'none' };
  });
  console.log('版本一致时告警横幅:', noDrift.visible ? '错误地显示了 ✗' : '未显示 ✓');
  if (!noDrift.exists) problems.push('设置页缺少版本不一致告警横幅 #staleBanner');
  if (noDrift.visible) problems.push('三个版本一致时不应显示「后台还在跑旧版本」告警');

  /* ---- 版本不一致（后台仍是旧代码）时必须亮红灯 ---- */
  const driftCtx = await browser.newContext();
  await driftCtx.addInitScript(MOCK_CHROME, { diskVersion: '1.8.0', pageVersion: '1.0.0', swVersion: '' });
  const driftPage = await driftCtx.newPage();
  const driftErrors = [];
  driftPage.on('pageerror', (e) => driftErrors.push(String(e)));
  await driftPage.goto(url, { waitUntil: 'load' });
  await driftPage.waitForTimeout(500);

  const drift = await driftPage.evaluate(() => {
    const b = document.getElementById('staleBanner');
    return {
      visible: !!b && getComputedStyle(b).display !== 'none',
      title: b?.querySelector('.banner__title')?.textContent.trim() || '',
      disk: document.getElementById('staleDisk')?.textContent.trim() || '',
      run: document.getElementById('staleRun')?.textContent.trim() || '',
      hasOpenBtn: !!document.getElementById('staleOpen'),
      hasCopyBtn: !!document.getElementById('staleCopy'),
      verTitle: document.getElementById('verText')?.title || ''
    };
  });
  console.log('版本不一致时告警:', drift.visible ? `已显示 ✓ (磁盘 ${drift.disk} / 后台 ${drift.run})` : '未显示 ✗');

  if (!drift.visible) problems.push('后台版本与磁盘不一致时，必须显示「后台还在跑旧版本」告警');
  if (!/旧版本/.test(drift.title)) problems.push('告警标题应说明后台在跑旧版本，实际: ' + drift.title);
  if (!/1\.8\.0/.test(drift.disk)) problems.push('告警应写出磁盘上的版本 v1.8.0，实际: ' + drift.disk);
  if (!/1\.0\.0/.test(drift.run)) problems.push('告警应写出后台实际在跑的版本 v1.0.0，实际: ' + drift.run);
  if (!drift.hasOpenBtn || !drift.hasCopyBtn) problems.push('告警应提供「打开扩展管理页」和「复制地址」两个操作');
  if (!/1\.8\.0/.test(drift.verTitle) || !/1\.0\.0/.test(drift.verTitle)) {
    problems.push('页头版本号的 tooltip 应写清磁盘版本与运行版本，实际: ' + drift.verTitle);
  }
  if (driftErrors.length) problems.push('版本不一致页面报错: ' + driftErrors.join(' | '));

  const driftShot = path.join(ROOT, 'tools', 'options-preview-stale.png');
  await driftPage.setViewportSize({ width: 900, height: 420 });
  await driftPage.screenshot({ path: driftShot });
  console.log('版本告警截图已保存:', driftShot);
  await driftCtx.close();

  /* ---- 暗色模式：整套令牌应当翻过来，且不留任何纯白底 ---- */
  const darkCtx = await browser.newContext({ colorScheme: 'dark' });
  await darkCtx.addInitScript(MOCK_CHROME, undefined);
  const darkPage = await darkCtx.newPage();
  const darkErrors = [];
  darkPage.on('pageerror', (e) => darkErrors.push(String(e)));
  await darkPage.goto(`http://127.0.0.1:${port}/options/options.html`, { waitUntil: 'networkidle' });
  await darkPage.waitForTimeout(400);

  const darkProbe = await darkPage.evaluate(() => {
    const cs = getComputedStyle(document.body);
    // 暗色下还留着纯白背景的元素，一定是漏改的硬编码色值
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
  if (lum(darkProbe.bg) > 128) problems.push('暗色下 body 背景仍是浅色: ' + darkProbe.bg);
  if (lum(darkProbe.fg) < 128) problems.push('暗色下文字仍是深色: ' + darkProbe.fg);
  if (darkProbe.whites.length) problems.push('暗色下仍有纯白底元素（漏改的硬编码色值）: ' + darkProbe.whites.join(', '));
  if (!/dark/.test(darkProbe.scheme)) problems.push('color-scheme 未切到 dark: ' + darkProbe.scheme);

  const darkShot = path.join(ROOT, 'tools', 'options-preview-dark.png');
  await darkPage.setViewportSize({ width: 900, height: 1500 });
  await darkPage.screenshot({ path: darkShot, fullPage: true });
  console.log('暗色截图已保存:', darkShot);
  console.log(
    `暗色探针: bg=${darkProbe.bg} fg=${darkProbe.fg} color-scheme=${darkProbe.scheme} 纯白底元素=${darkProbe.whites.length}`
  );
  if (darkErrors.length) problems.push('暗色页面报错: ' + darkErrors.join(' | '));
  await darkCtx.close();

  /* ---- 全新安装：不预置服务商，也不能把「没配 AI」说成故障 ---- */
  // 必须开新 context：mock 的 store 是每次导航重新建的，在旧页面上改完再 reload 会被重置
  const freshCtx = await browser.newContext();
  await freshCtx.addInitScript(MOCK_CHROME, { providers: [] });
  const freshPage = await freshCtx.newPage();
  await freshPage.goto(`http://127.0.0.1:${port}/options/options.html`, { waitUntil: 'load' });
  await freshPage.waitForTimeout(600);
  const fresh = await freshPage.evaluate(() => ({
    cards: document.querySelectorAll('#providers .provider').length,
    empty: document.querySelector('.providers__empty')?.textContent.trim() || '',
    bannerVisible: (() => {
      const b = document.getElementById('banner');
      return !!b && getComputedStyle(b).display !== 'none';
    })(),
    smart: document.getElementById('smartDesc')?.textContent.trim() || ''
  }));
  console.log('全新安装:', `服务商卡片 ${fresh.cards} 张`, '| 空状态:', fresh.empty, '| 顶部横幅:', fresh.bannerVisible ? '显示' : '隐藏');
  if (fresh.cards !== 0) problems.push('全新安装不应预置任何服务商（不替用户选、也不夹带推广），实际 ' + fresh.cards + ' 张');
  if (!fresh.empty) problems.push('没有服务商时应显示空状态引导');
  if (fresh.bannerVisible) problems.push('一个服务商都没有时，AI 卡片里已经说清楚了，顶部横幅属于重复噪音，应隐藏');
  if (!/免费引擎/.test(fresh.smart)) problems.push('没配服务商时，智能模式说明应点明免费引擎够用，实际: ' + fresh.smart);
  await freshCtx.close();

  /* ---- 加了服务商却没填 Key：这才是真卡住，顶部必须提醒 ---- */
  const noKeyCtx = await browser.newContext();
  await noKeyCtx.addInitScript(MOCK_CHROME, {
    providers: [
      {
        id: 'x1',
        name: 'Groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'openai/gpt-oss-120b',
        apiKey: '',
        enabled: true
      }
    ]
  });
  const noKeyPage = await noKeyCtx.newPage();
  await noKeyPage.goto(`http://127.0.0.1:${port}/options/options.html`, { waitUntil: 'load' });
  await noKeyPage.waitForTimeout(600);
  const noKey = await noKeyPage.evaluate(() => {
    const b = document.getElementById('banner');
    return {
      bannerVisible: !!b && getComputedStyle(b).display !== 'none',
      title: b?.querySelector('.banner__title')?.textContent.trim() || ''
    };
  });
  console.log('服务商未填 Key:', noKey.bannerVisible ? `已提醒 ✓ (${noKey.title})` : '未提醒 ✗');
  if (!noKey.bannerVisible) problems.push('加了服务商但没填 Key 时，顶部应提醒（否则用户不知道它没生效）');
  if (!/Key/.test(noKey.title)) problems.push('未填 Key 的提醒标题应点明是 Key 的问题，实际: ' + noKey.title);
  await noKeyCtx.close();

  if (errors.length) problems.push('页面报错: ' + errors.join(' | '));

  console.log(problems.length ? '\n❌ 问题: ' + problems.join('; ') : '\n✅ 设置页渲染正常（全自动，无手动测速）');
  await browser.close();
  srv.close();
  process.exit(problems.length ? 1 : 0);
})();
