/**
 * 服务商性能统计：实测每个翻译接口的真实响应速度，自动把最快的排到最前。
 *
 * 设计要点
 * - 用 EMA（指数移动平均）平滑延迟，避免单次抖动导致顺序乱跳
 * - 样本少时向「中性值」收缩，避免一次侥幸就长期霸占第一位
 * - 连续失败加权惩罚，限流/超时后进入冷却期，冷却中的排到最后
 * - 冷却只是「降级」而不是「跳过」—— 万一别的都不行，仍然会兜底尝试
 *
 * 两条铁律：
 * 1. 速度数据由**真实使用**驱动 —— 每次翻译都会记录耗时，越用越准。
 * 2. 后台**自动探测**只负责「给还没测出速度的服务商补一个样本」，
 *    它只加分不扣分：探测失败绝不降权（可能只是用户的 Key 还没填完）。
 *
 * 统计只存本机（chrome.storage.local），不上传任何服务器。
 */

const STATS_KEY = 'providerStats';

/** 没有任何实测数据时的中性延迟（毫秒）。冷启动时按它排序，因此用户配置顺序仍然决定先后 */
export const COLD_MS = 2200;

/** EMA 系数：越大越贴近最近一次结果，越小越平滑 */
const ALPHA = 0.35;

/** 样本数达到这个值后，实测延迟才完全采信（之前会向 COLD_MS 收缩） */
const CONFIDENT_SAMPLES = 4;

/** 连续失败惩罚：每次 +1200ms，最多累计 3 次 */
const FAIL_PENALTY_MS = 1200;
const FAIL_PENALTY_CAP = 3;

/** 自动探测失败后，隔多久再补测一次（避免配置还没填完就被反复探测） */
export const PROBE_RETRY_MS = 10 * 60 * 1000;

/** 各类错误对应的冷却时长（毫秒） */
const COOLDOWN_MS = {
  rate_limit: 45000,
  timeout: 20000,
  server: 20000,
  http: 20000,
  network: 15000,
  parse: 10000,
  empty: 10000,
  auth: 300000,
  notfound: 300000,
  // 模型下线属于配置问题：换模型之前一直不该被优先使用，给足冷却
  model_retired: 300000,
  unknown: 10000
};

const FLUSH_DELAY = 300;

let memory = null;
let flushTimer = 0;

function emptyStat() {
  return {
    emaMs: null,
    samples: 0,
    fails: 0,
    failStreak: 0,
    cooldownUntil: 0,
    lastOkAt: 0,
    lastCode: '',
    probedAt: 0,
    probeCode: '',
    updatedAt: 0
  };
}

async function load() {
  if (memory) return memory;
  try {
    const stored = await chrome.storage.local.get(STATS_KEY);
    memory = stored[STATS_KEY] || {};
  } catch (_) {
    memory = {};
  }
  return memory;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = 0;
    writeNow();
  }, FLUSH_DELAY);
}

async function writeNow() {
  if (!memory) return;
  try {
    await chrome.storage.local.set({ [STATS_KEY]: memory });
  } catch (_) {
    /* 写失败不影响翻译 */
  }
}

/** 立即落盘。后台在一次翻译结束后调用，避免 Service Worker 被回收导致数据丢失。 */
export async function flushStats() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
  await writeNow();
}

/* ---------------------------------- 读取 ---------------------------------- */

/** @returns {Promise<object>} 以服务商 id 为键的统计表 */
export async function loadStats() {
  const stats = await load();
  return { ...stats };
}

/**
 * 这家服务商是否需要做一次自动测速。
 * 只有「还没测出过速度」的才需要 —— 已经有样本的靠真实使用持续更新，不再浪费额度。
 */
export function needsProbe(stat, now) {
  const t = now || Date.now();
  if (!stat) return true;
  if (stat.samples > 0) return false;
  if (!stat.probedAt) return true;
  return t - stat.probedAt > PROBE_RETRY_MS;
}

/* ---------------------------------- 写入 ---------------------------------- */

/**
 * 记录一次成功：更新 EMA 延迟，清空失败惩罚与冷却。
 * @param {string} id
 * @param {number} ms 实测耗时
 */
export async function recordSuccess(id, ms) {
  if (!id || !Number.isFinite(ms) || ms <= 0) return null;

  const stats = await load();
  const s = { ...emptyStat(), ...(stats[id] || {}) };

  s.emaMs =
    s.samples > 0 && s.emaMs != null
      ? Math.round(ALPHA * ms + (1 - ALPHA) * s.emaMs)
      : Math.round(ms);

  s.samples += 1;
  s.failStreak = 0;
  s.cooldownUntil = 0;
  s.lastCode = '';
  s.lastOkAt = Date.now();
  s.probedAt = Date.now();
  s.probeCode = '';
  s.updatedAt = Date.now();
  stats[id] = s;
  scheduleFlush();
  return s;
}

/**
 * 记录一次失败：累加连续失败，并按错误类型设置冷却期。
 * @param {string} id
 * @param {string} code 错误码（rate_limit / timeout / auth ...）
 */
export async function recordFailure(id, code) {
  if (!id) return null;
  // 用户主动取消不算服务商的锅
  if (code === 'cancelled') return null;

  const stats = await load();
  const s = { ...emptyStat(), ...(stats[id] || {}) };

  s.fails += 1;
  s.failStreak += 1;
  s.lastCode = code || 'unknown';

  const cooldown = COOLDOWN_MS[code] !== undefined ? COOLDOWN_MS[code] : COOLDOWN_MS.unknown;
  s.cooldownUntil = Date.now() + cooldown;
  s.updatedAt = Date.now();
  stats[id] = s;
  scheduleFlush();
  return s;
}

/**
 * 记录一次「后台自动探测失败」。
 *
 * 刻意**不动** failStreak / cooldownUntil / fails —— 自动探测只负责补成功样本，
 * 绝不因为一次后台探测失败就把某家降权：那很可能只是用户 Key 还没粘贴完。
 */
export async function markProbeFailure(id, code) {
  if (!id) return null;

  const stats = await load();
  const s = { ...emptyStat(), ...(stats[id] || {}) };

  s.probedAt = Date.now();
  s.probeCode = code || 'unknown';
  stats[id] = s;
  scheduleFlush();
  return s;
}

/** 清空统计。不传 ids 就全部清空。 */
export async function resetStats(ids) {
  const stats = await load();

  if (!Array.isArray(ids) || !ids.length) {
    memory = {};
  } else {
    for (const id of ids) delete stats[id];
  }

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
  await writeNow();
}

/* ---------------------------------- 排序 ---------------------------------- */

/**
 * 计算某个服务商的「排序分」，越小越优先。
 * @returns {{score:number, cooling:boolean, base:number, known:boolean}}
 */
export function scoreOf(stat, now) {
  const s = stat || null;
  const t = now || Date.now();

  const hasData = !!(s && s.samples > 0 && s.emaMs != null);
  let base = COLD_MS;

  if (hasData) {
    // 样本少时向中性值收缩，避免「一次侥幸」就长期排第一
    const confidence = Math.min(s.samples / CONFIDENT_SAMPLES, 1);
    base = COLD_MS + (s.emaMs - COLD_MS) * confidence;
  }

  const streak = s ? Math.min(s.failStreak || 0, FAIL_PENALTY_CAP) : 0;
  const cooling = !!(s && s.cooldownUntil > t);

  let score = base + streak * FAIL_PENALTY_MS;
  // 冷却中的排到最后（但不剔除，别的都不行时仍会兜底尝试）
  if (cooling) score += 1e7;

  return { score, cooling, base: Math.round(base), known: hasData };
}

/**
 * 按实测速度排序：最快的排最前。
 * 同分时保持用户配置顺序（所以 ↑↓ 仍然是有意义的「平手时的偏好」）。
 */
export function orderBySpeed(providers, stats, now) {
  const list = Array.isArray(providers) ? providers.slice() : [];
  const t = now || Date.now();

  return list
    .map((p, index) => {
      const info = scoreOf(stats && p && p.id ? stats[p.id] : null, t);
      return { p, index, score: info.score };
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.p);
}

/**
 * 生成给 UI 用的状态描述。
 * @returns {{text:string, tone:'ok'|'warn'|'cold'}}
 */
export function describeStat(stat, now) {
  const t = now || Date.now();

  // 模型下线属于配置问题，比「冷却中」更该被用户看见 —— 冷却会自己过期，这个不会
  if (stat && stat.lastCode === 'model_retired') {
    return { text: '模型已下线，需更换', tone: 'warn' };
  }

  if (stat && stat.cooldownUntil > t) {
    const secs = Math.ceil((stat.cooldownUntil - t) / 1000);
    return { text: `冷却中 ${secs}s`, tone: 'warn' };
  }

  if (!stat || !stat.samples || stat.emaMs == null) {
    if (stat && stat.failStreak) return { text: '上次失败', tone: 'warn' };
    return { text: '测速中…', tone: 'cold' };
  }

  return { text: `实测 ${(stat.emaMs / 1000).toFixed(1)}s`, tone: 'ok' };
}
