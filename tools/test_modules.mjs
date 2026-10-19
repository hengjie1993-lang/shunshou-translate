/**
 * 多服务商 / 缓存 / 配置迁移 的单元测试
 *
 * 不联网：mock 掉 chrome.storage 与 fetch。
 * 运行：node tools/test_modules.mjs
 */

import { RETRY, translate, redactSecrets } from '../lib/translator.js';
import {
  translateWithFailover,
  usableProviders,
  benchmarkProviders,
  PROVIDER_PRESETS
} from '../lib/providers.js';
import { getCached, setCached, clearCache, cacheStats } from '../lib/cache.js';
import {
  googleLang,
  localLang,
  pickLocalSourceLang,
  parseGoogleResponse,
  googleTranslate,
  GOOGLE_CLIENT
} from '../lib/freeEngines.js';
import {
  loadSettings,
  ensureDefaults,
  DEFAULT_SETTINGS,
  MODEL_MIGRATIONS,
  migrateProviderModel,
  applyModelMigrations
} from '../lib/settings.js';
import {
  COLD_MS,
  PROBE_RETRY_MS,
  loadStats,
  recordSuccess,
  recordFailure,
  markProbeFailure,
  needsProbe,
  resetStats,
  orderBySpeed,
  scoreOf,
  describeStat
} from '../lib/stats.js';
import { checkVersionDrift, runningVersionOf } from '../lib/versionGuard.js';

/* ----------------------------- mock chrome.storage ----------------------------- */

let store = {};

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...store };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj) => {
        Object.assign(store, obj);
      },
      remove: async (keys) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      }
    }
  }
};

/* ----------------------------- mock fetch ----------------------------- */

let plan = [];
let lastReq = null;

globalThis.fetch = async (url, init) => {
  lastReq = { url, init };
  const step = plan.shift();
  if (!step) throw new Error('fetch 计划用完了，测试脚本需要补充预期响应');
  return step;
};

const okRes = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: text } }] })
});

const errRes = (status, body = '') => ({
  ok: false,
  status,
  text: async () => body,
  json: async () => ({})
});

/** 免费通道（Google translate_a）的响应：正文是裸文本，不是 JSON 包在 choices 里 */
const googleRes = (text) => ({
  ok: true,
  status: 200,
  text: async () => text,
  json: async () => JSON.parse(text)
});

/** 任意状态码 + 裸文本正文 */
const rawRes = (status, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => ({})
});

/* ----------------------------- 断言工具 ----------------------------- */

let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${extra ? '  -> ' + JSON.stringify(extra) : ''}`);
  }
}

/* ----------------------------- 加速测试 ----------------------------- */

RETRY.baseDelayMs = 5; // 免得测试等太久

/* ----------------------------- 1. 配置迁移 ----------------------------- */

console.log('=== 1. 旧版配置迁移 ===');

store = {
  enabled: true,
  apiKey: 'sk-legacy-key',
  endpoint: 'https://legacy.example.com/v1/chat/completions',
  model: 'legacy-model',
  smartOrder: false,
  targetLang: 'ja'
};

const migrated = await ensureDefaults();
ok('迁移后生成 providers 数组', Array.isArray(migrated.providers) && migrated.providers.length === 1, migrated.providers);
ok('旧 API Key 被搬进 providers', migrated.providers[0].apiKey === 'sk-legacy-key', migrated.providers[0]);
ok('旧 endpoint 被搬进 providers', migrated.providers[0].endpoint === 'https://legacy.example.com/v1/chat/completions');
ok('其他配置保持不变', migrated.targetLang === 'ja');
ok('storage 里的旧字段被清掉', !('apiKey' in store) && !('endpoint' in store), Object.keys(store));
ok('已废弃的 smartOrder 开关被清掉', !('smartOrder' in store), Object.keys(store));

console.log('\n=== 2. 全新安装 ===');
store = {};
const fresh = await ensureDefaults();
ok('默认带一个 Agnes 服务商', fresh.providers.length === 1 && fresh.providers[0].name === 'Agnes AI', fresh.providers);
ok('默认缓存开启', fresh.cacheEnabled === true);
ok('配置里不再有智能排序开关（常开）', !('smartOrder' in fresh), Object.keys(fresh));

/* ----------------------------- 3. 可用性过滤 ----------------------------- */

console.log('\n=== 3. 服务商可用性过滤 ===');
const filtered = usableProviders([
  { name: 'A', endpoint: 'e', model: 'm', apiKey: 'k', enabled: true },
  { name: 'B', endpoint: 'e', model: 'm', apiKey: '', enabled: true },
  { name: 'C', endpoint: 'e', model: 'm', apiKey: 'k', enabled: false },
  { name: 'D', endpoint: 'e', model: 'm', apiKey: 'k' }
]);
ok('只保留真正可用的', filtered.length === 2 && filtered[0].name === 'A' && filtered[1].name === 'D', filtered.map((p) => p.name));

/* ----------------------------- 4. 故障转移 ----------------------------- */

console.log('\n=== 4. 故障转移 ===');

const P1 = { id: '1', name: 'First', endpoint: 'https://a/v1/chat/completions', model: 'm', apiKey: 'k1', enabled: true };
const P2 = { id: '2', name: 'Second', endpoint: 'https://b/v1/chat/completions', model: 'm', apiKey: 'k2', enabled: true };
const P3 = { id: '3', name: 'Third', endpoint: 'https://c/v1/chat/completions', model: 'm', apiKey: 'k3', enabled: true };

plan = [errRes(429), errRes(429), okRes('Hello from second')];
const r1 = await translateWithFailover({ text: '你好', providers: [P1, P2] });
ok('第一家限流后切到第二家', r1.ok && r1.text === 'Hello from second', r1);
ok('标记了实际使用的服务商', r1.providerName === 'Second', r1);
ok('记录了尝试次数', r1.triedCount === 2, r1);
ok(
  '返回每一家的实际表现（供速度统计用）',
  Array.isArray(r1.attempts) &&
    r1.attempts.length === 2 &&
    r1.attempts[0].ok === false &&
    r1.attempts[1].ok === true &&
    r1.attempts[0].id === '1',
  r1.attempts
);

plan = [errRes(401, '{"error":{"message":"bad key"}}'), okRes('Hello from third')];
const r2 = await translateWithFailover({ text: '你好', providers: [P1, P3] });
ok('Key 无效也继续切下一家', r2.ok && r2.providerName === 'Third', r2);

plan = [errRes(429), errRes(429), errRes(429), errRes(429)];
const r3 = await translateWithFailover({ text: '你好', providers: [P1, P2] });
ok('全部失败时返回错误', !r3.ok && r3.code === 'all_failed', r3);
ok('错误里带上了每家的情况', Array.isArray(r3.failures) && r3.failures.length === 2, r3.failures);

plan = [];
const r4 = await translateWithFailover({ text: '你好', providers: [] });
ok('没有可用服务时明确提示', !r4.ok && r4.code === 'no_provider', r4);

plan = [okRes('Hello')];
const r5 = await translateWithFailover({ text: '你好', providers: [P1] });
ok('单服务商正常翻译', r5.ok && r5.text === 'Hello', r5);

plan = [okRes('  "Hello"  ')];
const r6 = await translateWithFailover({ text: '你好', providers: [P1] });
ok('译文仍然会被清洗', r6.ok && r6.text === 'Hello', r6);

/* ----------------------------- 5. 缓存 ----------------------------- */

console.log('\n=== 5. 本地缓存 ===');

await clearCache();
ok('初始缓存为空', (await getCached('你好世界', 'en', 'natural')) === null);

await setCached('你好世界', 'en', 'natural', 'Hello world');
ok('写入后能命中', (await getCached('你好世界', 'en', 'natural')) === 'Hello world');

ok('换目标语言不命中', (await getCached('你好世界', 'ja', 'natural')) === null);
ok('换语气不命中', (await getCached('你好世界', 'en', 'formal')) === null);
ok('不同原文不命中', (await getCached('别的句子', 'en', 'natural')) === null);

const stats = await cacheStats();
ok('统计条数正确', stats.entries === 1, stats);
ok('统计命中次数', stats.hits === 1, stats);

await clearCache();
ok('清空后不再命中', (await getCached('你好世界', 'en', 'natural')) === null);

/* ----------------------------- 6. 智能排序（速度统计） ----------------------------- */

console.log('\n=== 6. 智能排序：按实测速度排序 ===');

const TRIPLE = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' }
];
const ids = (list) => list.map((p) => p.id).join('');

await resetStats();

// 6.1 冷启动：没有数据时保持用户配置顺序
ok('无数据时保持配置顺序', ids(orderBySpeed(TRIPLE, {}, 1000)) === 'abc');

// 6.2 实测最快的排到最前
for (let i = 0; i < 4; i += 1) await recordSuccess('c', 800);
for (let i = 0; i < 4; i += 1) await recordSuccess('a', 3000);
const st1 = await loadStats();
ok('实测最快的排第一', ids(orderBySpeed(TRIPLE, st1, 2000))[0] === 'c', ids(orderBySpeed(TRIPLE, st1, 2000)));
ok(
  '实测慢的排到「未测速」的后面',
  ids(orderBySpeed(TRIPLE, st1, 2000)) === 'cba',
  ids(orderBySpeed(TRIPLE, st1, 2000))
);

// 6.3 样本少时向中性值收缩，避免一次侥幸就霸榜
const thin = scoreOf({ emaMs: 500, samples: 1, failStreak: 0, cooldownUntil: 0 }, 1000);
const full = scoreOf({ emaMs: 500, samples: 8, failStreak: 0, cooldownUntil: 0 }, 1000);
ok('样本少时向中性值收缩', thin.base > 500 && thin.base < COLD_MS, thin);
ok('样本足够后完全采信实测值', full.base === 500, full);

// 6.4 连续失败会被加权惩罚
const noFail = scoreOf({ emaMs: 1000, samples: 4, failStreak: 0, cooldownUntil: 0 }, 1000).score;
const withFail = scoreOf({ emaMs: 1000, samples: 4, failStreak: 2, cooldownUntil: 0 }, 1000).score;
ok('连续失败加权惩罚', withFail > noFail, { noFail, withFail });

// 6.5 限流后进入冷却，冷却中排到最后
await resetStats();
for (let i = 0; i < 4; i += 1) await recordSuccess('fast', 600);
await recordFailure('slow', 'rate_limit');
const st2 = await loadStats();
ok('冷却中的服务商排到最后', ids(orderBySpeed([{ id: 'slow' }, { id: 'fast' }], st2, Date.now())) === 'fastslow');

const cooled = scoreOf(st2.slow, Date.now());
ok('冷却中的标记正确', cooled.cooling === true, cooled);
ok('冷却过期后标记消失', scoreOf(st2.slow, Date.now() + 120000).cooling === false);

// 6.6 EMA 收敛
await resetStats();
await recordSuccess('e', 1000);
let e = (await loadStats()).e;
ok('首次成功直接采用实测值', e.emaMs === 1000 && e.samples === 1, e);

await recordSuccess('e', 2000);
e = (await loadStats()).e;
ok('后续成功按 EMA 平滑（0.35 权重）', e.emaMs === 1350 && e.samples === 2, e);

// 6.7 成功会清空失败惩罚
await resetStats();
await recordFailure('f', 'timeout');
let f = (await loadStats()).f;
ok('失败后设置冷却期', f.cooldownUntil > Date.now(), f);
ok('失败累计次数', f.failStreak === 1 && f.fails === 1, f);

await recordSuccess('f', 900);
f = (await loadStats()).f;
ok('成功后清空冷却与连续失败', f.cooldownUntil === 0 && f.failStreak === 0, f);

// 6.8 用户主动取消不算服务商的锅
await resetStats();
await recordFailure('g', 'cancelled');
ok('用户取消不记入失败', (await loadStats()).g === undefined);

// 6.9 状态文案
ok('还没测出速度时显示「测速中…」', describeStat(undefined).text === '测速中…');
ok('有数据时显示实测秒数', describeStat({ emaMs: 1600, samples: 3 }).text === '实测 1.6s');
ok(
  '冷却中显示剩余秒数',
  /冷却中 \d+s/.test(describeStat({ emaMs: 1000, samples: 1, cooldownUntil: Date.now() + 30000 }).text),
  describeStat({ emaMs: 1000, samples: 1, cooldownUntil: Date.now() + 30000 })
);

// 6.10 重置
await resetStats();
ok('重置后统计为空', Object.keys(await loadStats()).length === 0);

/* ----------------------------- 7. 自动测速（全自动，无需用户操作） ----------------------------- */

console.log('\n=== 7. 自动测速判定 ===');

const now = Date.now();

ok('从没碰过的服务商需要补测', needsProbe(undefined, now) === true);
ok('已经有实测样本的不再补测', needsProbe({ samples: 3, emaMs: 1200, probedAt: now }, now) === false);
ok('探测失败过、还没到重试时间的先跳过', needsProbe({ samples: 0, probedAt: now }, now) === false);
ok(
  '探测失败超过重试间隔后会再补测',
  needsProbe({ samples: 0, probedAt: now - PROBE_RETRY_MS - 1000 }, now) === true
);

// 关键：自动探测失败绝不能降权（否则用户 Key 还没粘贴完就会把这家误判成坏的）
await resetStats();
await markProbeFailure('half-typed', 'auth');
const probed = (await loadStats())['half-typed'];
ok('探测失败只记 probedAt，不设冷却', probed.cooldownUntil === 0, probed);
ok('探测失败不计入连续失败', probed.failStreak === 0 && probed.fails === 0, probed);
ok('探测失败不会让它排到最后', scoreOf(probed, Date.now()).cooling === false, probed);

// 对比：真实使用中的失败（用户已经在翻译了）该降权就要降权
await resetStats();
await recordFailure('real-fail', 'rate_limit');
const realFail = (await loadStats())['real-fail'];
ok('真实使用的失败会设冷却', realFail.cooldownUntil > Date.now(), realFail);
ok('真实使用的失败会累加连续失败', realFail.failStreak === 1, realFail);

// 探测成功后，这家就不再需要补测了
await resetStats();
await recordSuccess('probed-ok', 1100);
ok('探测成功后就拥有实测数据', (await loadStats())['probed-ok'].samples === 1);
ok('有数据后不再重复探测', needsProbe((await loadStats())['probed-ok'], Date.now()) === false);

/* ----------------------------- 8. 并发测速（自动测速的执行器） ----------------------------- */

console.log('\n=== 8. 并发测速 ===');

plan = [okRes('Hello A'), okRes('Hello B')];
const bench = await benchmarkProviders([P1, P2]);
ok('并发探测返回每一家的结果', bench.length === 2 && bench.every((r) => r.ok), bench);
ok('带上实测耗时', bench.every((r) => typeof r.ms === 'number' && r.ms >= 0), bench);
ok('带上服务商 id 与名称', bench[0].id === '1' && bench[0].name === 'First', bench[0]);

plan = [errRes(401, '{"error":{"message":"bad key"}}'), okRes('ok')];
const bench2 = await benchmarkProviders([P1, P2]);
ok('失败的那家如实返回错误码', bench2[0].ok === false && bench2[0].code === 'auth', bench2[0]);
ok('成功的那家不受影响', bench2[1].ok === true, bench2[1]);

plan = [okRes('x')];
const bench3 = await benchmarkProviders([
  P1,
  { id: 'x', name: 'NoKey', endpoint: 'https://d/v1/chat/completions', model: 'm', apiKey: '' }
]);
ok('只探测真正可用的服务商', bench3.length === 1 && bench3[0].id === '1', bench3);

plan = [];
const bench4 = await benchmarkProviders([]);
ok('没有可用服务商时返回空数组', Array.isArray(bench4) && bench4.length === 0, bench4);

/* ----------------------------- 9. 模型下线（2026 静默故障） ----------------------------- */

console.log('\n=== 9. 模型下线：识别 + 自动迁移 ===');

// 9.1 已知下线的模型被自动换成替代模型
const groqP = {
  id: 'g',
  name: 'Groq',
  endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  model: 'llama-3.3-70b-versatile',
  apiKey: 'k'
};
const g1 = migrateProviderModel(groqP);
ok('Groq 已下线模型被自动替换', g1.changed && g1.provider.model === 'openai/gpt-oss-120b', g1);

// 智谱：2026-10-14 实测 glm-4.7-flash 高峰期 5 次里 4 次 429，换成稳定的 glm-4-flash
const glmP = {
  id: 'z',
  name: '智谱 GLM',
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  model: 'glm-4.7-flash',
  apiKey: 'k'
};
const g2 = migrateProviderModel(glmP);
ok('智谱 glm-4.7-flash 被换成 glm-4-flash', g2.changed && g2.provider.model === 'glm-4-flash', g2);

// Agnes 2026-10 把 agnes-2.0-flash 下掉了（/v1/models 里已无此项，调用回 503）
const agP = {
  id: 'a',
  name: 'Agnes AI',
  endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions',
  model: 'agnes-2.0-flash',
  apiKey: 'k'
};
const gA = migrateProviderModel(agP);
ok('Agnes 2.0 Flash 被换成 2.5 Flash', gA.changed && gA.provider.model === 'agnes-2.5-flash', gA);

// 9.2 不能误伤：同名模型换到别家域名，保持不动
const otherP = {
  id: 'o',
  name: '别家代理',
  endpoint: 'https://my-proxy.example.com/v1/chat/completions',
  model: 'llama-3.3-70b-versatile',
  apiKey: 'k'
};
const g3 = migrateProviderModel(otherP);
ok('别家域名下的同名模型不被误改', g3.changed === false && g3.provider.model === 'llama-3.3-70b-versatile', g3);

// 9.3 幂等：跑两遍结果一致
const onceM = applyModelMigrations([groqP, glmP, agP]);
const twiceM = applyModelMigrations(onceM);
ok('迁移幂等（跑两遍结果一样）', JSON.stringify(onceM) === JSON.stringify(twiceM), twiceM.map((p) => p.model));

// 9.4 端到端：已存老配置的用户，loadSettings 读出来就是修好的
store = { providers: [groqP, glmP] };
const repaired = await loadSettings();
ok(
  '老配置读出来自动修好（这就是 boss 遇到的场景）',
  repaired.providers.every((p) => p.model !== 'llama-3.3-70b-versatile' && p.model !== 'glm-4.7-flash'),
  repaired.providers.map((p) => p.model)
);
ok('迁移表覆盖仍支持的三家服务商', MODEL_MIGRATIONS.length >= 8, MODEL_MIGRATIONS.length);

// 9.5 错误识别：400 + model_decommissioned
plan = [
  errRes(
    400,
    '{"error":{"message":"The model `llama-3.3-70b-versatile` has been decommissioned.","code":"model_decommissioned"}}'
  )
];
const rGone = await translateWithFailover({ text: '你好', providers: [groqP] });
ok('模型下线被识别为 model_retired', rGone.attempts[0].code === 'model_retired', rGone.attempts);
ok(
  '错误信息点名具体模型并指引去换',
  /llama-3\.3-70b-versatile/.test(rGone.error) && /更换模型/.test(rGone.error),
  rGone.error
);

// 9.6 普通 400 不该被误判
plan = [errRes(400, '{"error":{"message":"invalid temperature value"}}')];
const rBad = await translateWithFailover({ text: '你好', providers: [groqP] });
ok('普通 400 不会被误判成模型下线', rBad.attempts[0].code === 'http', rBad.attempts);

// 9.6b Agnes 把「模型不存在」包在 503 里返回（LiteLLM 网关），必须照样认出来。
// 这个 case 特别容易漏：503 通常是「服务端繁忙」，代码会直接去重试，
// 于是每次都白等一轮，用户只看到「服务端错误」。
plan = [
  errRes(
    503,
    '{"code":"model_not_found","message":"No available channel for model agnes-2.0-flash under group default (distributor)","type":"AgnesAI_error"}'
  )
];
const rAgnesGone = await translateWithFailover({ text: '你好', providers: [agP] });
ok('503 里的 model_not_found 也被识别为 model_retired', rAgnesGone.attempts[0].code === 'model_retired', rAgnesGone.attempts);
ok('并点名是 agnes-2.0-flash 该换', /agnes-2\.0-flash/.test(rAgnesGone.error), rAgnesGone.error);

// 9.6c 真正的 503（网关过载）不能被误判成模型下线。
// 单家服务商时会耐心重试 4 次（maxRetries=3），所以计划里要放 4 个响应。
const REAL_503 = '{"error":{"message":"upstream connect error or disconnect/reset before headers"}}';
plan = [errRes(503, REAL_503), errRes(503, REAL_503), errRes(503, REAL_503), errRes(503, REAL_503)];
const rReal503 = await translateWithFailover({ text: '你好', providers: [agP] });
ok('普通 503 仍按服务端错误处理', rReal503.attempts[0].code === 'server', rReal503.attempts);

// 9.7 多家全是模型下线 → 一句人话
plan = [
  errRes(400, '{"error":{"message":"model not found"}}'),
  errRes(400, '{"error":{"message":"The model has been decommissioned"}}')
];
const rAllGone = await translateWithFailover({ text: '你好', providers: [P1, P2] });
ok(
  '多家模型都下线时给出统一指引',
  !rAllGone.ok && /都已下线/.test(rAllGone.error) && /设置页/.test(rAllGone.error),
  rAllGone.error
);

// 9.8 设置页徽章
const mStatGone = await recordFailure('g', 'model_retired');
ok(
  '模型下线写入长冷却（不再抢第一位）',
  mStatGone.cooldownUntil - Date.now() > 250000,
  mStatGone.cooldownUntil - Date.now()
);
ok('设置页显示「模型已下线」', describeStat(mStatGone).text.includes('模型已下线'), describeStat(mStatGone));
const mStatFixed = await recordSuccess('g', 900);
ok(
  '修好之后徽章消失',
  !describeStat(mStatFixed).text.includes('模型已下线') && describeStat(mStatFixed).text.includes('实测'),
  describeStat(mStatFixed)
);

/* ----------------------------- 10. 预设精简 ----------------------------- */

console.log('\n=== 10. 预设列表只留「验证过能用」的 ===');

const presetIds = PROVIDER_PRESETS.map((p) => p.preset);
ok('预设共 4 个（含自定义）', PROVIDER_PRESETS.length === 4, presetIds);
ok('包含智谱 GLM 免费模型', presetIds.includes('zhipu'), presetIds);
ok(
  '智谱预设指向实测稳定的 glm-4-flash 且走 OpenAI 兼容端点',
  (() => {
    const z = PROVIDER_PRESETS.find((p) => p.preset === 'zhipu');
    return z && z.model === 'glm-4-flash' && z.endpoint === 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  })(),
  PROVIDER_PRESETS.find((p) => p.preset === 'zhipu')
);
// 2026-10-14：这些入口要么实测不可用，要么从未被使用过，一并删掉
for (const gone of ['openrouter', 'siliconflow', 'deepseek', 'gemini', 'cerebras']) {
  ok(`已移除不可用/未使用的「${gone}」入口`, !presetIds.includes(gone), presetIds);
}
ok(
  '只保留实测跑通的三家 AI 服务商',
  ['groq', 'zhipu', 'agnes'].every((id) => presetIds.includes(id)),
  presetIds
);
ok('保留了自定义服务入口', presetIds.includes('custom'), presetIds);
ok(
  '每个预设都有 endpoint 与 model（自定义除外）',
  PROVIDER_PRESETS.filter((p) => p.preset !== 'custom').every((p) => p.endpoint && p.model),
  PROVIDER_PRESETS.map((p) => `${p.preset}:${p.model}`)
);

/* ----------------------------- 11. 粘贴卫生（首尾空白） ----------------------------- */

console.log('\n=== 11. 粘贴进来的 Key / 模型名要清干净 ===');

plan = [okRes('Hello')];
await translate({
  text: '你好',
  apiKey: '  sk-abc123  \n',
  endpoint: '  https://api.groq.com/openai/v1/chat/completions  ',
  model: '  openai/gpt-oss-120b  ',
  targetLang: 'en'
});
ok(
  'Key 首尾的空白/换行被清掉（否则请求头变成 Bearer sk-xxx\\n → 401）',
  lastReq.init.headers.Authorization === 'Bearer sk-abc123',
  JSON.stringify(lastReq.init.headers.Authorization)
);
ok('endpoint 首尾空白被清掉', lastReq.url === 'https://api.groq.com/openai/v1/chat/completions', lastReq.url);
ok(
  'model 首尾空白被清掉（否则服务端说模型不存在）',
  JSON.parse(lastReq.init.body).model === 'openai/gpt-oss-120b',
  JSON.parse(lastReq.init.body).model
);

const blankKey = await translate({ text: '你好', apiKey: '   \n  ', model: 'm', endpoint: 'https://a/b' });
ok('只粘了空白的 Key 视为没填', !blankKey.ok && blankKey.code === 'no_key', blankKey);

ok(
  '只有空白的服务商不算「可用」',
  usableProviders([{ name: 'X', endpoint: 'e', model: 'm', apiKey: '  \n ', enabled: true }]).length === 0
);

// 服务端原话要带进错误信息里，方便排查
plan = [errRes(401, '{"error":{"code":"401","message":"令牌已过期或验证不正确"}}')];
const rAuth = await translate({ text: '你好', apiKey: 'k', endpoint: 'https://a/b', model: 'm', maxRetries: 0 });
ok('401 错误带上 HTTP 状态', /HTTP 401/.test(rAuth.error), rAuth.error);
ok('401 错误带上服务端原话', /令牌已过期或验证不正确/.test(rAuth.error), rAuth.error);

// 反过来：限流 / 5xx 的响应体往往是一大段英文（Agnes 的 429 正文有 150 字符，
// 还劝你升级付费套餐），塞进提示只会把一句话撑成一坨。这类必须保持短句。
const LONG_429 =
  '{"error":{"message":"You have reached the API rate limit for free users. Upgrade to a Token Plan to unlock higher limits and continue using the API without interruption."}}';
plan = [errRes(429, LONG_429), errRes(429, LONG_429), errRes(429, LONG_429), errRes(429, LONG_429)];
const rRate = await translateWithFailover({ text: '你好', providers: [P1, P2] });
ok(
  '限流提示保持短句，不把服务端长正文塞进来',
  /限流/.test(rRate.error) && !/Upgrade to a Token Plan/.test(rRate.error),
  rRate.error
);
ok('限流提示长度可控（< 60 字）', rRate.error.length < 60, rRate.error.length + ' 字: ' + rRate.error);

// 服务端错误同理
plan = [
  errRes(500, '{"error":{"message":"upstream connect error or disconnect/reset before headers. reset reason: connection failure"}}'),
  errRes(500, '{"error":{"message":"upstream connect error or disconnect/reset before headers. reset reason: connection failure"}}'),
  errRes(500, '{"error":{"message":"upstream connect error or disconnect/reset before headers. reset reason: connection failure"}}'),
  errRes(500, '{"error":{"message":"upstream connect error or disconnect/reset before headers. reset reason: connection failure"}}')
];
const rSrv = await translateWithFailover({ text: '你好', providers: [P1, P2] });
ok('5xx 提示不带服务端长正文', !/upstream connect error/.test(rSrv.error), rSrv.error);

/* ------------------------- 12. 免费引擎（Google 通道） ------------------------- */

// 12.1 语言映射
ok('googleLang: zh → zh-CN', googleLang('zh') === 'zh-CN');
ok('googleLang: zh-TW → zh-TW', googleLang('zh-TW') === 'zh-TW');
ok('googleLang: 未知语言兜底为 en', googleLang('xx') === 'en');

// 12.1b Chrome 内置 Translator API 的语言写法（它没有 zh-CN）
ok('localLang: zh-CN → zh', localLang('zh-CN') === 'zh');
ok('localLang: zh-Hans → zh', localLang('zh-Hans') === 'zh');
ok('localLang: zh-TW → zh-Hant', localLang('zh-TW') === 'zh-Hant');
ok('localLang: zh-Hant → zh-Hant', localLang('zh-Hant') === 'zh-Hant');
ok('localLang: en 原样返回', localLang('en') === 'en');

// 12.1c 设置页那条「离线引擎状态」的源语言必须和目标语言不同 ——
// Chrome 对同语种一律回 unavailable，那不是「环境不支持」，是「这对语向没意义」。
ok('目标英文时源语言挑中文（zh→en）', pickLocalSourceLang('en') === 'zh');
ok('目标日文时源语言挑中文（zh→ja）', pickLocalSourceLang('ja') === 'zh');
ok('目标中文时源语言挑英文（en→zh）', pickLocalSourceLang('zh') === 'en');
ok('目标 zh-CN 时源语言挑英文', pickLocalSourceLang('zh-CN') === 'en');
ok('目标 zh-TW 时源语言挑英文', pickLocalSourceLang('zh-TW') === 'en');
ok('目标缺省时按 en 处理 → 源语言 zh', pickLocalSourceLang(undefined) === 'zh');
ok(
  '源语言永远不等于目标语言（不会自造 en→en 这种死语向）',
  ['en', 'zh', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de'].every(
    (t) => pickLocalSourceLang(t) !== localLang(t)
  )
);

// 12.2 响应解析：短句
ok(
  'parseGoogleResponse 能取出译文',
  parseGoogleResponse('[[["你好，世界。","Hello, world.",null,null,10]],null,"en"]') === '你好，世界。'
);

// 12.3 长文本会被切成多段 —— 不拼起来的话译文只剩第一句，这是最容易踩的坑
ok(
  'parseGoogleResponse 按顺序拼接多段',
  parseGoogleResponse(
    '[[["第一句。","One.",null,null,3],["第二句。","Two.",null,null,3],["第三句。","Three.",null,null,3]],null,"en"]'
  ) === '第一句。第二句。第三句。'
);

// 12.4 容错：Google 被拦时返回的是 HTML 拦截页，不能让它把 JSON.parse 炸掉
ok('parseGoogleResponse 遇到 HTML 拦截页返回空串', parseGoogleResponse('<html>Sorry...</html>') === '');
ok('parseGoogleResponse 遇到空数组返回空串', parseGoogleResponse('[]') === '');

// 12.5 正常请求：URL 组装
plan = [googleRes('[[["你好","Hello",null,null,10]],null,"en"]')];
const gOk = await googleTranslate('Hello', { to: 'zh-CN' });
ok('googleTranslate 成功返回译文', gOk.ok === true && gOk.text === '你好', gOk);
ok('googleTranslate 结果带 free 标记（供 UI 区分来源）', gOk.free === true);
ok(
  'googleTranslate 走 dict-chrome-ex 通道',
  lastReq.url.includes('client=' + GOOGLE_CLIENT),
  lastReq.url
);
ok('googleTranslate 默认 auto 识别源语言', /sl=auto/.test(lastReq.url), lastReq.url);
ok('googleTranslate 正确传目标语言', /tl=zh-CN/.test(lastReq.url), lastReq.url);
ok('googleTranslate 对文本做了 URL 编码', /q=Hello/.test(lastReq.url), lastReq.url);

// 12.6 限流（gtx / webapp 这两个 client 现在就是被这样拦掉的）
plan = [rawRes(429, '<html>Sorry...</html>')];
const g429 = await googleTranslate('Hello', { to: 'zh-CN' });
ok('googleTranslate 429 → rate_limit', g429.ok === false && g429.code === 'rate_limit', g429);

// 12.7 返回 200 但内容解析不出来
plan = [googleRes('<html>nope</html>')];
const gBad = await googleTranslate('Hello', { to: 'zh-CN' });
ok('googleTranslate 解析不出内容 → parse 错误', gBad.ok === false && gBad.code === 'parse', gBad);

// 12.8 空输入不应该发请求
plan = [];
const gEmpty = await googleTranslate('   ', { to: 'zh-CN' });
ok('googleTranslate 空输入直接返回，不消耗网络', gEmpty.ok === false && gEmpty.code === 'empty_input', gEmpty);

// 12.9 默认开关：谷歌开（零配置即可用），离线关（要先下模型）
ok('默认开启谷歌免费通道', DEFAULT_SETTINGS.engines.google === true);
ok('默认关闭离线引擎（需先下载模型）', DEFAULT_SETTINGS.engines.local === false);

// 12.10 老配置迁移：engines 整个缺失
const savedStore = { ...store };
store = { providers: [{ id: 'a', endpoint: 'https://x/v1/chat/completions', model: 'm', apiKey: 'k' }] };
const s1 = await loadSettings();
ok(
  '老配置没有 engines 键 → 自动补默认值',
  s1.engines && s1.engines.google === true && s1.engines.local === false,
  s1.engines
);

// 12.11 engines 只有一半（用户先开了谷歌，离线是后来加的版本）
store = {
  providers: [{ id: 'a', endpoint: 'https://x/v1/chat/completions', model: 'm', apiKey: 'k' }],
  engines: { google: false }
};
const s2 = await loadSettings();
ok(
  'engines 只有一半 → 缺失的键补默认值',
  s2.engines && s2.engines.google === false && s2.engines.local === false,
  s2.engines
);
store = savedStore;

/* ----------------------------- 13. 版本自检 ----------------------------- */

console.log('\n=== 13. 版本自检（识破「改了代码没在 chrome://extensions 刷新」）===');

// 这一节要同时用 chrome.runtime 和 fetch，单独换一套 mock，别污染上面的 fetch 计划
const fetchBeforeGuard = globalThis.fetch;

/** disk = 磁盘 manifest 版本，page = 页面内存版本，sw = 后台回话（'' = 旧代码，null = 没问到） */
function setVersionEnv(disk, page, sw) {
  globalThis.fetch = async (url) => {
    if (/manifest\.json/.test(String(url))) {
      return { ok: true, json: async () => ({ version: disk }) };
    }
    throw new Error('版本自检不该请求别的地址: ' + url);
  };
  globalThis.chrome.runtime = {
    getURL: (p) => 'chrome-extension://test/' + p,
    getManifest: () => ({ version: page }),
    sendMessage: async (msg) => {
      if (msg && msg.type === 'swPing') {
        if (sw === null) throw new Error('Could not establish connection');
        return sw ? { ok: true, version: sw } : { ok: true };
      }
      return { ok: true };
    }
  };
}

setVersionEnv('1.8.0', '1.8.0', '1.8.0');
let vg = await checkVersionDrift();
ok('三个版本一致 → 不报警', vg.stale === false, vg);

setVersionEnv('1.8.0', '1.8.0', '');
vg = await checkVersionDrift();
ok('后台不认识 swPing → 判定为旧代码并报警', vg.stale === true && vg.sw === '', vg);

setVersionEnv('1.8.0', '1.0.0', '1.0.0');
vg = await checkVersionDrift();
ok('磁盘与页面版本不一致 → 报警', vg.stale === true, vg);

setVersionEnv('1.8.0', '1.8.0', '1.7.0');
vg = await checkVersionDrift();
ok('后台版本落后于磁盘 → 报警', vg.stale === true, vg);

setVersionEnv('1.8.0', '1.8.0', null);
vg = await checkVersionDrift();
ok('问不到后台（连接失败）→ 不报警，避免冷启动误报', vg.stale === false && vg.sw === null, vg);

globalThis.chrome.runtime.sendMessage = () => new Promise(() => {}); // 永不回话
vg = await checkVersionDrift({ timeoutMs: 20 });
ok('后台超时未回 → 视为没问到，不报警', vg.stale === false && vg.sw === null, vg);

globalThis.fetch = async () => {
  throw new Error('manifest 读不到');
};
globalThis.chrome.runtime.sendMessage = async () => ({ ok: true, version: '1.8.0' });
vg = await checkVersionDrift();
ok('读不到磁盘 manifest 时不误报', vg.stale === false && vg.disk === '', vg);

ok('runningVersionOf 优先取后台版本', runningVersionOf({ sw: '1.0.0', page: '1.8.0' }) === '1.0.0');
ok('runningVersionOf 后台未知时退回页面版本', runningVersionOf({ sw: '', page: '1.8.0' }) === '1.8.0');
ok('runningVersionOf 对空值安全', runningVersionOf(null) === '');

globalThis.fetch = fetchBeforeGuard;

/* ------------------------- 14. 密钥不外泄（开源前提） ------------------------- */

console.log('\n=== 14. 错误文本里不得出现 API Key ===');

// 全部用重复字符拼出来，一眼就是假的。
// 不要写成像真的随机串 —— GitHub 的密钥扫描会把它当成泄露并拦住 push。
const KEY = 'gsk' + '_' + 'x'.repeat(32);
const KEY8 = KEY.slice(0, 8);

ok(
  '原文精确命中 → 抹掉',
  !redactSecrets(`Incorrect API key provided: ${KEY}`, KEY).includes(KEY)
);

ok(
  '同一段文本里出现两次 → 都抹掉',
  (redactSecrets(`${KEY} ... again ${KEY}`, KEY).match(/gsk_/g) || []).length === 0
);

ok(
  '网关只回显前 8 位 → 也要抹掉',
  !redactSecrets(`key prefix ${KEY8} is invalid`, KEY).includes(KEY8)
);

ok(
  '不认识本次 Key 也能按形态兜底（Bearer）',
  !redactSecrets('Authorization: Bearer ' + 'y'.repeat(24), '').includes('y'.repeat(24))
);

ok(
  '不认识本次 Key 也能按形态兜底（sk- / gsk_ / AIza）',
  !/sk-[A-Za-z0-9]{12,}|gsk_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9]{12,}/.test(
    redactSecrets(
      ['sk-' + 'a'.repeat(20), 'gsk_' + 'b'.repeat(20), 'AIza' + 'c'.repeat(20)].join(' '),
      ''
    )
  )
);

ok('正常文本不被误伤', redactSecrets('模型 gpt-oss-120b 不可用', KEY) === '模型 gpt-oss-120b 不可用');

ok('空值安全', redactSecrets(null, KEY) === '' && redactSecrets('x', null) === 'x');

ok(
  'Key 太短时不做精确替换（避免把正常单词吃掉）',
  redactSecrets('the word ab is common', 'ab') === 'the word ab is common'
);

// 端到端：服务商在 401 正文里回显 Key，界面拿到的 error 里不能有它
globalThis.fetch = async () => ({
  ok: false,
  status: 401,
  text: async () => JSON.stringify({ error: { message: `Invalid key: ${KEY}` } })
});
const leak = await translate({ text: '你好', targetLang: 'en', apiKey: KEY, endpoint: 'https://x/v1/chat/completions', model: 'm' });
ok('401 响应回显 Key → 返回给界面的 error 已脱敏', !String(leak.error || '').includes(KEY), leak.error);
ok('401 仍然归类为 auth 错误', leak.code === 'auth', leak.code);

globalThis.fetch = fetchBeforeGuard;

/* ----------------------------- 结果 ----------------------------- */

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
