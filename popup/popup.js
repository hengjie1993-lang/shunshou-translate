import { LANGUAGES } from '../lib/translator.js';
import { usableProviders } from '../lib/providers.js';
import { orderBySpeed, describeStat } from '../lib/stats.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { checkVersionDrift, runningVersionOf } from '../lib/versionGuard.js';
import { detectBrowser, reloadExtension } from '../lib/browserEnv.js';

const els = {
  enabled: document.getElementById('enabled'),
  statusText: document.getElementById('statusText'),
  lang: document.getElementById('lang'),
  hint: document.getElementById('hint'),
  keyStatus: document.getElementById('keyStatus'),
  keyStatusText: document.getElementById('keyStatusText'),
  keyStatusAction: document.getElementById('keyStatusAction'),
  speedRow: document.getElementById('speedRow'),
  speedText: document.getElementById('speedText'),
  pageCheck: document.getElementById('pageCheck'),
  pageText: document.getElementById('pageText'),
  quickBox: document.getElementById('quickBox'),
  quickInput: document.getElementById('quickInput'),
  quickGo: document.getElementById('quickGo'),
  quickCopy: document.getElementById('quickCopy'),
  quickStatus: document.getElementById('quickStatus'),
  quickOutput: document.getElementById('quickOutput'),
  openOptions: document.getElementById('openOptions'),
  getKey: document.getElementById('getKey'),
  driftWarn: document.getElementById('driftWarn'),
  driftText: document.getElementById('driftText'),
  driftAction: document.getElementById('driftAction')
};

/**
 * 浏览器内置页面：内容脚本无法注入（Chromium 的安全限制，不是插件能绕过的）。
 * `<all_urls>` 不匹配 chrome:// 、edge:// 这类协议，所以下面的判断必须把两家的
 * 新标签页地址都列上 —— 只写 chrome:// 的话，Edge 的 edge://newtab 会掉进
 * 「此页面不支持」那条通用分支，白白丢掉给用户的替代方案提示。
 */
const NTP_RE =
  /^(chrome:\/\/newtab|chrome:\/\/new-tab-page|chrome-search:\/\/local-ntp|edge:\/\/newtab)/i;

/* --------------------------------- 渲染 --------------------------------- */

function fillLanguages(selected) {
  els.lang.innerHTML = '';
  for (const lang of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.key;
    opt.textContent = `${lang.label}（${lang.native}）`;
    if (lang.key === selected) opt.selected = true;
    els.lang.appendChild(opt);
  }
}

function renderProviderStatus(providers, engines) {
  const list = Array.isArray(providers) ? providers : [];
  const usable = usableProviders(list).length;
  // 免费引擎能翻，就不该把「没配 AI 服务商」说成故障 —— 那是可选增强，不是缺配置
  const freeOk = !!(engines && (engines.google || engines.local));

  els.keyStatus.hidden = false;

  if (usable > 0) {
    els.keyStatus.className = 'status status--ok';
    els.keyStatusText.textContent =
      list.length > 1 ? `${usable} / ${list.length} 家服务可用` : `${list[0].name} 已配置`;
    els.keyStatusAction.hidden = true;
    els.statusText.textContent = '已就绪 · ' + runningVersion();
  } else if (freeOk) {
    els.keyStatus.className = 'status status--ok';
    els.keyStatusText.textContent = '免费引擎已就绪，不配 AI 服务也能翻译';
    els.keyStatusAction.hidden = true;
    els.statusText.textContent = '已就绪 · ' + runningVersion();
  } else {
    els.keyStatus.className = 'status status--warn';
    els.keyStatusText.textContent = '还没有可用的翻译服务';
    els.keyStatusAction.hidden = false;
    els.keyStatusAction.textContent = '去设置';
    els.statusText.textContent = '未配置 · ' + runningVersion();
  }

  // 已经配好服务商时，不再劝他去加 —— 按钮收起来，让「打开设置」占满整行
  els.getKey.hidden = usable > 0;
}

/**
 * 浏览器**当前实际加载**的版本号。
 * 为什么要显示它：改了代码但忘了在 chrome://extensions 点刷新时，
 * 页面里跑的仍是旧版 —— 有这个数字就能一眼确认，不用再猜。
 */
function runningVersion() {
  try {
    return 'v' + chrome.runtime.getManifest().version;
  } catch (_) {
    return 'v—';
  }
}

/**
 * 后台在跑旧版本时，在顶部挂一条告警。
 * 弹窗是用户最先看到的地方 —— 如果这里还写着「已就绪」，而翻译逻辑其实是老代码，
 * 用户只会觉得「插件坏了」。所以宁可在这里多占一行，也要把真相说出来。
 */
async function renderDriftWarn() {
  let result = null;
  try {
    result = await checkVersionDrift();
  } catch (_) {
    return;
  }
  if (!result || !result.stale) {
    els.driftWarn.hidden = true;
    return;
  }
  const running = runningVersionOf(result) || '?';
  els.driftText.textContent = `后台还在跑旧版本 v${running}`;
  els.driftWarn.hidden = false;
  els.driftWarn.title = '点一下让扩展重新加载，之后新开的页面就是新版代码';
}

/** 显示「当前会优先用哪家」，让用户知道智能模式选中的是谁 */
function renderSpeed(providers, stats) {
  const usable = usableProviders(providers);

  if (!usable.length) {
    els.speedRow.hidden = true;
    return;
  }

  const ordered = orderBySpeed(usable, stats || {});
  const first = ordered[0];
  const info = describeStat(stats && stats[first.id]);

  els.speedRow.hidden = false;
  els.speedText.textContent =
    ordered.length > 1
      ? `优先使用 ${first.name}（${info.text}），失败自动切换`
      : `优先使用 ${first.name}（${info.text}）`;
}

function setPageCheck(kind, text) {
  els.pageCheck.className = 'pagecheck' + (kind ? ' pagecheck--' + kind : '');
  els.pageText.textContent = text;
}

/** 页面不可注入时，把用户的注意力引到「快捷翻译」上 */
function highlightQuickBox(note) {
  els.quickBox.classList.add('quick--focus');
  if (note) els.quickStatus.textContent = note;
  els.quickInput.focus();
}

/* ------------------------- 当前页面可用性自检 ------------------------- */

async function checkCurrentPage() {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    /* ignore */
  }

  if (!tab || !tab.id) {
    setPageCheck('err', '读不到当前标签页');
    return;
  }

  const url = tab.url || tab.pendingUrl || '';

  // 新标签页：Chromium 禁止扩展注入，这不是 bug，给出替代方案
  if (NTP_RE.test(url)) {
    const name = detectBrowser().name;
    setPageCheck(
      'warn',
      '新标签页是浏览器内置页面，任何扩展都无法在这里翻译 —— 用下面的「快捷翻译」即可'
    );
    els.hint.innerHTML = `新标签页不支持三连空格（${name} 限制）。用上面的<b>快捷翻译</b>，或换个普通网页使用。`;
    highlightQuickBox();
    return;
  }

  if (!/^https?:/i.test(url)) {
    setPageCheck('err', '此页面不支持（浏览器内置页 / 扩展页 / 应用商店），换个普通网页再试');
    els.hint.innerHTML = '这个页面无法翻译，用上面的<b>快捷翻译</b>，或换个普通网页。';
    highlightQuickBox();
    return;
  }

  let resp = null;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
  } catch (_) {
    resp = null;
  }

  if (!resp || !resp.ok) {
    setPageCheck('err', '这个页面还没加载插件 —— 按 F5 刷新一下页面即可');
    return;
  }

  if (!resp.enabled) {
    setPageCheck('warn', '插件已停用，打开上面的开关即可');
    return;
  }

  if (resp.blacklisted) {
    setPageCheck('warn', `${resp.host} 在黑名单里，该站点不翻译`);
    return;
  }

  if (!resp.hasKey) {
    setPageCheck('warn', '页面已就绪，但还没填 API Key');
    return;
  }

  setPageCheck('ok', `当前页面已就绪 · 连敲 ${resp.triggerCount} 次空格即可翻译`);
}

/* ------------------------------- 快捷翻译 ------------------------------- */

function setQuickStatus(text, kind) {
  els.quickStatus.textContent = text || '';
  els.quickStatus.className = 'quick__status' + (kind ? ` quick__status--${kind}` : '');
}

async function quickTranslate() {
  const text = els.quickInput.value.trim();

  if (!text) {
    setQuickStatus('先输入点内容', 'err');
    els.quickInput.focus();
    return;
  }

  els.quickGo.disabled = true;
  setQuickStatus('翻译中…', '');

  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'translate', text });
  } catch (_) {
    resp = { ok: false, error: '与插件后台通信失败，请重新加载扩展' };
  }

  els.quickGo.disabled = false;

  if (!resp || !resp.ok) {
    setQuickStatus((resp && resp.error) || '翻译失败', 'err');
    return;
  }

  els.quickOutput.textContent = resp.text;
  els.quickOutput.hidden = false;
  els.quickCopy.hidden = false;

  if (resp.cached) {
    setQuickStatus('缓存命中', 'ok');
  } else {
    const secs = resp.ms ? ` · ${(resp.ms / 1000).toFixed(1)}s` : '';
    const via = resp.triedCount > 1 ? ` · 已切到 ${resp.providerName}` : '';
    setQuickStatus(`完成${secs}${via}`, 'ok');
  }
}

/* --------------------------------- 启动 --------------------------------- */

async function init() {
  const stored = await chrome.storage.local.get([
    'enabled',
    'providers',
    'providerStats',
    'targetLang',
    'triggerCount',
    'engines'
  ]);

  els.enabled.checked = stored.enabled !== false;
  fillLanguages(stored.targetLang || 'en');
  // 全新安装时 storage 里还没有 engines 这个键 —— 用默认值兜底，
  // 否则会把「谷歌免费通道默认开着」误判成「什么都没配」
  const engines = { ...DEFAULT_SETTINGS.engines, ...(stored.engines || {}) };
  renderProviderStatus(stored.providers, engines);
  renderSpeed(stored.providers, stored.providerStats);

  const times = stored.triggerCount || 3;
  els.hint.innerHTML = `在任意输入框输入中文，<b>连敲 ${times} 次空格</b>即可翻译并替换。`;

  checkCurrentPage();
  renderDriftWarn(); // 不 await：它要等后台回话，别拖慢界面渲染
}

els.enabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: els.enabled.checked });
});

els.lang.addEventListener('change', () => {
  chrome.storage.local.set({ targetLang: els.lang.value });
});

els.openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

/**
 * 「添加 AI 服务商」按钮：只打开设置页，不替用户跳某一家官网。
 * 设置页里 Groq / 智谱 / Agnes 三家并列，各自带申请入口，选哪家是用户的事。
 */
function openProviderSetup() {
  chrome.runtime.openOptionsPage();
}

els.getKey.addEventListener('click', openProviderSetup);
els.keyStatusAction.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

els.driftAction.addEventListener('click', () => {
  // 直接让扩展重载：扩展无权打开 chrome:// / edge:// 这类受保护页面，
  // 旧写法 tabs.create('chrome://extensions') 在 Chrome 和 Edge 上都会抛错。
  reloadExtension();
});

/* ------------------------------- 快捷翻译事件 ------------------------------- */

els.quickGo.addEventListener('click', quickTranslate);

els.quickInput.addEventListener('keydown', (e) => {
  // Ctrl / Cmd + Enter 直接翻译
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    quickTranslate();
  }
});

els.quickCopy.addEventListener('click', async () => {
  const text = els.quickOutput.textContent || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setQuickStatus('已复制到剪贴板', 'ok');
  } catch (_) {
    setQuickStatus('复制失败，请手动选中复制', 'err');
  }
});

init();
