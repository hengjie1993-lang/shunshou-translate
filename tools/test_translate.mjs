/**
 * 开发自测脚本：验证 translator.js 的清洗逻辑与真实接口调用。
 *
 * 用法（在项目根目录下）：
 *   AGNES_API_KEY=sk-xxx node tools/test_translate.mjs
 *
 * 需要 Node 18+（内置 fetch）。走代理时加 NODE_USE_ENV_PROXY=1。
 */

import { translate, cleanTranslation, langLabel, LANGUAGES } from '../lib/translator.js';

const KEY = process.env.AGNES_API_KEY || '';
let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(actual)}`);
}

/* ---------------------------- 清洗函数单测 ---------------------------- */

console.log('=== cleanTranslation ===');
check('去前导换行', cleanTranslation('\n\nThe weather is nice today.'), 'The weather is nice today.');
check('去英文引号', cleanTranslation('"Hello world"'), 'Hello world');
check('去中文引号', cleanTranslation('“你好”'), '你好');
check('去「翻译：」前缀', cleanTranslation('翻译：Good morning'), 'Good morning');
check('保留内部分段', cleanTranslation('Line1\n\nLine2'), 'Line1\n\nLine2');
check('保留内部引号', cleanTranslation('He said "hi" to me'), 'He said "hi" to me');

console.log('\n语言表条目数:', LANGUAGES.length, '| en ->', langLabel('en'), '| ja ->', langLabel('ja'));

/* ---------------------------- 错误分支（不需要 Key） ---------------------------- */

console.log('\n=== 错误处理（不需要 Key）===');
const noKey = await translate({ text: '测试', apiKey: '', targetLang: 'en' });
console.log('空 Key ->', JSON.stringify(noKey));
if (noKey.ok || !noKey.error) failures += 1;

const emptyText = await translate({ text: '   ', apiKey: 'sk-x', targetLang: 'en' });
console.log('空文本 ->', JSON.stringify(emptyText));
if (emptyText.ok) failures += 1;

/* ---------------------------- 真实接口调用 ---------------------------- */

if (!KEY) {
  console.log('\n未提供 AGNES_API_KEY，跳过真实接口调用。');
} else {
  console.log('\n=== 真实接口调用 ===');

  const en = await translate({
    text: '今天天气很好，我想去公园散步。',
    apiKey: KEY,
    targetLang: 'en',
    tone: 'natural'
  });
  console.log('中译英 ->', JSON.stringify(en));
  if (!en.ok) failures += 1;

  const ja = await translate({
    text: '请确认一下周五的会议时间。',
    apiKey: KEY,
    targetLang: 'ja',
    tone: 'formal'
  });
  console.log('中译日 ->', JSON.stringify(ja));
  if (!ja.ok) failures += 1;

  const zh = await translate({
    text: 'The quick brown fox jumps over the lazy dog.',
    apiKey: KEY,
    targetLang: 'zh',
    tone: 'natural'
  });
  console.log('英译中 ->', JSON.stringify(zh));
  if (!zh.ok) failures += 1;

  const bad = await translate({ text: '测试', apiKey: 'sk-invalid-key-000', targetLang: 'en' });
  console.log('错误 Key ->', JSON.stringify(bad));
  if (bad.ok) failures += 1;
}

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
