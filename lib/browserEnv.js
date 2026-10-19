/**
 * 浏览器环境识别 —— 同一份 MV3 包要同时跑在 Chrome 和 Edge 上。
 *
 * 为什么需要这个文件：
 * 两个浏览器的内核是同一个（Chromium），扩展 API 完全一致 —— 换句话说
 * **插件本身不需要为 Edge 改任何逻辑**。真正会出错的只有一件事：
 * **内置页面的协议头不同**。Chrome 是 `chrome://`，Edge 是 `edge://`。
 * 只要代码里写死了 `chrome://extensions`，在 Edge 上就是一个死链接。
 *
 * 还有一条容易被忽略的规则：**扩展无权跳转 `chrome://` / `edge://` 这类受保护页面**，
 * `chrome.tabs.create({ url: 'chrome://extensions' })` 会直接抛
 * 「Cannot access a chrome:// URL」。也就是说那种「打开扩展管理页」按钮
 * 在 Chrome 上本来也是坏的。所以刷新扩展一律走 `chrome.runtime.reload()`，
 * 内置地址只用于「复制给用户看」。
 */

/**
 * 已知浏览器。**顺序有意义**：Edge 的 UA 里也带 `Chrome/`，必须先匹配 Edge。
 *
 * @type {Array<{id: string, name: string, pattern: RegExp, extUrl: string, storeUrl: string}>}
 */
const KNOWN = [
  {
    id: 'edge',
    name: 'Edge',
    pattern: /Edg(?:e|A|iOS)?\//,
    extUrl: 'edge://extensions',
    storeUrl: 'https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home'
  },
  {
    id: 'chrome',
    name: 'Chrome',
    pattern: /Chrome\//,
    extUrl: 'chrome://extensions',
    storeUrl: 'https://chromewebstore.google.com/'
  }
];

/** 兜底：其它 Chromium 内核（Brave / Opera / Vivaldi / 360 等）都认 chrome:// 并自动跳转 */
const FALLBACK = {
  id: 'chromium',
  name: 'Chromium',
  extUrl: 'chrome://extensions',
  storeUrl: ''
};

/**
 * 识别当前浏览器。
 *
 * @param {string} [ua] 便于测试注入；默认取 `navigator.userAgent`
 * @returns {{id: string, name: string, extUrl: string, storeUrl: string}}
 */
export function detectBrowser(ua) {
  const s =
    typeof ua === 'string'
      ? ua
      : typeof navigator !== 'undefined' && navigator.userAgent
        ? navigator.userAgent
        : '';

  for (const b of KNOWN) {
    if (b.pattern.test(s)) {
      return { id: b.id, name: b.name, extUrl: b.extUrl, storeUrl: b.storeUrl };
    }
  }
  return { ...FALLBACK };
}

/**
 * 立刻重载扩展 —— 这是「改完代码没生效」唯一真正管用的按钮。
 *
 * 不用 `tabs.create('chrome://extensions')`：扩展无权打开受保护页面，必然抛错。
 * 调用之后当前页面会变成孤儿页（它的 `chrome.*` 全部失效），
 * 所以调用方应当在文案里提示用户「关掉本页重开」。
 *
 * @returns {boolean} 是否成功发出重载指令
 */
export function reloadExtension() {
  try {
    chrome.runtime.reload();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 把「去扩展管理页」这件事包装成一个不会抛错的尝试。
 * 极少数环境允许打开，能开就开；开不了返回 false，交给上层提示用户手动输入地址。
 *
 * @param {string} [url] 默认用当前浏览器的扩展管理页
 * @returns {Promise<boolean>}
 */
export async function openExtensionsPage(url) {
  const target = url || detectBrowser().extUrl;
  try {
    await chrome.tabs.create({ url: target });
    return true;
  } catch (_) {
    return false;
  }
}
