/**
 * Agnes AI 翻译客户端（OpenAI 兼容协议）
 *
 * 已知限制（2026-10 实测）：
 * - 免费额度有速率限制，实测高峰期即使间隔 12 秒也可能 429，且不返回 Retry-After 头
 * - 请求可能长时间挂起（实测见过 80+ 秒），必须自己加超时
 * - 响应可能带前导换行、包裹引号和 reasoning_content 字段，译文需要清洗
 *
 * 本模块只负责「调用一家服务商」。多服务商故障转移见 lib/providers.js。
 */

export const DEFAULTS = {
  endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions',
  // 2026-10 实测：agnes-2.0-flash 已从 Agnes 的 /v1/models 列表里消失，
  // 调用直接返回 503 model_not_found。现行免费文本模型是 agnes-2.5-flash。
  model: 'agnes-2.5-flash'
};

/** 目标语言：key -> 语言名 */
export const LANGUAGES = [
  { key: 'en', label: 'English', native: '英语' },
  { key: 'zh', label: '简体中文', native: '中文' },
  { key: 'zh-TW', label: '繁體中文', native: '繁体中文' },
  { key: 'ja', label: '日本語', native: '日语' },
  { key: 'ko', label: '한국어', native: '韩语' },
  { key: 'de', label: 'Deutsch', native: '德语' },
  { key: 'fr', label: 'Français', native: '法语' },
  { key: 'es', label: 'Español', native: '西班牙语' },
  { key: 'ru', label: 'Русский', native: '俄语' },
  { key: 'pt', label: 'Português', native: '葡萄牙语' },
  { key: 'it', label: 'Italiano', native: '意大利语' },
  { key: 'ar', label: 'العربية', native: '阿拉伯语' },
  { key: 'th', label: 'ไทย', native: '泰语' },
  { key: 'vi', label: 'Tiếng Việt', native: '越南语' }
];

/** 语气风格 */
export const TONES = {
  natural: '自然地道，符合目标语言母语者的日常表达习惯，不要逐字硬译',
  formal: '正式、书面、专业，适合商务邮件与公文',
  literal: '忠实直译，尽量贴近原文语序与用词'
};

/** 默认重试配置（单一服务商时使用） */
export const RETRY = {
  maxRetries: 3,
  baseDelayMs: 2000,
  requestTimeoutMs: 20000
};

export function langLabel(key) {
  const hit = LANGUAGES.find((l) => l.key === key);
  return hit ? hit.label : key || 'English';
}

/* --------------------------------- 错误分类 --------------------------------- */

const ERROR_TEXT = {
  auth: 'API Key 无效或已失效',
  notfound: '接口地址或模型名不对',
  model_retired: '模型已下线',
  rate_limit: '免费额度已限流',
  server: '服务端错误',
  timeout: '请求超时',
  network: '网络请求失败',
  parse: '接口返回的不是合法 JSON',
  empty: '接口没有返回译文内容',
  empty_input: '没有可翻译的内容',
  no_key: '没有填写 API Key',
  cancelled: '已取消',
  unknown: '未知错误'
};

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'http';
}

/**
 * 判断响应体是不是「这个模型已经没了」。
 *
 * 这是 2026 年最坑的一类故障：服务商悄悄下线模型，接口返回 400，
 * 错误信息里写着 model_decommissioned —— 看起来像普通参数错误，
 * 于是插件每翻译一次就白跑一趟。必须单独识别出来，好让上层
 * 直接跳过这家、并明确告诉用户「去换模型」。
 *
 * 状态码不只有 400/404/422：Agnes 的 LiteLLM 网关会把「模型不存在」
 * 包在 **503** 里返回（`{"code":"model_not_found","message":"No available
 * channel for model xxx under group default"}`），而且同一个模型有时回
 * 503、有时回 429，看起来特别像「限流，等会儿就好」。所以 503 也要认。
 */
function isModelGone(status, bodyText) {
  if (status !== 400 && status !== 404 && status !== 422 && status !== 503) return false;
  const t = String(bodyText || '');
  if (!t) return false;
  return /(model[_ -]?decommissioned|model[_ -]?not[_ -]?found|decommissioned|unknown model|invalid model|unsupported model|no available channel for model|model[^,;。]{0,20}(does not exist|not found|no longer|retired|deprecated|shut ?down)|no longer (supported|available)|has been (retired|deprecated|shut ?down)|模型[^,，。；]{0,16}(不存在|已下线|已停用|已弃用|不受支持|不支持))/i.test(
    t
  );
}

/** 从响应体里抠出服务端给的原因 —— 排查问题时这句话最有价值 */
function extractDetail(bodyText) {
  const raw = String(bodyText || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const e = parsed && parsed.error;
    const msg = (e && (e.message || e.msg)) || (parsed && parsed.message) || '';
    if (msg) return String(msg);
    if (e && e.code) return String(e.code);
    return '';
  } catch (_) {
    return raw.slice(0, 200);
  }
}

/**
 * 把可能混进错误文本里的密钥抹掉。
 *
 * 正规服务商不会回显 Key，但自建代理 / 中转网关有可能把请求头原样写进错误响应。
 * 这些错误文本会直接显示在界面上，用户还可能截图发到群里求助 —— 一旦带出 Key，
 * 就等于把别人的额度公开了。所以凡是来自服务端的文本，进界面前一律过一遍这里。
 *
 * @param {string} text  待清洗文本
 * @param {string} apiKey 本次请求用的 Key（可能为空）
 */
export function redactSecrets(text, apiKey) {
  let out = String(text == null ? '' : text);
  const key = String(apiKey || '').trim();

  // 1. 精确匹配本次用的 Key（含被网关截断显示的前缀）
  if (key.length >= 8) {
    out = out.split(key).join('[已隐藏]');
    if (key.length >= 16) out = out.split(key.slice(0, 8)).join('[已隐藏]');
  }

  // 2. 通用兜底：不管是不是本次的 Key，任何看起来像凭据的串都抹掉
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[已隐藏]');
  out = out.replace(/\b(gsk_|sk-|sk_live_|AIza)[A-Za-z0-9._\-]{12,}/g, '[已隐藏]');

  return out;
}

function describe(status, bodyText, model, apiKey) {
  // 模型下线优先判定：它比「400 参数错误」更具体，也更能指导用户修复
  if (isModelGone(status, bodyText)) {
    return {
      code: 'model_retired',
      message: `模型「${model || '未知'}」已不可用（服务商已下线或改名），请在设置页更换模型`
    };
  }

  const code = classifyStatus(status);

  // 服务端原话只在「能指导用户修配置」的时候带上。
  // 限流和 5xx 的响应体经常是一大段英文（Agnes 的 429 正文就有 150 个字符，
  // 还劝你升级付费套餐），原样塞进提示里会把一句话撑成一坨，用户反而更懵。
  // 真正需要看原话的是「Key 为什么无效」「模型为什么不对」——那才叫可操作信息。
  const wantDetail = code === 'auth' || code === 'notfound' || code === 'http';
  const detail = wantDetail ? redactSecrets(extractDetail(bodyText), apiKey) : '';
  const suffix = detail ? `：${detail.slice(0, 160)}` : '';

  let message;
  if (code === 'auth') {
    message = `${ERROR_TEXT.auth}（HTTP ${status}）${suffix}`;
  } else if (code === 'server') {
    message = `服务端错误（${status}）`;
  } else if (code === 'http') {
    message = `请求失败（${status}）${suffix}`;
  } else {
    message = `${ERROR_TEXT[code] || ERROR_TEXT.unknown}${suffix}`;
  }

  return { code, message };
}

/* --------------------------------- 清洗 --------------------------------- */

/**
 * 清洗模型返回的译文：去前导换行、去包裹引号、去「翻译：」前缀。
 */
export function cleanTranslation(raw) {
  let text = String(raw == null ? '' : raw).trim();

  const pairs = [
    ['"', '"'],
    ['“', '”'],
    ["'", "'"],
    ['「', '」'],
    ['『', '』']
  ];
  for (const [open, close] of pairs) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length).trim();
      // 仅在整体被包裹、且内部不再出现同名引号时才剥离
      if (inner && !inner.includes(open) && !inner.includes(close)) text = inner;
      break;
    }
  }

  text = text.replace(/^(翻译|译文|translation)\s*[:：]\s*/i, '').trim();
  return text;
}

/* --------------------------------- 提示词 --------------------------------- */

function buildSystemPrompt(targetLang, tone) {
  const toneRule = TONES[tone] || TONES.natural;
  return [
    `你是一个专业翻译引擎。把用户提供的文本翻译成${targetLang}。`,
    '',
    '严格遵守以下规则：',
    '1. 只输出译文本身。不要解释、不要加引号、不要加标题、不要用 markdown 代码块。',
    '2. 完整保留原文的换行与分段结构。',
    '3. 专有名词、人名、品牌、数字、代码、URL、emoji 原样保留。',
    `4. 如果原文已经是${targetLang}，原样返回，不要改动。`,
    `5. 语气风格：${toneRule}。`
  ].join('\n');
}

/* --------------------------------- 工具 --------------------------------- */

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    }
  });

/**
 * 为单次请求创建带超时的 signal。
 * 上游偶尔会长时间挂起（实测见过 80+ 秒不返回），必须自己兜住。
 */
function createAttemptSignal(outerSignal, timeoutMs) {
  const ctrl = new AbortController();
  const state = { timedOut: false, cancelled: false };

  const timer = setTimeout(() => {
    state.timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  const onOuterAbort = () => {
    state.cancelled = true;
    ctrl.abort();
  };

  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  return {
    signal: ctrl.signal,
    state,
    cleanup() {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  };
}

/* --------------------------------- 主流程 --------------------------------- */

/**
 * 调用单个服务商翻译文本，内置 429 / 5xx / 网络错误的重试。
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} opts.apiKey
 * @param {string} [opts.endpoint]
 * @param {string} [opts.model]
 * @param {string} [opts.targetLang]
 * @param {string} [opts.tone]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.deadlineAt]  绝对时间戳，超过就放弃（用于多服务商总预算）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, text?:string, error?:string, code?:string, ms?:number, retries?:number}>}
 */
export async function translate(opts) {
  const {
    text,
    targetLang = 'en',
    tone = 'natural',
    maxRetries = RETRY.maxRetries,
    timeoutMs = RETRY.requestTimeoutMs,
    deadlineAt = 0,
    signal
  } = opts || {};

  // 从设置页粘贴进来的东西经常带首尾空格 / 换行：
  // Key 尾部多个 \n → 请求头变成 `Bearer sk-xxx\n` → 服务端一律回 401；
  // 模型名尾部多个空格 → 服务端回「模型不存在」。
  // 这两种「看起来配对了其实没配对」最难查，所以在这里统一清干净。
  const apiKey = String(opts && opts.apiKey != null ? opts.apiKey : '').trim();
  const endpoint = String(
    (opts && opts.endpoint) || DEFAULTS.endpoint
  ).trim();
  const model = String((opts && opts.model) || DEFAULTS.model).trim();

  if (!apiKey) return { ok: false, code: 'no_key', error: ERROR_TEXT.no_key };
  if (!text || !String(text).trim()) {
    return { ok: false, code: 'empty_input', error: ERROR_TEXT.empty_input };
  }

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(langLabel(targetLang), tone) },
      { role: 'user', content: String(text) }
    ],
    temperature: 0.2,
    stream: false
  });

  const started = Date.now();
  let last = { code: 'unknown', message: ERROR_TEXT.unknown };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (deadlineAt && Date.now() > deadlineAt) {
      last = { code: 'timeout', message: '整体超时' };
      break;
    }

    if (attempt > 0) {
      try {
        await sleep(RETRY.baseDelayMs * Math.pow(2, attempt - 1), signal);
      } catch (_) {
        return { ok: false, code: 'cancelled', error: ERROR_TEXT.cancelled };
      }
    }

    const ctl = createAttemptSignal(signal, timeoutMs);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body,
        signal: ctl.signal
      });
    } catch (err) {
      if (ctl.state.cancelled) {
        ctl.cleanup();
        return { ok: false, code: 'cancelled', error: ERROR_TEXT.cancelled };
      }
      last = ctl.state.timedOut
        ? { code: 'timeout', message: ERROR_TEXT.timeout }
        : { code: 'network', message: ERROR_TEXT.network };
      ctl.cleanup();
      continue;
    } finally {
      ctl.cleanup();
    }

    // 限流 / 服务端错误 → 可重试。
    // 但 5xx 里可能藏着「模型已下线」（Agnes 的 503 model_not_found），
    // 那种情况重试多少次都是白等，所以先偷看一眼响应体，是配置错就立刻返回。
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      let peek = '';
      try {
        peek = await res.text();
      } catch (_) {
        /* ignore */
      }
      if (isModelGone(res.status, peek)) {
        const d = describe(res.status, peek, model, apiKey);
        return { ok: false, code: d.code, error: d.message, ms: Date.now() - started };
      }
      const d = describe(res.status, '', model, apiKey);
      last = { code: d.code, message: d.message };
      continue;
    }

    if (!res.ok) {
      let errBody = '';
      try {
        errBody = await res.text();
      } catch (_) {
        /* ignore */
      }
      const d = describe(res.status, errBody, model, apiKey);
      return { ok: false, code: d.code, error: d.message, ms: Date.now() - started };
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      last = { code: 'parse', message: ERROR_TEXT.parse };
      continue;
    }

    const choice = data && data.choices && data.choices[0];
    const raw = choice && choice.message && choice.message.content;
    if (!raw) {
      last = { code: 'empty', message: ERROR_TEXT.empty };
      continue;
    }

    const out = cleanTranslation(raw);
    if (!out) {
      last = { code: 'empty', message: ERROR_TEXT.empty };
      continue;
    }

    return { ok: true, text: out, ms: Date.now() - started, retries: attempt };
  }

  return { ok: false, code: last.code, error: last.message, ms: Date.now() - started };
}
