/**
 * 内容脚本：监听输入框的「连敲空格」触发，并把译文回填。
 *
 * 设计要点
 * - 用 capture 阶段监听 keydown，第 N 次空格会被拦截，不进入输入框
 * - 用 e.isComposing / keyCode 229 排除中文输入法选词时空格的误触发
 * - 回填时用原生 value setter + input 事件，兼容 React / Vue 受控组件
 * - contenteditable 用 execCommand('insertText')，保留撤销栈
 */

(function () {
  'use strict';

  // 防止重复注入（声明式注入 + 后台补注入可能同时发生，重复注册会导致计数翻倍）
  if (window.__agnesTranslatorLoaded) return;
  window.__agnesTranslatorLoaded = true;

  const DEFAULTS = {
    enabled: true,
    providers: [],
    targetLang: 'en',
    triggerCount: 3,
    triggerWindow: 500,
    blacklist: ['mail.google.com', 'docs.google.com'],
    maxChars: 8000,
    engines: { google: true, local: false }
  };

  let settings = { ...DEFAULTS };
  let active = false;

  let spaceCount = 0;
  let lastSpaceAt = 0;
  let lastEl = null;
  let busy = false;

  /* ------------------------------- 配置加载 ------------------------------- */

  async function loadSettings() {
    let stored = {};
    try {
      stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    } catch (_) {
      return;
    }
    settings = { ...DEFAULTS, ...stored };

    // 内容脚本不需要、也不应该持有 API Key。
    // 它只关心「这家配没配 Key」，所以读完立刻把密钥摘掉，只留一个布尔值。
    // 真正的翻译请求由后台 Service Worker 发起，Key 全程不进内容脚本所在的世界。
    settings.providers = (Array.isArray(settings.providers) ? settings.providers : []).map((p) => ({
      id: (p && p.id) || '',
      enabled: !(p && p.enabled === false),
      endpoint: (p && p.endpoint) || '',
      model: (p && p.model) || '',
      hasKey: !!(p && p.apiKey)
    }));

    active = !!settings.enabled && !isBlacklisted();
  }

  function isBlacklisted() {
    const host = location.hostname;
    if (!host) return false;
    const list = Array.isArray(settings.blacklist) ? settings.blacklist : [];
    return list.some((entry) => {
      const rule = String(entry || '').trim().toLowerCase();
      if (!rule) return false;
      return host === rule || host.endsWith('.' + rule);
    });
  }

  /** 至少有一家服务商配好了 Key / 地址 / 模型 */
  function hasUsableProvider() {
    const list = Array.isArray(settings.providers) ? settings.providers : [];
    return list.some(
      (p) => p && p.enabled !== false && p.hasKey && p.endpoint && p.model
    );
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      loadSettings();
    });
  } catch (_) {
    /* ignore */
  }

  /* ------------------------------- 输入框判定 ------------------------------- */

  const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'number']);

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;

    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;

    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (!TEXT_TYPES.has(type)) return false;
      return !el.disabled && !el.readOnly;
    }

    if (el.isContentEditable === true) return true;
    return false;
  }

  function findEditable(node) {
    let el = node;
    let depth = 0;
    while (el && el.nodeType === 1 && depth < 12) {
      if (isEditable(el)) return el;
      el = el.parentElement;
      depth += 1;
    }
    return null;
  }

  /* ------------------------------- 读写输入框 ------------------------------- */

  function readField(el) {
    if (el.isContentEditable) return el.innerText || el.textContent || '';
    return el.value || '';
  }

  function writeField(el, text) {
    if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text);
      } catch (_) {
        ok = false;
      }
      if (!ok) el.textContent = text;
      sel.removeAllRanges();
      return;
    }

    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, text);
    else el.value = text;

    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function stripTail(text) {
    return String(text || '').replace(/[\s\u00a0]+$/, '');
  }

  /* ------------------------------- 状态提示 ------------------------------- */

  let toastNode = null;
  let toastTimer = 0;

  function removeToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = 0;
    }
    if (toastNode && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode);
    toastNode = null;
  }

  function showToast(anchor, message, kind, onAction, ttl) {
    removeToast();

    const node = document.createElement('div');
    node.className = 'agnes-toast agnes-toast--' + kind;

    const label = document.createElement('span');
    label.className = 'agnes-toast__label';
    label.textContent = message;
    node.appendChild(label);

    if (kind === 'loading') {
      const spin = document.createElement('span');
      spin.className = 'agnes-toast__spinner';
      node.appendChild(spin);
    }

    if (typeof onAction === 'function') {
      node.classList.add('agnes-toast--clickable');
      node.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onAction();
      });
    }

    document.documentElement.appendChild(node);
    toastNode = node;

    // 定位到输入框右下角
    const rect = anchor.getBoundingClientRect();
    const width = node.offsetWidth || 160;
    const height = node.offsetHeight || 26;
    let left = rect.right - width;
    let top = rect.bottom + 6;

    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);

    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';

    if (ttl) {
      toastTimer = window.setTimeout(() => {
        toastNode = null;
        if (node.parentNode) node.parentNode.removeChild(node);
      }, ttl);
    }
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'openOptions' });
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------- 触发逻辑 ------------------------------- */

  function resetCounter() {
    spaceCount = 0;
    lastEl = null;
  }

  function onKeyDown(e) {
    if (!active) return;

    const isSpace = e.key === ' ' || e.code === 'Space' || e.keyCode === 32;
    if (!isSpace) {
      resetCounter();
      return;
    }

    // 输入法组合中（选词用的空格）不计数
    if (e.isComposing || e.keyCode === 229) {
      resetCounter();
      return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) {
      resetCounter();
      return;
    }

    const el = findEditable(e.target);
    if (!el) {
      resetCounter();
      return;
    }

    const now = Date.now();
    if (el !== lastEl || now - lastSpaceAt > settings.triggerWindow) spaceCount = 0;

    spaceCount += 1;
    lastSpaceAt = now;
    lastEl = el;

    if (spaceCount < settings.triggerCount) return;

    spaceCount = 0;

    // 拦截最后一次空格，不让它进入输入框
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

    if (busy) return;
    runTranslate(el);
  }

  async function runTranslate(el, attempt) {
    const raw = readField(el);
    const source = stripTail(raw);

    if (!source.trim()) return;

    if (source.length > settings.maxChars) {
      showToast(el, `内容太长（${source.length} 字），上限 ${settings.maxChars} 字`, 'error', null, 4000);
      return;
    }

    const engines = settings.engines || {};

    // 免费引擎能用的话，没配 AI 服务商也能翻译 —— 不再一刀切地拦人
    if (!hasUsableProvider() && !engines.google && !engines.local) {
      showToast(el, '还没配置翻译服务，点这里去设置', 'error', openOptions, 6000);
      return;
    }

    busy = true;
    showToast(el, '翻译中…', 'loading');

    // 免费额度偶尔会限流，超过 3.5 秒还没回来就说明在自动重试
    const slowTimer = window.setTimeout(() => {
      showToast(el, '翻译中…（服务繁忙，自动重试中）', 'loading');
    }, 3500);

    let resp = null;

    // ① 离线引擎：模型在本机，实测 11–31ms，最快
    if (engines.local) {
      const r = await localTranslate(source);
      if (r.ok) resp = r;
    }

    // ② 谷歌免费通道：零配置，实测约 0.5 秒，质量比离线模型更好
    if (!resp && engines.google) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'translateFree', text: source });
        if (r && r.ok) resp = r;
      } catch (_) {
        /* 后台不通就往下走 AI 服务商 */
      }
    }

    // ③ 免费引擎都没成 → 走 AI 服务商故障转移（原有逻辑）
    if (!resp) {
      try {
        resp = await chrome.runtime.sendMessage({ type: 'translate', text: source });
      } catch (_) {
        resp = { ok: false, error: '与插件后台通信失败，刷新页面后重试' };
      }
    }

    clearTimeout(slowTimer);
    busy = false;

    if (!resp) resp = { ok: false, error: '没有收到后台响应' };

    if (!resp.ok) {
      // 只清理触发用的尾随空格，不动用户后续输入
      if (readField(el) === raw) writeField(el, source);

      const message = resp.error || '翻译失败';
      const code = resp.code || '';

      // 优先按**错误码**判断，别猜中文文案 —— 服务端返回的原话里可能碰巧带
      // 「模型」「Key」这类词（智谱的 429 就写着「该模型当前访问量过大」），
      // 只看文案会把「限流，等会儿就好」误判成「配置错了，去改设置」。
      const CONFIG_CODES = new Set([
        'auth',
        'notfound',
        'model_retired',
        'no_key',
        'no_endpoint',
        'no_model',
        'no_provider'
      ]);
      const RETRY_CODES = new Set(['rate_limit', 'timeout', 'server', 'network', 'parse', 'empty']);

      const isConfigError =
        CONFIG_CODES.has(code) ||
        /API Key|接口地址|没有填写|没有可翻译|模型已下线|都已下线|模型已不可用/.test(message);
      const retryable =
        !isConfigError && (RETRY_CODES.has(code) || /限流|频繁|繁忙|网络|超时|失败|服务端/.test(message));

      if (retryable && !attempt) {
        showToast(el, `${message} · 点击重试`, 'error', () => runTranslate(el, 1), 12000);
      } else {
        showToast(el, message, 'error', openOptions, isConfigError ? 9000 : 6000);
      }
      return;
    }

    // 若翻译期间内容已被改动，则不覆盖，改为复制译文
    const current = stripTail(readField(el));
    const unchanged = current === source || current.trim() === source.trim();

    if (!unchanged) {
      copyText(resp.text);
      showToast(el, '内容已变动，译文已复制到剪贴板', 'success', null, 4000);
      return;
    }

    writeField(el, resp.text);

    const lang = langLabel(settings.targetLang);
    let detail = '';
    if (resp.cached) {
      detail = ' · 缓存命中';
    } else {
      const secs = resp.ms ? ` · ${(resp.ms / 1000).toFixed(1)}s` : '';
      // 免费引擎报一下是哪一层干的活（离线 / 谷歌），方便判断要不要留
      const via =
        resp.triedCount > 1
          ? ` · 已切到 ${resp.providerName}`
          : resp.free
            ? ` · ${resp.providerName}`
            : '';
      detail = secs + via;
    }

    showToast(el, `已翻译 → ${lang}${detail}`, 'success', null, 1800);
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function langLabel(key) {
    const map = {
      en: 'English',
      zh: '简体中文',
      'zh-TW': '繁體中文',
      ja: '日本語',
      ko: '한국어',
      de: 'Deutsch',
      fr: 'Français',
      es: 'Español',
      ru: 'Русский',
      pt: 'Português',
      it: 'Italiano',
      ar: 'العربية',
      th: 'ไทย',
      vi: 'Tiếng Việt'
    };
    return map[key] || key || 'English';
  }

  /* ---------------------------- 免费引擎：离线翻译 ---------------------------- */

  /*
   * 用的是 Chrome 138+ 内置的 Translator API —— 模型跑在本机，
   * 实测单句 11–31ms（网络接口最快也要 200ms），且永久免费、断网可用。
   *
   * 两个必须知道的约束（都是实测出来的，不是猜的）：
   * 1. 模型每个语向要单独下载（en→zh 约几十 MB），
   *    且**下载时必须有用户手势** —— 三连空格正好是手势，所以内容脚本里能下。
   *    但下载要 20 秒左右，不能卡住用户这一次，所以策略是：
   *    只有 `availability() === 'available'`（已经下好）才用，
   *    没下好的交给设置页去下、这一次直接走谷歌通道。
   * 2. 它**不支持 auto 识别源语言**，必须显式给 sourceLanguage，
   *    所以先用 chrome.i18n.detectLanguage（Chrome 自带 CLD）判一下。
   */

  // Chrome Translator API 支持的语种（官方列表，2026-10 核对）
  const LOCAL_LANGS = new Set([
    'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi',
    'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'mr', 'nl', 'no', 'pl', 'pt',
    'ro', 'ru', 'sk', 'sl', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'vi', 'zh'
  ]);

  /** 插件语言 key → Translator API 的写法（它只认 zh / zh-Hant，没有 zh-CN） */
  function localLang(key) {
    const k = String(key || '').trim();
    if (k === 'zh' || k === 'zh-CN' || k === 'zh-Hans') return 'zh';
    if (k === 'zh-TW' || k === 'zh-Hant') return 'zh-Hant';
    return k;
  }

  /** 判断源语言：Chrome 自带的 CLD，失败时退回「有没有汉字」这个土办法 */
  async function detectSourceLang(text) {
    try {
      const r = await chrome.i18n.detectLanguage(text);
      const top = r && r.languages && r.languages[0];
      if (top && top.language) return String(top.language).split('-')[0];
    } catch (_) {
      /* ignore */
    }
    return /[\u3400-\u9fff\uf900-\ufaff]/.test(text) ? 'zh' : 'en';
  }

  let localTr = null;
  let localTrKey = '';
  const localDownloading = new Set();

  /**
   * 在后台「踢一脚」把模型下载起来。
   *
   * 为什么不 await：下载要好几十秒，绝不能卡住用户这一次翻译。
   * 为什么不放在设置页统一做：内容脚本里的三连空格是**唯一稳定可用的用户手势**，
   * 而 `Translator.create()` 在模型没下好时强制要求手势。
   * 两边都留着 —— 设置页能下就设置页下（有进度条），
   * 设置页下不了（拿不到 API）时这里兜底，下一次触发就能用上。
   */
  function startLocalDownload(from, to) {
    const key = from + '|' + to;
    if (localDownloading.has(key)) return;
    localDownloading.add(key);
    try {
      Translator.create({ sourceLanguage: from, targetLanguage: to })
        .then((t) => {
          localTr = t;
          localTrKey = key;
          console.info('[顺手翻译] 离线翻译模型已就绪：' + key + '（下次触发即可用）');
        })
        .catch((e) => {
          localDownloading.delete(key);
          console.info(
            '[顺手翻译] 离线模型未能开始下载：' + ((e && e.message) || e) + '（不影响翻译，会自动走下一层）'
          );
        });
    } catch (_) {
      localDownloading.delete(key);
    }
  }

  /**
   * 离线引擎翻译。任何一步不满足就返回 ok:false，由上层接着走谷歌 / AI 服务商。
   * 这里刻意不抛错 —— 免费引擎永远只是「加速层」，不能成为失败点。
   */
  async function localTranslate(text) {
    if (typeof Translator === 'undefined') return { ok: false, code: 'no_local' };

    const to = localLang(settings.targetLang);
    if (!LOCAL_LANGS.has(to)) return { ok: false, code: 'no_local' };

    const from = await detectSourceLang(text);
    if (!from || from === to || !LOCAL_LANGS.has(from)) return { ok: false, code: 'no_local' };

    let avail;
    try {
      avail = await Translator.availability({ sourceLanguage: from, targetLanguage: to });
    } catch (_) {
      return { ok: false, code: 'no_local' };
    }

    if (avail !== 'available') {
      // 还没下好。顺手让它开始下载，但**绝不等它**，这一次照常走谷歌通道。
      if (avail === 'downloadable') startLocalDownload(from, to);
      return { ok: false, code: 'local_not_ready' };
    }

    const key = from + '|' + to;

    try {
      if (!localTr || localTrKey !== key) {
        localTr = await Translator.create({ sourceLanguage: from, targetLanguage: to });
        localTrKey = key;
      }
      const t0 = performance.now();
      const out = await localTr.translate(text);
      if (!out) return { ok: false, code: 'empty' };
      return {
        ok: true,
        text: out,
        ms: Math.round(performance.now() - t0),
        providerName: '离线引擎',
        free: true
      };
    } catch (_) {
      // 实例可能已失效（页面切走、模型被回收），清掉下次重建
      localTr = null;
      localTrKey = '';
      return { ok: false, code: 'local_failed' };
    }
  }

  /* ------------------------------- 启动 ------------------------------- */

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('blur', resetCounter, true);
  window.addEventListener('blur', resetCounter, true);

  // 供弹出面板做「当前页面是否可用」诊断
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'ping') return false;
      sendResponse({
        ok: true,
        active: active,
        enabled: !!settings.enabled,
        hasKey: hasUsableProvider(),
        blacklisted: isBlacklisted(),
        triggerCount: settings.triggerCount,
        targetLang: settings.targetLang,
        host: location.hostname
      });
      return true;
    });
  } catch (_) {
    /* ignore */
  }

  loadSettings().then(() => {
    if (active) {
      console.info(
        '[顺手翻译] 已就绪 · 连敲 ' +
          settings.triggerCount +
          ' 次空格触发 · 目标语言 ' +
          langLabel(settings.targetLang)
      );
    } else {
      console.info(
        '[顺手翻译] 当前页面已停用 · ' +
          (!settings.enabled ? '插件被关闭' : '命中黑名单 ' + location.hostname)
      );
    }
  });
})();
