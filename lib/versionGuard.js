/**
 * 版本自检 —— 用来识破「改了代码但没在 chrome://extensions 点刷新」。
 *
 * 为什么需要它：
 * 扩展的**页面**（options.html / options.js / popup.*）是浏览器直接从磁盘读的，
 * 所以改完代码一打开就是新的。但**后台 Service Worker** 会被 Chrome 连同注册信息
 * （`service_worker_registration_info.version`）一起缓存住，在 `chrome://extensions`
 * 点「刷新」之前，一直跑最初装进去的那份代码。
 *
 * 表现出来就是：**界面看着是全新的，翻译行为却还是老逻辑**，甚至弹出源码里早就删掉的
 * 旧报错文案。对着当前源码 grep 一百遍也找不到那句话 —— 因为它压根不在跑。
 * 这个坑真实发生过，浪费了一整轮排查，所以固化成代码。
 *
 * 做法是把三个版本号摆出来比：
 *   - disk：磁盘上的 manifest.json（你刚改完的代码）
 *   - page：chrome.runtime.getManifest()（页面内存里的那份 manifest）
 *   - sw  ：后台对 `swPing` 的回答（真正在跑翻译逻辑的那份代码）
 *
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{stale: boolean, disk: string, page: string, sw: string|null}>}
 *   `sw === ''`   后台回了话但不认识 `swPing` → 它一定是旧代码（这条消息是新版才加的）。
 *   `sw === null` 没问到（超时 / 没有连接）→ 不下结论，避免 Service Worker 冷启动误报。
 */
export async function checkVersionDrift(options = {}) {
  const timeoutMs = options.timeoutMs || 2500;

  let disk = '';
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    disk = String((await res.json()).version || '');
  } catch (_) {
    disk = '';
  }

  let page = '';
  try {
    page = String(chrome.runtime.getManifest().version || '');
  } catch (_) {
    page = '';
  }

  let sw = null;
  try {
    const resp = await Promise.race([
      Promise.resolve(chrome.runtime.sendMessage({ type: 'swPing' })).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]);
    // resp 为 null 有两种来源：sendMessage 失败，或者超时哨兵 —— 都视为「没问到」
    if (resp !== null) {
      sw = resp && typeof resp.version === 'string' && resp.version ? resp.version : '';
    }
  } catch (_) {
    sw = null;
  }

  const differs = (a, b) => !!a && !!b && a !== b;
  const stale = differs(page, disk) || sw === '' || differs(sw, disk);

  return { stale, disk, page, sw };
}

/** 后台实际在跑的版本号（问到了就用问到的，问不到退回页面版本） */
export function runningVersionOf(result) {
  if (!result) return '';
  return result.sw || result.page || '';
}
