/**
 * 本地翻译缓存。
 *
 * 翻过的句子存起来，下次命中直接返回 —— 零 API 消耗、瞬间出结果。
 * 对「经常复用固定句式」的场景收益很大（比如公众号文案）。
 */

const CACHE_KEY = 'translationCache';
const MAX_ENTRIES = 800;
const MAX_SOURCE_LEN = 1200; // 太长的内容不缓存，避免占空间
const FLUSH_DELAY = 800;

/** 内存镜像，避免每次都读 storage */
let memory = null;
let flushTimer = 0;

function hashKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function makeKey(source, targetLang, tone) {
  return hashKey(`${targetLang}|${tone}|${source}`);
}

async function load() {
  if (memory) return memory;
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    memory = stored[CACHE_KEY] || {};
  } catch (_) {
    memory = {};
  }
  return memory;
}

/** 攒一小会儿再写盘，避免连续翻译时频繁落盘 */
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = 0;
    try {
      await chrome.storage.local.set({ [CACHE_KEY]: memory });
    } catch (_) {
      /* 写失败不影响翻译 */
    }
  }, FLUSH_DELAY);
}

function prune(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_ENTRIES) return;
  // 按最后访问时间淘汰最旧的
  keys.sort((a, b) => (cache[a][2] || 0) - (cache[b][2] || 0));
  const overflow = keys.length - MAX_ENTRIES;
  for (let i = 0; i < overflow; i += 1) delete cache[keys[i]];
}

/**
 * @returns {Promise<string|null>} 命中返回译文，否则 null
 */
export async function getCached(source, targetLang, tone) {
  if (!source || source.length > MAX_SOURCE_LEN) return null;

  const cache = await load();
  const hit = cache[makeKey(source, targetLang, tone)];
  if (!hit) return null;

  // 校验原文，避免哈希碰撞返回错误结果
  if (hit[0] !== source) return null;

  hit[2] = Date.now();
  hit[3] = (hit[3] || 0) + 1;
  scheduleFlush();

  return hit[1];
}

export async function setCached(source, targetLang, tone, translation) {
  if (!source || !translation) return;
  if (source.length > MAX_SOURCE_LEN) return;

  const cache = await load();
  const key = makeKey(source, targetLang, tone);
  const existing = cache[key];

  cache[key] = [source, translation, Date.now(), existing ? existing[3] || 0 : 0];

  prune(cache);
  scheduleFlush();
}

export async function clearCache() {
  memory = {};
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: {} });
  } catch (_) {
    /* ignore */
  }
}

export async function cacheStats() {
  const cache = await load();
  const keys = Object.keys(cache);
  let hits = 0;
  let bytes = 0;

  for (const key of keys) {
    const entry = cache[key];
    hits += entry[3] || 0;
    bytes += (entry[0] || '').length + (entry[1] || '').length;
  }

  return { entries: keys.length, hits, approxBytes: bytes * 2 };
}
