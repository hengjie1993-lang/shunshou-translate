/**
 * 多服务商管理：预设 + 故障转移。
 *
 * 核心思路：免费 API 没有「永远不拥堵」的，但可以准备多家，
 * 一家限流/超时就自动切下一家。日常使用基本不可能全部挂掉。
 */

import { translate, RETRY } from './translator.js';

/**
 * 内置预设。endpoint / model 都可以在设置页改。
 *
 * 收录标准（2026-10-14 收紧）：**必须在这台机器上用真实 Key 跑通翻译，才留在列表里。**
 * 之前挂着 5 家，实测下来 OpenRouter 的免费档连续 3 次 429、Gemini / Cerebras 从未被使用过，
 * 列表越长越像「看起来很多、实际用不了」。现在只留验证过能用的三家。
 * 需要别家的，用「自定义服务」填 endpoint / model / key 即可 —— 那条路一直开着。
 */
export const PROVIDER_PRESETS = [
  {
    preset: 'groq',
    name: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    // 2026-08-16 Groq 下线了 llama-3.3-70b-versatile / llama-3.1-8b-instant，官方推荐换成 gpt-oss
    model: 'openai/gpt-oss-120b',
    signup: 'https://console.groq.com/keys',
    // 2026-10-14 实测：10/10 成功，均值 734ms —— 目前最快最稳的一家
    note: '每天 14,400 次免费，实测最快'
  },
  {
    preset: 'zhipu',
    name: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    // 2026-10-14 实测：glm-4.7-flash 5 次里 4 次 429（高峰期拥堵）；
    // glm-4-flash 5/5 成功、均值 1.1s，所以默认用它。glm-4.6 / air / flashx 均提示「余额不足」。
    model: 'glm-4-flash',
    signup: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    note: '永久免费，国内直连'
  },
  {
    preset: 'agnes',
    name: 'Agnes AI',
    endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions',
    // 2026-10-14 实测：旧名 agnes-2.0-flash 已下线（503），agnes-2.5-flash 3/3 成功、均值 2.1s
    model: 'agnes-2.5-flash',
    signup: 'https://agnes-ai.com/',
    note: '永久免费，高峰期较慢'
  },
  {
    preset: 'custom',
    name: '自定义服务',
    endpoint: '',
    model: '',
    signup: '',
    note: '任何兼容 OpenAI 协议的服务'
  }
];

export function findPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.preset === id) || null;
}

let idSeed = 0;
export function newProviderId() {
  idSeed += 1;
  return 'p' + Date.now().toString(36) + idSeed.toString(36);
}

export function makeProvider(presetId, overrides) {
  const preset = findPreset(presetId) || findPreset('custom');
  return {
    id: newProviderId(),
    name: preset.name,
    endpoint: preset.endpoint,
    model: preset.model,
    apiKey: '',
    enabled: true,
    ...(overrides || {})
  };
}

/** 过滤出真正可用的服务商（首尾空格不算数 —— 只粘了空格的 Key 等于没填） */
export function usableProviders(providers) {
  return (providers || []).filter(
    (p) =>
      p &&
      p.enabled !== false &&
      String(p.apiKey || '').trim() &&
      String(p.endpoint || '').trim() &&
      String(p.model || '').trim()
  );
}

/** 出错时不该再试的（配置错了，重试也没用） */
const FATAL_CODES = new Set(['auth', 'notfound', 'model_retired']);

/** 测速用的短句：短文本下耗时基本等于网络往返 + 首字延迟，正是我们要比较的 */
const BENCH_TEXT = '你好，世界。今天天气很好。';

/**
 * 依次尝试各个服务商，第一个成功的就返回。
 *
 * 传入的 providers 应当已经排好序（见 lib/stats.js 的 orderBySpeed）。
 * 返回值里的 attempts 记录了每一家的实际表现，供上层写入速度统计。
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {Array}  opts.providers    已按优先级排序
 * @param {string} [opts.targetLang]
 * @param {string} [opts.tone]
 * @param {number} [opts.deadlineMs] 整体预算，默认 45 秒
 * @param {AbortSignal} [opts.signal]
 */
export async function translateWithFailover(opts) {
  const {
    text,
    providers,
    targetLang = 'en',
    tone = 'natural',
    deadlineMs = 45000,
    signal
  } = opts || {};

  const usable = usableProviders(providers);

  if (!usable.length) {
    return {
      ok: false,
      code: 'no_provider',
      error: '还没有可用的翻译服务，请到设置页添加并填写 API Key',
      attempts: []
    };
  }

  const multi = usable.length > 1;
  // 有多家备选时，单家少重试、快切换；只有一家时才耐心重试
  const perRetries = multi ? 1 : RETRY.maxRetries;
  const perTimeout = multi ? 15000 : RETRY.requestTimeoutMs;
  const deadlineAt = Date.now() + deadlineMs;

  const failures = [];
  const attempts = [];

  for (let i = 0; i < usable.length; i += 1) {
    const p = usable[i];

    if (Date.now() > deadlineAt) break;

    const r = await translate({
      text,
      apiKey: p.apiKey,
      endpoint: p.endpoint,
      model: p.model,
      targetLang,
      tone,
      maxRetries: perRetries,
      timeoutMs: perTimeout,
      deadlineAt,
      signal
    });

    attempts.push({
      id: p.id,
      name: p.name || p.id,
      ok: !!r.ok,
      code: r.code || '',
      ms: r.ms || 0,
      retries: r.retries || 0
    });

    if (r.ok) {
      return {
        ...r,
        providerName: p.name || p.id,
        providerId: p.id,
        providerIndex: i,
        triedCount: i + 1,
        failedBefore: failures.length,
        attempts
      };
    }

    if (r.code === 'cancelled') return { ...r, attempts };

    failures.push({ id: p.id, name: p.name || p.id, code: r.code, message: r.error });

    if (FATAL_CODES.has(r.code) && usable.length > 1) continue;
  }

  if (!failures.length) {
    return {
      ok: false,
      code: 'timeout',
      error: '所有翻译服务都超时了，请稍后重试',
      attempts
    };
  }

  const last = failures[failures.length - 1];

  // 全是「模型已下线」这类配置问题：不是网络繁忙，重试一万次也没用，
  // 直接告诉用户去换模型，别让他对着「服务繁忙」干等。
  const allModelGone = failures.length > 0 && failures.every((f) => f.code === 'model_retired');
  if (allModelGone) {
    // 只有一家时保留带模型名的详细信息（便于排查），多家时给一句统一的指引
    const error =
      failures.length === 1
        ? failures[0].message
        : `${failures.map((f) => f.name).join('、')} 的模型都已下线，请到设置页更换模型`;
    return { ok: false, code: 'all_failed', error, failures, attempts };
  }

  return {
    ok: false,
    code: 'all_failed',
    error:
      usable.length > 1
        ? `${failures.length} 家服务都失败了 · ${last.message}`
        : last.message,
    failures,
    attempts
  };
}

/* ---------------------------------- 测速 ---------------------------------- */

/**
 * 并发探测所有可用服务商，测出各自的真实响应耗时。
 *
 * 并发（而不是串行）是为了让所有服务商处在同一网络条件下，
 * 测出来的数字才可比；总耗时约等于最慢的那一家。
 *
 * @param {Array} providers
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Array<{id,name,ok,ms,code,error}>>}
 */
export async function benchmarkProviders(providers, opts) {
  const { timeoutMs = 15000 } = opts || {};
  const usable = usableProviders(providers);

  return Promise.all(
    usable.map(async (p) => {
      const r = await translate({
        text: BENCH_TEXT,
        apiKey: p.apiKey,
        endpoint: p.endpoint,
        model: p.model,
        targetLang: 'en',
        tone: 'natural',
        maxRetries: 0,
        timeoutMs
      });

      return {
        id: p.id,
        name: p.name || p.id,
        ok: !!r.ok,
        ms: r.ms || 0,
        code: r.code || '',
        error: r.error || ''
      };
    })
  );
}

