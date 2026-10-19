/**
 * 配置的单一来源：默认值 + 读写封装 + 旧版配置迁移。
 */

/** 新装用户的默认服务商（未填 Key，引导用户去申请） */
export const DEFAULT_PROVIDER = {
  id: 'agnes',
  name: 'Agnes AI',
  endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions',
  model: 'agnes-2.5-flash',
  apiKey: '',
  enabled: true
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  providers: [{ ...DEFAULT_PROVIDER }],
  targetLang: 'en',
  tone: 'natural',
  triggerCount: 3,
  triggerWindow: 500,
  blacklist: ['mail.google.com', 'docs.google.com'],
  maxChars: 8000,
  cacheEnabled: true,
  deadlineMs: 45000,
  /**
   * 免费引擎：不消耗任何 AI 服务商额度，且比 LLM 快得多。
   * 顺序固定为「离线 → 谷歌 → AI 服务商」，这两个开关只是逐层启停。
   * - google：Google 内部翻译通道，零配置、实测约 0.5 秒，默认开
   * - local： Chrome 内置的离线翻译模型，实测约 0.02 秒，
   *          但每个语向要一次性下载几十 MB，所以默认关，由用户在设置页主动开启
   */
  engines: { google: true, local: false }
};

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

/**
 * 历史遗留的配置键，读取时清掉：
 * - apiKey / endpoint / model：v1.0 的单服务商平铺配置，已迁移进 providers
 * - smartOrder：v1.2 的智能排序开关，现在智能排序常开、不再需要用户选择
 */
const LEGACY_KEYS = ['apiKey', 'endpoint', 'model', 'smartOrder'];

/**
 * 「已下线模型 → 替代模型」对照表。
 *
 * 为什么必须做这个：服务商下线模型时**不会**通知你的插件。
 * 用户的配置里还留着老模型名，接口从此每次都返回 400，
 * 表现为「以前好好的，最近总是翻译失败」。光改预设没用 ——
 * 预设只影响新添加的服务商，用户已经存在 chrome.storage 里的配置得靠这里改写。
 *
 * 按**接口域名**限定作用域：只有确认是那家服务商时才改写，
 * 免得误伤用户自己接的兼容服务（同一个模型名在别家可能还活着）。
 *
 * 2026 年四起大范围下线：
 * - Groq     2026-08-16 下线 llama-3.3-70b-versatile / llama-3.1-8b-instant
 * - Google   2026-06-01 关停 gemini-2.0-flash 系列
 * - Cerebras 共享推理收敛为只提供 gpt-oss / qwen-3.8
 * - Agnes    2026-10    下掉 agnes-2.0-flash（/v1/models 已无此项，调用回 503）
 */
export const MODEL_MIGRATIONS = [
  // Groq
  { host: 'api.groq.com', from: 'llama-3.3-70b-versatile', to: 'openai/gpt-oss-120b' },
  { host: 'api.groq.com', from: 'llama-3.1-8b-instant', to: 'openai/gpt-oss-20b' },
  { host: 'api.groq.com', from: 'qwen/qwen3-32b', to: 'openai/gpt-oss-120b' },
  { host: 'api.groq.com', from: 'qwen/qwen3.6-27b', to: 'qwen/qwen3.8-27b' },
  { host: 'api.groq.com', from: 'meta-llama/llama-4-scout-17b-16e-instruct', to: 'openai/gpt-oss-120b' },
  // 智谱 GLM：2026-10-14 实测 glm-4.7-flash 高峰期 5 次里 4 次 429，
  // glm-4-flash 5/5 成功且更快（1.1s）—— 直接换成稳定的那个。
  { host: 'open.bigmodel.cn', from: 'glm-4.7-flash', to: 'glm-4-flash' },
  { host: 'open.bigmodel.cn', from: 'glm-4.5-flash', to: 'glm-4-flash' },
  // Agnes AI
  { host: 'apihub.agnes-ai.com', from: 'agnes-2.0-flash', to: 'agnes-2.5-flash' }
];

function hostOf(endpoint) {
  try {
    return new URL(String(endpoint || '')).host.toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * 把单个服务商配置里的「已下线模型」换成替代模型。找不到对应项就原样返回。
 * @returns {{provider:object, changed:boolean, from?:string, to?:string}}
 */
export function migrateProviderModel(p) {
  if (!p || !p.model) return { provider: p, changed: false };

  const host = hostOf(p.endpoint);
  if (!host) return { provider: p, changed: false };

  const hit = MODEL_MIGRATIONS.find((m) => m.from === p.model && host.endsWith(m.host));
  if (!hit) return { provider: p, changed: false };

  return { provider: { ...p, model: hit.to }, changed: true, from: hit.from, to: hit.to };
}

/** 批量迁移一组服务商 */
export function applyModelMigrations(providers) {
  return (providers || []).map((p) => migrateProviderModel(p).provider);
}

function looksLikeLegacy(stored) {
  return (
    !Array.isArray(stored.providers) ||
    stored.providers.length === 0
  ) && (stored.apiKey || stored.endpoint || stored.model);
}

/**
 * 把旧版配置（apiKey / endpoint / model 平铺在顶层）
 * 迁移成新版 providers 数组。
 */
function migrate(stored) {
  const out = { ...DEFAULT_SETTINGS, ...stored };

  if (looksLikeLegacy(stored)) {
    out.providers = [
      {
        id: 'agnes',
        name: 'Agnes AI',
        endpoint: stored.endpoint || DEFAULT_PROVIDER.endpoint,
        model: stored.model || DEFAULT_PROVIDER.model,
        apiKey: stored.apiKey || '',
        enabled: true
      }
    ];
  } else if (!Array.isArray(out.providers) || out.providers.length === 0) {
    out.providers = [{ ...DEFAULT_PROVIDER }];
  }

  for (const key of LEGACY_KEYS) delete out[key];

  // engines 是对象，展开默认值兜底 —— 老配置里没有这个键，
  // 或者只有一半（用户先开了谷歌、离线是后来才加的）都要能补齐。
  out.engines = { ...DEFAULT_SETTINGS.engines, ...(stored.engines || {}) };

  // 服务商下线模型是「静默故障」，必须每次读取都顺手修一遍。
  // 幂等：改完之后模型名已不在对照表里，下次不会再动。
  out.providers = applyModelMigrations(out.providers);

  return out;
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get([...SETTINGS_KEYS, ...LEGACY_KEYS]);
  return migrate(stored);
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

/**
 * 首次安装（或从旧版本升级）时补齐缺失的键，并完成配置迁移。
 */
export async function ensureDefaults() {
  const stored = await chrome.storage.local.get([...SETTINGS_KEYS, ...LEGACY_KEYS]);
  const migrated = migrate(stored);

  const patch = {};
  for (const key of SETTINGS_KEYS) {
    if (migrated[key] === undefined) patch[key] = DEFAULT_SETTINGS[key];
  }

  // providers 需要迁移时写回
  if (JSON.stringify(migrated.providers) !== JSON.stringify(stored.providers)) {
    patch.providers = migrated.providers;
  }

  if (Object.keys(patch).length) await chrome.storage.local.set(patch);

  const legacyPresent = LEGACY_KEYS.filter((k) => k in stored);
  if (legacyPresent.length) await chrome.storage.local.remove(legacyPresent);

  return migrated;
}
