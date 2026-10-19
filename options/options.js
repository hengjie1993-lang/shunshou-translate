import { LANGUAGES } from '../lib/translator.js';
import { PROVIDER_PRESETS, makeProvider, usableProviders } from '../lib/providers.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../lib/settings.js';
import { orderBySpeed, describeStat } from '../lib/stats.js';
import { localLang, pickLocalSourceLang } from '../lib/freeEngines.js';
import { checkVersionDrift as checkVersionDriftShared, runningVersionOf } from '../lib/versionGuard.js';

/* --------------------------------- 元素 --------------------------------- */

const els = {
  enabled: document.getElementById('enabled'),
  savedFlag: document.getElementById('savedFlag'),
  verText: document.getElementById('verText'),
  banner: document.getElementById('banner'),
  staleBanner: document.getElementById('staleBanner'),
  staleDiskWrap: document.getElementById('staleDiskWrap'),
  staleDisk: document.getElementById('staleDisk'),
  staleRun: document.getElementById('staleRun'),
  staleOpen: document.getElementById('staleOpen'),
  staleCopy: document.getElementById('staleCopy'),
  presets: document.getElementById('presets'),
  providers: document.getElementById('providers'),
  addCustom: document.getElementById('addCustom'),
  smartBox: document.getElementById('smartBox'),
  smartDesc: document.getElementById('smartDesc'),
  smartFlash: document.getElementById('smartFlash'),
  resetSpeed: document.getElementById('resetSpeed'),
  triggerCount: document.getElementById('triggerCount'),
  triggerWindow: document.getElementById('triggerWindow'),
  targetLang: document.getElementById('targetLang'),
  tone: document.getElementById('tone'),
  cacheEnabled: document.getElementById('cacheEnabled'),
  cacheStat: document.getElementById('cacheStat'),
  clearCache: document.getElementById('clearCache'),
  engineGoogle: document.getElementById('engineGoogle'),
  engineLocal: document.getElementById('engineLocal'),
  engineGoogleStat: document.getElementById('engineGoogleStat'),
  engineLocalStat: document.getElementById('engineLocalStat'),
  blacklist: document.getElementById('blacklist'),
  resetBtn: document.getElementById('resetBtn')
};

/** 当前配置（内存中的唯一真源） */
let state = null;

/** 服务商实测速度统计（内存镜像，写操作后回读刷新） */
let stats = {};

/** 离线翻译实例（留着引用，模型就不会被回收，下次开设置页秒就绪） */
let localTranslator = null;
let localTranslatorKey = '';

/* --------------------------------- 工具 --------------------------------- */

function debounce(fn, wait) {
  let timer = 0;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function flashSaved() {
  els.savedFlag.classList.add('saved--on');
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => els.savedFlag.classList.remove('saved--on'), 1300);
}

async function persist(patch) {
  await saveSettings(patch);
  flashSaved();
}

function parseBlacklist(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\n,;，；]/)) {
    const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

function hasUsableProvider() {
  return (state.providers || []).some(
    (p) => p && p.enabled !== false && p.apiKey && p.endpoint && p.model
  );
}

/* --------------------------------- 渲染 --------------------------------- */

function renderLanguages(selected) {
  els.targetLang.innerHTML = '';
  for (const lang of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.key;
    opt.textContent = `${lang.label}（${lang.native}）`;
    if (lang.key === selected) opt.selected = true;
    els.targetLang.appendChild(opt);
  }
}

function renderPresets() {
  const used = new Set((state.providers || []).map((p) => p.name));
  els.presets.innerHTML = '';

  for (const preset of PROVIDER_PRESETS) {
    if (preset.preset === 'custom') continue;
    const added = used.has(preset.name);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset' + (added ? ' preset--added' : '');
    btn.dataset.preset = preset.preset;
    btn.disabled = added;
    btn.innerHTML =
      `<span class="preset__name">${esc(preset.name)}</span>` +
      `<span class="preset__note">${esc(added ? '已添加' : preset.note)}</span>`;

    els.presets.appendChild(btn);
  }
}

function providerHTML(p, index, total, rankMap) {
  const preset = PROVIDER_PRESETS.find((x) => x.name === p.name);
  const signup = preset && preset.signup ? preset.signup : '';
  const off = p.enabled === false;
  const usable = !off && p.apiKey && p.endpoint && p.model;

  const speed = describeStat(stats[p.id]);
  const rank = usable && rankMap ? rankMap[p.id] : 0;

  // 还没测出速度时不写「测速中…」四个字，改画一条骨架条 —— 一眼就知道是在加载。
  // 那句话仍留在 DOM 里（.sr-only），读屏软件照样念得出来。
  const speedChip =
    speed.text === '测速中…'
      ? '<span class="provider__speed provider__speed--cold provider__speed--pending">' +
        '<span class="sr-only">测速中…</span><i class="skel" aria-hidden="true"></i></span>'
      : `<span class="provider__speed provider__speed--${speed.tone}">${esc(speed.text)}</span>`;

  const chips =
    speedChip + (rank ? `<span class="provider__rank">当前第 ${rank} 位</span>` : '');

  return (
    `<div class="provider${index === 0 ? ' provider--primary' : ''}${off ? ' provider--off' : ''}" data-id="${esc(p.id)}">` +
      '<div class="provider__head">' +
        `<span class="provider__index">${index + 1}</span>` +
        `<input class="provider__name" type="text" data-field="name" value="${esc(p.name)}" spellcheck="false" />` +
        chips +
        '<div class="provider__ops">' +
          '<label class="switch switch--sm" title="启用 / 停用">' +
            `<input type="checkbox" data-act="toggle"${off ? '' : ' checked'} />` +
            '<span class="switch__track"></span>' +
          '</label>' +
          `<button class="btn" data-act="up" type="button"${index === 0 ? ' disabled' : ''} title="上移">↑</button>` +
          `<button class="btn" data-act="down" type="button"${index === total - 1 ? ' disabled' : ''} title="下移">↓</button>` +
          '<button class="btn" data-act="del" type="button" title="删除">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="grid">' +
        '<div class="grid__full">' +
          '<label class="field__label">API Key</label>' +
          '<div class="input-row">' +
            `<input class="field__control" type="password" data-field="apiKey" value="${esc(p.apiKey)}" placeholder="粘贴你的 API Key" autocomplete="off" spellcheck="false" />` +
            '<button class="btn btn--mini" data-act="toggleKey" type="button">显示</button>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<label class="field__label">接口地址</label>' +
          `<input class="field__control" type="text" data-field="endpoint" value="${esc(p.endpoint)}" spellcheck="false" />` +
        '</div>' +
        '<div>' +
          '<label class="field__label">模型</label>' +
          `<input class="field__control" type="text" data-field="model" value="${esc(p.model)}" spellcheck="false" />` +
        '</div>' +
      '</div>' +
      '<div class="provider__foot">' +
        `<button class="btn" data-act="test" type="button">测试连接</button>` +
        (signup
          ? `<button class="btn" data-act="signup" data-url="${esc(signup)}" type="button">获取免费 Key</button>`
          : '') +
        '<span class="provider__result"></span>' +
      '</div>' +
    '</div>'
  );
}

/** 当前生效的排序（仅统计可用服务商）→ { providerId: rank } */
function computeRankMap() {
  const ordered = orderBySpeed(usableProviders(state.providers), stats);
  const map = {};
  ordered.forEach((p, i) => {
    map[p.id] = i + 1;
  });
  return map;
}

function renderProviders() {
  const list = state.providers || [];

  if (!list.length) {
    els.providers.innerHTML =
      '<div class="providers__empty">还没有添加任何翻译服务，从上面的「快速添加」挑一家吧</div>';
    return;
  }

  const rankMap = computeRankMap();
  els.providers.innerHTML = list
    .map((p, i) => providerHTML(p, i, list.length, rankMap))
    .join('');
}

/**
 * 顶部「智能模式」一行说明。
 * 原来这里还挂着一排排序标签（1Groq → 2GLM → 3Agnes），
 * 但每张服务卡片上已经有「当前第 N 位」标记了，重复一遍只是占地方，删掉。
 */
function renderSmartBox() {
  const usable = usableProviders(state.providers);

  if (!usable.length) {
    els.smartDesc.textContent = '还没填 AI 服务商 —— 免费引擎已经够用，想加再往下加';
    return;
  }

  const ordered = orderBySpeed(usable, stats);
  const first = ordered[0];
  const s = describeStat(stats[first.id]);
  const speed = s.text && s.text !== '测速中…' ? `（${s.text}）` : '';
  els.smartDesc.textContent = `自动按实测速度排序，优先 ${first.name}${speed}，失败自动切下一家 —— 不用你选`;
}

/** 重新读取速度统计（内存镜像 + 卡片刷新） */
async function refreshStats() {
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'providerStats' });
  } catch (_) {
    resp = null;
  }
  stats = (resp && resp.stats) || {};
  renderProviders();
  renderSmartBox();
}

function flashSmart(text, kind) {
  els.smartFlash.textContent = text;
  els.smartFlash.className = 'smart__flash smart__flash--' + (kind || 'ok');
  clearTimeout(flashSmart.timer);
  flashSmart.timer = setTimeout(() => {
    els.smartFlash.textContent = '';
    els.smartFlash.className = 'smart__flash';
  }, 6000);
}

function renderBanner() {
  els.banner.hidden = hasUsableProvider();
}

/* --------------------------------- 版本自检 --------------------------------- */

/**
 * 版本自检：三个版本号（磁盘 / 页面 / 后台）对不上就亮红灯。
 * 判断逻辑在 lib/versionGuard.js，设置页和弹窗共用同一份，避免两边跑偏。
 */
async function checkVersionDrift() {
  const result = await checkVersionDriftShared();
  const { stale, disk } = result;
  const running = runningVersionOf(result);

  els.verText.textContent = 'v' + (result.page || '—');

  if (!stale) {
    els.staleBanner.hidden = true;
    els.verText.title = '浏览器当前实际加载的版本';
    return false;
  }

  // 读不到磁盘版本时（极少数情况）就把那半句藏掉，不显示「v?」这种糊弄人的东西
  els.staleDiskWrap.hidden = !disk;
  els.staleDisk.textContent = 'v' + (disk || '—');
  els.staleRun.textContent = 'v' + (running || '?');
  els.staleBanner.hidden = false;
  els.verText.title = disk
    ? `磁盘上是 v${disk}，浏览器实际加载的是 v${running || '?'}`
    : `浏览器实际加载的是 v${running || '?'}`;
  return true;
}

function bindStaleBanner() {
  els.staleOpen.addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: 'chrome://extensions' });
    } catch (_) {
      /* 打不开也不影响，下面还有复制地址 */
    }
  });

  els.staleCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('chrome://extensions');
      els.staleCopy.textContent = '已复制';
      setTimeout(() => {
        els.staleCopy.textContent = '复制地址';
      }, 1500);
    } catch (_) {
      /* 剪贴板不可用就算了 */
    }
  });
}

function renderForm() {
  els.enabled.checked = state.enabled !== false;
  els.triggerCount.value = String(state.triggerCount || 3);
  els.triggerWindow.value = String(state.triggerWindow || 500);
  els.tone.value = state.tone || 'natural';
  els.cacheEnabled.checked = state.cacheEnabled !== false;
  const engines = state.engines || {};
  els.engineGoogle.checked = engines.google !== false;
  els.engineLocal.checked = engines.local === true;
  els.blacklist.value = (Array.isArray(state.blacklist) ? state.blacklist : []).join('\n');
  renderLanguages(state.targetLang || 'en');
}

function renderAll() {
  renderPresets();
  renderProviders();
  renderSmartBox();
  renderBanner();
  renderForm();
}

/* --------------------------------- 缓存统计 --------------------------------- */

async function refreshCacheStat() {
  let stat = null;
  try {
    stat = await chrome.runtime.sendMessage({ type: 'cacheStats' });
  } catch (_) {
    /* ignore */
  }

  if (!stat) {
    els.cacheStat.textContent = '读取失败';
    return;
  }

  const kb = Math.max(1, Math.round((stat.approxBytes || 0) / 1024));
  els.cacheStat.textContent =
    stat.entries > 0
      ? `已缓存 ${stat.entries} 条 · 命中 ${stat.hits} 次 · 约 ${kb} KB`
      : '还没有缓存内容';
}

/* --------------------------------- 服务商操作 --------------------------------- */

function findProvider(id) {
  return (state.providers || []).find((p) => p.id === id) || null;
}

async function commitProviders() {
  renderPresets();
  renderSmartBox();
  renderBanner();
  await persist({ providers: state.providers });
}

const saveProvidersSoon = debounce(() => {
  persist({ providers: state.providers });
}, 500);

els.presets.addEventListener('click', async (e) => {
  const btn = e.target.closest('.preset');
  if (!btn || btn.disabled) return;

  state.providers.push(makeProvider(btn.dataset.preset));
  renderProviders();
  await commitProviders();
});

els.addCustom.addEventListener('click', async () => {
  state.providers.push(makeProvider('custom', { name: '自定义服务' }));
  renderProviders();
  await commitProviders();
});

els.providers.addEventListener('input', (e) => {
  const input = e.target.closest('[data-field]');
  if (!input) return;

  const card = input.closest('.provider');
  const provider = card && findProvider(card.dataset.id);
  if (!provider) return;

  const field = input.dataset.field;
  provider[field] = input.value;

  renderBanner();
  renderSmartBox();
  saveProvidersSoon();
});

els.providers.addEventListener('change', async (e) => {
  const toggle = e.target.closest('[data-act="toggle"]');
  if (!toggle) return;

  const card = toggle.closest('.provider');
  const provider = card && findProvider(card.dataset.id);
  if (!provider) return;

  provider.enabled = toggle.checked;
  card.classList.toggle('provider--off', !toggle.checked);
  renderBanner();
  renderSmartBox();
  await persist({ providers: state.providers });
});

els.providers.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;

  const act = btn.dataset.act;
  if (act === 'toggle') return; // 交给 change 事件

  const card = btn.closest('.provider');
  const provider = card && findProvider(card.dataset.id);
  if (!provider) return;

  const index = state.providers.indexOf(provider);

  if (act === 'toggleKey') {
    const input = card.querySelector('[data-field="apiKey"]');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '显示' : '隐藏';
    return;
  }

  if (act === 'del') {
    const ok = window.confirm(`确定删除「${provider.name}」？`);
    if (!ok) return;
    state.providers.splice(index, 1);
    renderProviders();
    await commitProviders();
    return;
  }

  if (act === 'up' && index > 0) {
    const [item] = state.providers.splice(index, 1);
    state.providers.splice(index - 1, 0, item);
    renderProviders();
    await commitProviders();
    return;
  }

  if (act === 'down' && index < state.providers.length - 1) {
    const [item] = state.providers.splice(index, 1);
    state.providers.splice(index + 1, 0, item);
    renderProviders();
    await commitProviders();
    return;
  }

  if (act === 'signup') {
    const url = btn.dataset.url;
    if (url) chrome.tabs.create({ url });
    return;
  }

  if (act === 'test') {
    await testProvider(provider, card);
  }
});

async function testProvider(provider, card) {
  const result = card.querySelector('.provider__result');
  const btn = card.querySelector('[data-act="test"]');

  const setResult = (text, kind) => {
    result.textContent = text;
    result.className = 'provider__result' + (kind ? ` provider__result--${kind}` : '');
  };

  if (!provider.apiKey) {
    setResult('请先填写 API Key', 'err');
    return;
  }

  btn.disabled = true;
  setResult('测试中…', '');

  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'testProvider',
      provider: {
        id: provider.id,
        name: provider.name,
        endpoint: provider.endpoint,
        model: provider.model,
        apiKey: provider.apiKey
      }
    });
  } catch (_) {
    resp = { ok: false, error: '无法与插件后台通信，请重新加载扩展' };
  }

  btn.disabled = false;

  if (resp && resp.ok) {
    const secs = resp.ms ? (resp.ms / 1000).toFixed(1) : '—';
    setResult(`连接正常 · ${secs}s · 「${resp.text}」`, 'ok');
  } else if (resp && resp.code === 'rate_limit') {
    // 429 ≠ Key 填错了。智谱免费档高峰期常回 429（code 1305「访问量过大」），
    // Agnes 免费池也会限流 —— 能走到限流这一步，说明鉴权已经通过了。
    // 早先这里直接显示「测试失败」，害得用户反复去重填一个本来正确的 Key。
    setResult('配置可用 · 服务商当前限流，插件会自动重试', 'warn');
  } else if (resp && resp.code === 'timeout') {
    setResult('未在 20 秒内返回 · 服务商拥堵，稍后重试即可', 'warn');
  } else {
    setResult((resp && resp.error) || '测试失败', 'err');
  }

  // 测试结果也会写进速度统计，刷新一下卡片上的「实测」标记
  await refreshStats();
}

/* --------------------------------- 其他事件 --------------------------------- */

function bind() {
  els.resetSpeed.addEventListener('click', async () => {
    const ok = window.confirm(
      '确定让插件重新学习速度？\n已记录的实测延迟会清空，随后插件会在后台自动重新测一遍。'
    );
    if (!ok) return;

    els.resetSpeed.disabled = true;
    flashSmart('已清空，正在后台重新测速…', 'info');

    try {
      await chrome.runtime.sendMessage({ type: 'resetProviderStats' });
    } catch (_) {
      /* ignore */
    }

    await refreshStats();
    els.resetSpeed.disabled = false;
    flashSmart('已重新开始学习，几秒后即可看到最新的速度排序', 'ok');
  });

  els.enabled.addEventListener('change', () => {
    persist({ enabled: els.enabled.checked });
  });

  els.triggerCount.addEventListener('change', () => {
    persist({ triggerCount: Number(els.triggerCount.value) || 3 });
  });

  els.triggerWindow.addEventListener('change', () => {
    persist({ triggerWindow: Number(els.triggerWindow.value) || 500 });
  });

  els.targetLang.addEventListener('change', () => {
    persist({ targetLang: els.targetLang.value });
    // 换了目标语言，离线模型要换一个语向，状态得重测
    refreshEngineStats();
  });

  els.tone.addEventListener('change', () => {
    persist({ tone: els.tone.value });
  });

  els.cacheEnabled.addEventListener('change', () => {
    persist({ cacheEnabled: els.cacheEnabled.checked });
  });

  els.engineGoogle.addEventListener('change', async () => {
    const on = els.engineGoogle.checked;
    state.engines = { ...(state.engines || {}), google: on };
    await persist({ engines: state.engines });
    if (on) refreshEngineStats();
    else setEngineStat(els.engineGoogleStat, '已关闭 —— 翻译时跳过这一层');
  });

  els.engineLocal.addEventListener('change', async () => {
    const on = els.engineLocal.checked;

    if (!on) {
      state.engines = { ...(state.engines || {}), local: false };
      await persist({ engines: state.engines });
      setEngineStat(els.engineLocalStat, '已关闭 —— 翻译时跳过这一层');
      return;
    }

    // 打开时先把模型下好（有进度条，体验最好）。
    // 但下不动也照样允许开 —— 内容脚本会在你下次三连空格时接着下，
    // 那一次先用谷歌通道翻译，第二次就能用上离线的了。
    const ok = await downloadLocalModel();
    els.engineLocal.checked = true;
    state.engines = { ...(state.engines || {}), local: true };
    await persist({ engines: state.engines });
    if (!ok) {
      setEngineStat(
        els.engineLocalStat,
        '已开启。这里没能下载，会在你下次三连空格时自动重试下载',
        'warn'
      );
    }
  });

  els.clearCache.addEventListener('click', async () => {
    const ok = window.confirm('确定清空本地翻译缓存？已缓存的译文会全部删除。');
    if (!ok) return;
    try {
      await chrome.runtime.sendMessage({ type: 'clearCache' });
    } catch (_) {
      /* ignore */
    }
    refreshCacheStat();
  });

  const saveBlacklist = debounce(() => {
    persist({ blacklist: parseBlacklist(els.blacklist.value) });
  }, 500);

  els.blacklist.addEventListener('input', saveBlacklist);
  els.blacklist.addEventListener('blur', () => {
    const list = parseBlacklist(els.blacklist.value);
    els.blacklist.value = list.join('\n');
    persist({ blacklist: list });
  });

  els.resetBtn.addEventListener('click', async () => {
    const ok = window.confirm('确定恢复默认设置？已保存的 API Key 也会被清空。');
    if (!ok) return;
    await saveSettings({ ...DEFAULT_SETTINGS, providers: [{ ...DEFAULT_SETTINGS.providers[0] }] });
    state = await loadSettings();
    await refreshStats();
    renderAll();
    flashSaved();
  });
}

/* --------------------------------- 免费引擎 --------------------------------- */

function setEngineStat(el, text, tone) {
  el.textContent = text;
  el.className = 'engine__stat' + (tone ? ' engine__stat--' + tone : '');
}

/**
 * 把两个免费引擎的当前状态显示出来。
 * 这一步很重要 —— 用户点开关之前得先知道「现在到底能不能用」，
 * 否则开关打开了却一直静默失效，比没有这个功能还糟。
 */
async function refreshEngineStats() {
  // 谷歌通道：让后台真发一次请求，测出真实延迟
  setEngineStat(els.engineGoogleStat, '检测中…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'engineCheck' });
    if (r && r.ok) {
      const secs = r.google.ms ? (r.google.ms / 1000).toFixed(2) + ' 秒' : '';
      setEngineStat(els.engineGoogleStat, `可用 · 实测 ${secs} ·「${r.google.text}」`, 'ok');
    } else {
      const why = r && r.google && r.google.error ? `（${r.google.error}）` : '';
      setEngineStat(els.engineGoogleStat, `当前不通${why}，翻译时会自动跳到下一层`, 'warn');
    }
  } catch (_) {
    setEngineStat(els.engineGoogleStat, '无法检测（后台未响应）', 'warn');
  }

  // 离线引擎：只看模型下好没有，不在这里触发下载
  if (typeof Translator === 'undefined') {
    setEngineStat(els.engineLocalStat, '此浏览器不支持 —— 需要 Chrome 138 及以上', 'warn');
    els.engineLocal.disabled = true;
    return;
  }
  const to = localLang(state.targetLang || 'en');
  // 源语言必须和 to 不同：Chrome 对同语种一律回 unavailable，
  // 那不是「不支持」，是「这对语向没意义」。写错会让状态栏永远误报。
  const from = pickLocalSourceLang(state.targetLang || 'en');
  try {
    const a = await Translator.availability({ sourceLanguage: from, targetLanguage: to });
    if (a === 'available') {
      setEngineStat(els.engineLocalStat, `模型已就绪（${from}→${to}），可以用了`, 'ok');
    } else if (a === 'downloadable') {
      setEngineStat(els.engineLocalStat, `模型还没下载（${from}→${to}）—— 打开开关会自动开始下载`);
    } else if (a === 'downloading') {
      setEngineStat(els.engineLocalStat, '模型正在下载中…');
    } else {
      setEngineStat(els.engineLocalStat, `这对语向（${from}→${to}）没有离线模型，翻译时会走下一层`, 'warn');
    }
  } catch (e) {
    setEngineStat(els.engineLocalStat, '检测失败：' + ((e && e.message) || e), 'warn');
  }
}

/**
 * 在设置页把离线模型下好。
 *
 * 为什么不在内容脚本里下：下载需要**用户手势**，而且要好几十秒。
 * 让用户第一次三连空格时干等下载是很糟的体验 ——
 * 设置页这里点开关正好是手势，进度条也能好好显示。
 * 内容脚本只在模型已就绪时才用离线引擎。
 */
async function downloadLocalModel() {
  const to = localLang(state.targetLang || 'en');
  setEngineStat(els.engineLocalStat, '正在下载模型…');

  try {
    localTranslator = await Translator.create({
      sourceLanguage: 'en',
      targetLanguage: to,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.round((e.loaded / (e.total || 1)) * 100);
          // 进度直接写在状态行里，不再单独拉一根进度条 —— 少一个 DOM、少一套样式
          setEngineStat(els.engineLocalStat, `正在下载模型… ${pct}%`);
        });
      }
    });
    localTranslatorKey = 'en|' + to;
    setEngineStat(els.engineLocalStat, '模型已就绪，断网也能用', 'ok');
    return true;
  } catch (e) {
    const denied = e && e.name === 'NotAllowedError';
    setEngineStat(
      els.engineLocalStat,
      denied
        ? '浏览器要求下载必须由点击触发 —— 请再点一次开关'
        : '下载失败：' + ((e && e.message) || e),
      'err'
    );
    return false;
  }
}

/* --------------------------------- 启动 --------------------------------- */

(async function init() {
  // 先把版本自检亮出来：磁盘上的版本 / 后台实际在跑的版本一旦对不上，直接弹红色告警。
  // 这比在角落显示一个版本号有用得多 —— 那个数字用户不会去比。
  bindStaleBanner();
  checkVersionDrift();

  state = await loadSettings();
  await refreshStats();
  renderAll();
  bind();
  refreshCacheStat();
  refreshEngineStats();

  // 后台正在自动测速，页面开着的时候定期回读，让「测速中…」自动变成「实测 1.2s」
  setInterval(() => {
    if (document.hidden) return;
    refreshStats();
  }, 5000);
})();
