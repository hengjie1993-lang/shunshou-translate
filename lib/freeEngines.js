/**
 * 免费即时翻译引擎：完全不吃 AI 服务商的额度。
 *
 * 为什么要单开一层：LLM 是「拿通用模型去做翻译」——
 * 首字延迟 1–5 秒、按 token 计费、免费档还有每天多少次的上限。
 * 专用翻译通道是「为翻译而生」，快一个数量级，而且大多不要钱。
 * 所以正确的顺序是：**先试免费通道，不行再动用 AI 服务商。**
 *
 * 目前只有一条通道：Google 的 translate_a 接口。
 *
 * ⚠️ 注意：这不是 Google 公开文档化的 API，而是 Chrome 浏览器
 * 自己「翻译选中文本」时用的内部接口。它不需要 Key、没有明确额度，
 * 但 Google 随时可能关掉它。所以它只作为「免费引擎」的一层，
 * 后面永远接着 AI 服务商故障转移兜底 —— 挂了也不会让你翻译不了。
 */

export const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * 用哪个 client 标识。这个参数决定了 Google 认不认你。
 *
 * 实测（2026-10，用户真实网络环境，同一个 IP 连续请求）：
 * - client=gtx     → 429，返回 Google 的「Sorry...」拦截页
 * - client=webapp  → 403
 * - client=dict-chrome-ex → 200，质量好，连续 10 次无限流
 *
 * dict-chrome-ex 是 Chrome 自身在用的标识，这也是它比另外两个宽松的原因。
 * 换 client 前请先实测，别凭印象改。
 */
export const GOOGLE_CLIENT = 'dict-chrome-ex';

/** 插件内部语言 key → Google 的写法（Google 用 zh-CN / zh-TW，不用 zh-Hans） */
const GOOGLE_LANG = {
  en: 'en',
  zh: 'zh-CN',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  ja: 'ja',
  ko: 'ko',
  de: 'de',
  fr: 'fr',
  es: 'es',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ar',
  th: 'th',
  vi: 'vi'
};

export function googleLang(key) {
  return GOOGLE_LANG[String(key || '').trim()] || 'en';
}

/**
 * 插件里的语言 key → Chrome 内置 Translator API 的写法。
 * 它只认 `zh` / `zh-Hant`，**没有 `zh-CN`**，传错了直接 unavailable。
 */
export function localLang(key) {
  const k = String(key || '').trim();
  if (k === 'zh' || k === 'zh-CN' || k === 'zh-Hans') return 'zh';
  if (k === 'zh-TW' || k === 'zh-Hant') return 'zh-Hant';
  return k;
}

/**
 * 给「设置页那条离线引擎状态」挑一个合法的源语言。
 *
 * 为什么要专门挑：`Translator.availability()` 对**同语种**（en→en、zh→zh）一律返回
 * `unavailable` —— 这不是「环境不支持」，而是「这对语向没意义」。
 * 之前设置页写死 `sourceLanguage: 'en'`，用户目标语言是英文时就变成 en→en，
 * 于是明明模型能下，状态栏却永远显示「当前环境不支持离线翻译」。
 *
 * 本插件的用户是中文用户（输入中文、译成目标语言），所以源语言固定挑中文；
 * 万一目标语言本身就是中文，就退回英文。
 */
export function pickLocalSourceLang(targetLang) {
  const to = localLang(targetLang || 'en');
  return to === 'zh' || to === 'zh-Hant' ? 'en' : 'zh';
}

/**
 * 从 translate_a 的响应里取出译文。
 *
 * 响应形如：`[[["译文","原文",null,null,10]],null,"en",...]`
 * 长文本会被切成多段，必须按顺序拼起来，否则只拿到第一句。
 * 抽成纯函数是为了能离线单测 —— 这段逻辑出错的代价是「译文少了一半」。
 */
export function parseGoogleResponse(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    return '';
  }
  if (!Array.isArray(data) || !Array.isArray(data[0])) return '';
  return data[0]
    .filter((seg) => Array.isArray(seg) && typeof seg[0] === 'string')
    .map((seg) => seg[0])
    .join('');
}

/**
 * 走 Google 免费通道翻译。
 *
 * 必须在带 host_permissions 的 Service Worker 里调用 ——
 * MV3 的内容脚本受 CORS 限制，直接 fetch 这个地址会被浏览器拦掉。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.from]  源语言，默认 auto（让 Google 自己判断）
 * @param {string} [opts.to]    目标语言（Google 写法）
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 */
export async function googleTranslate(text, opts) {
  const { from = 'auto', to = 'en', timeoutMs = 10000, signal } = opts || {};
  const src = String(text || '');
  if (!src.trim()) return { ok: false, code: 'empty_input', error: '没有可翻译的内容' };

  const url =
    `${GOOGLE_ENDPOINT}?client=${GOOGLE_CLIENT}` +
    `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t` +
    `&q=${encodeURIComponent(src)}`;

  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit' });
    const body = await res.text();
    const ms = Date.now() - t0;

    if (!res.ok) {
      return {
        ok: false,
        code: res.status === 429 ? 'rate_limit' : 'http',
        error: `免费通道返回 ${res.status}`,
        ms
      };
    }

    const out = parseGoogleResponse(body);
    if (!out) return { ok: false, code: 'parse', error: '免费通道返回了空结果', ms };

    return { ok: true, text: out, ms, providerName: '谷歌免费通道', free: true };
  } catch (e) {
    const ms = Date.now() - t0;
    if (e && e.name === 'AbortError') {
      return { ok: false, code: 'timeout', error: '免费通道超时', ms };
    }
    return { ok: false, code: 'network', error: '免费通道网络错误', ms };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
