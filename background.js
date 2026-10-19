/**
 * 后台 Service Worker
 * 职责：读取配置、查缓存、按实测速度排序服务商、故障转移调用翻译接口，
 *      并在后台自动补测还没测出速度的服务商（用户无需任何手动操作）。
 * API Key 只在这里使用，不会进入网页环境（内容脚本读不到）。
 */

import { translate } from './lib/translator.js';
import {
  translateWithFailover,
  usableProviders,
  benchmarkProviders
} from './lib/providers.js';
import { loadSettings, ensureDefaults } from './lib/settings.js';
import { googleTranslate, googleLang } from './lib/freeEngines.js';
import { getCached, setCached, clearCache, cacheStats } from './lib/cache.js';
import {
  loadStats,
  recordSuccess,
  recordFailure,
  markProbeFailure,
  needsProbe,
  orderBySpeed,
  resetStats,
  flushStats
} from './lib/stats.js';

/** 服务商配置指纹：endpoint / model / Key 变了就把该家的速度数据作废，重新学 */
const FP_KEY = 'providerFingerprints';

/* ---------------------------------- 消息路由 ---------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'translate':
      handleTranslate(msg).then((res) => {
        sendResponse(res);
        // 响应已经发回页面了，再在后台补测冷启动的服务商，绝不拖慢用户
        autoWarmup('after-translate');
      });
      return true;

    case 'translateFree':
      handleFreeTranslate(msg).then(sendResponse);
      return true;

    case 'engineCheck':
      handleEngineCheck().then(sendResponse);
      return true;

    // 设置页用它来确认「正在跑的后台到底是哪个版本」。
    // 这是唯一能识破「改了代码但没在 chrome://extensions 点刷新」的手段：
    // 设置页的 JS 是直接从磁盘读的（所以看着是新的），但后台脚本被 Chrome 缓存了，
    // 刷新之前一直跑旧代码。旧代码不认识这条消息 → 页面收不到 version → 判定为旧。
    case 'swPing':
      sendResponse({
        ok: true,
        version: chrome.runtime.getManifest().version
      });
      return true;

    case 'testProvider':
      handleTestProvider(msg).then(sendResponse);
      return true;

    case 'providerStats':
      loadStats().then((stats) => sendResponse({ ok: true, stats }));
      return true;

    case 'resetProviderStats':
      resetStats(msg.ids)
        .then(() => autoWarmup('after-reset'))
        .then(() => sendResponse({ ok: true }));
      return true;

    case 'cacheStats':
      cacheStats().then(sendResponse);
      return true;

    case 'clearCache':
      clearCache().then(() => sendResponse({ ok: true }));
      return true;

    case 'openOptions':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return true;

    default:
      return false;
  }
});

/* ------------------------- 免费通道（Google 内部接口） ------------------------- */

/**
 * 免费通道翻译。
 *
 * 为什么放在后台而不是内容脚本里直接 fetch：
 * MV3 的内容脚本和普通网页一样受 CORS 限制，直接请求 translate.googleapis.com
 * 会被浏览器拦掉；只有带 host_permissions 的 Service Worker 能跨域。
 *
 * 走的是和 AI 服务商同一套本地缓存，所以同一句话不会重复请求。
 */
async function handleFreeTranslate(msg) {
  const settings = await loadSettings();

  if (!settings.enabled) return { ok: false, code: 'disabled', error: '插件已停用' };
  if ((settings.engines || {}).google === false) {
    return { ok: false, code: 'engine_off', error: '免费通道已关闭' };
  }

  const text = String(msg.text || '');
  if (!text.trim()) return { ok: false, code: 'empty_input', error: '没有可翻译的内容' };

  const cacheKey = text.trim();

  if (settings.cacheEnabled) {
    const hit = await getCached(cacheKey, settings.targetLang, settings.tone);
    if (hit) return { ok: true, text: hit, cached: true, ms: 0, providerName: '本地缓存' };
  }

  const r = await googleTranslate(text, { to: googleLang(settings.targetLang) });

  if (r.ok && settings.cacheEnabled) {
    await setCached(cacheKey, settings.targetLang, settings.tone, r.text);
  }

  return r;
}

/** 设置页用：实测一下免费通道现在通不通 */
async function handleEngineCheck() {
  const settings = await loadSettings();
  const to = googleLang(settings.targetLang);
  const r = await googleTranslate('Hello, this is a connection test.', { to });
  return {
    ok: !!r.ok,
    google: { ok: !!r.ok, ms: r.ms || 0, text: r.text || '', error: r.error || '' }
  };
}

/* ---------------------------------- 翻译 ---------------------------------- */

async function handleTranslate(msg) {
  const settings = await loadSettings();

  if (!settings.enabled) return { ok: false, code: 'disabled', error: '插件已停用' };

  const text = String(msg.text || '');
  if (!text.trim()) return { ok: false, code: 'empty_input', error: '没有可翻译的内容' };
  if (text.length > settings.maxChars) {
    return {
      ok: false,
      code: 'too_long',
      error: `内容太长（${text.length} 字），超过 ${settings.maxChars} 字上限`
    };
  }

  const cacheKey = text.trim();

  // 1) 先查本地缓存
  if (settings.cacheEnabled) {
    const hit = await getCached(cacheKey, settings.targetLang, settings.tone);
    if (hit) {
      return { ok: true, text: hit, cached: true, ms: 0, providerName: '本地缓存' };
    }
  }

  // 2) 智能排序：永远把实测最快的服务商排到最前（用户不需要选择）
  const stats = await loadStats();
  const ordered = orderBySpeed(settings.providers, stats);

  // 3) 依次尝试，失败自动切下一家
  const result = await translateWithFailover({
    text,
    providers: ordered,
    targetLang: settings.targetLang,
    tone: settings.tone,
    deadlineMs: settings.deadlineMs
  });

  // 4) 记录每一家的实际表现，供下次排序使用
  await applyAttempts(result.attempts);
  await flushStats();

  // 5) 成功就写入缓存
  if (result.ok && settings.cacheEnabled) {
    await setCached(cacheKey, settings.targetLang, settings.tone, result.text);
  }

  return result;
}

/** 把一次翻译里各家服务商的表现写进速度统计 */
async function applyAttempts(attempts) {
  for (const a of attempts || []) {
    if (!a || !a.id) continue;
    if (a.ok) await recordSuccess(a.id, a.ms);
    else await recordFailure(a.id, a.code);
  }
}

/* ---------------------------------- 自动测速（无需用户操作） ---------------------------------- */

let warming = false;

/**
 * 自动给「还没测出速度」的服务商补一次后台探测。
 *
 * 触发时机（全自动，用户无感）：
 * - 安装 / 升级插件
 * - 浏览器启动
 * - 服务商配置变化（用户粘贴完 Key、加了新服务商）—— 防抖 8 秒，等他填完
 * - 每次翻译结束后（只针对还没数据的，所以不会反复消耗额度）
 *
 * 关键约束：
 * - **只探测没有成功样本的**，已经有数据的靠真实使用持续更新
 * - **探测失败不降权**（走 markProbeFailure），避免半截 Key 把某家误判成坏的
 * - 不阻塞任何用户可见流程
 */
async function autoWarmup(reason) {
  if (warming) return { ok: false, code: 'busy' };

  let settings;
  try {
    settings = await loadSettings();
  } catch (_) {
    return { ok: false, code: 'no_settings' };
  }

  if (!settings.enabled) return { ok: false, code: 'disabled' };

  const usable = usableProviders(settings.providers);
  if (!usable.length) return { ok: false, code: 'no_provider' };

  const stats = await loadStats();
  const now = Date.now();
  const targets = usable.filter((p) => needsProbe(stats[p.id], now));

  if (!targets.length) return { ok: true, probed: 0 };

  warming = true;
  try {
    const results = await benchmarkProviders(targets);
    for (const r of results) {
      if (r.ok) await recordSuccess(r.id, r.ms);
      else await markProbeFailure(r.id, r.code);
    }
    await flushStats();
    return { ok: true, probed: results.length, reason };
  } catch (_) {
    return { ok: false, code: 'failed' };
  } finally {
    warming = false;
  }
}

/* ---------------------------------- 单个服务商测试 ---------------------------------- */

async function handleTestProvider(msg) {
  const p = msg.provider || {};

  if (!p.apiKey) return { ok: false, code: 'no_key', error: '请先填写 API Key' };
  if (!p.endpoint) return { ok: false, code: 'no_endpoint', error: '请填写接口地址' };
  if (!p.model) return { ok: false, code: 'no_model', error: '请填写模型名' };

  const r = await translate({
    text: '你好，这是一次连接测试。',
    apiKey: p.apiKey,
    endpoint: p.endpoint,
    model: p.model,
    targetLang: 'en',
    tone: 'natural',
    maxRetries: 1,
    timeoutMs: 20000
  });

  // 顺手把这次实测结果记进速度统计
  if (p.id) {
    if (r.ok) await recordSuccess(p.id, r.ms);
    else await markProbeFailure(p.id, r.code);
    await flushStats();
  }

  return r;
}

/* ------------------------------- 配置变化 → 作废过期的速度数据 ------------------------------- */

function hashOf(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function fingerprintOf(p) {
  return hashOf(`${p.endpoint || ''}|${p.model || ''}|${p.apiKey || ''}`);
}

/**
 * 用户改了接口地址 / 模型 / Key 之后，旧的测速结果就没意义了，
 * 直接把这一家的数据清掉，让自动测速重新学一遍。
 * @returns {Promise<string[]>} 被作废的服务商 id
 */
async function invalidateChangedProviders(providers) {
  let stored = {};
  try {
    stored = (await chrome.storage.local.get(FP_KEY))[FP_KEY] || {};
  } catch (_) {
    stored = {};
  }

  const next = {};
  const staleIds = [];

  for (const p of providers || []) {
    if (!p || !p.id) continue;
    const fp = fingerprintOf(p);
    next[p.id] = fp;
    if (stored[p.id] && stored[p.id] !== fp) staleIds.push(p.id);
  }

  try {
    await chrome.storage.local.set({ [FP_KEY]: next });
  } catch (_) {
    /* ignore */
  }

  if (staleIds.length) await resetStats(staleIds);
  return staleIds;
}

/* ---------------------------------- 安装引导 ---------------------------------- */

/**
 * 把内容脚本补注入到「已经打开」的标签页。
 * 声明式 content_scripts 只对安装之后新加载的页面生效；
 * 用户装完插件后如果不刷新页面，会以为插件「没反应」。
 * content.js 内部有重复注入守卫，所以这里可以放心调用。
 */
async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch (_) {
    return;
  }

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      const target = { tabId: tab.id, allFrames: true };
      try {
        await chrome.scripting.insertCSS({ target, files: ['content/content.css'] });
      } catch (_) {
        /* 忽略 */
      }
      try {
        await chrome.scripting.executeScript({ target, files: ['content/content.js'] });
      } catch (_) {
        /* chrome:// 、应用商店等页面无法注入，正常忽略 */
      }
    })
  );
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await ensureDefaults();

  await invalidateChangedProviders(settings.providers);

  // 首次安装且没有任何已填 Key 的服务商，直接打开设置页引导
  if (details.reason === 'install' && !usableProviders(settings.providers).length) {
    chrome.runtime.openOptionsPage();
  }

  injectIntoOpenTabs();
  autoWarmup('install');
});

// 浏览器每次启动也顺手检查一遍（只补没有数据的，通常什么都不做）
chrome.runtime.onStartup.addListener(() => {
  autoWarmup('startup');
});

/* --------- 配置变化：用户粘贴完 Key / 加了新服务商 → 自动测速 --------- */

let configTimer = 0;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.providers) return;

  const next = changes.providers.newValue || [];

  // 防抖 8 秒：用户还在一个字一个字粘贴 Key 的时候不要急着探测
  if (configTimer) clearTimeout(configTimer);
  configTimer = setTimeout(async () => {
    configTimer = 0;
    try {
      await invalidateChangedProviders(next);
      await autoWarmup('config-changed');
    } catch (_) {
      /* ignore */
    }
  }, 8000);
});

