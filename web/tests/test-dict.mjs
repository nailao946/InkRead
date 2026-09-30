/* M3 离线词典模块测试（Node 环境，纯逻辑 + fetch 桩）
   运行：node tests/test-dict.mjs
   覆盖：分片名计算、词形归一化、lookup 命中 / 词形还原 / 未命中 / file:// 降级。
   （fetch / IndexedDB 在 Node 中缺失，用桩模拟；dict.js 会优雅降级为内存模式） */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import assert from 'assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'dict');

/* 浏览器环境桩（与 test-importers.mjs 一致） */
globalThis.window = globalThis;
globalThis.document = { addEventListener() {} };

/* fetch 桩：把 'dict/<letter>.json' 映射到 fixtures，模拟浏览器分片加载 */
function makeFetch(impl) {
  return async (url) => {
    if (impl === 'throw') throw new Error('file protocol not supported');
    const m = String(url).match(/dict\/([a-z]|other)\.json/);
    if (!m) return { ok: false, json: async () => ({}) };
    const fp = path.join(FIX, m[1] + '.json');
    if (!existsSync(fp)) return { ok: false, json: async () => ({}) };
    const data = JSON.parse(readFileSync(fp, 'utf8'));
    return { ok: true, json: async () => data };
  };
}
globalThis.fetch = makeFetch('ok');

/* 以经典脚本方式加载（与浏览器 <script> 等价） */
new Function('window', readFileSync(path.join(ROOT, 'js/util.js'), 'utf8'))(globalThis);
new Function('window', readFileSync(path.join(ROOT, 'js/dict.js'), 'utf8'))(globalThis);

const IR = globalThis.IR;
let passed = 0, total = 0;
const t = async (label, fn) => {
  total++;
  try { await fn(); console.log('  PASS', label); passed++; }
  catch (e) { console.error('  FAIL', label, '\n   →', e.message); process.exitCode = 1; }
};

console.log('— 分片名计算 —');
await t('_shardName：字母首字符', () => {
  assert.equal(IR.dict._shardName('hello'), 'h');
  assert.equal(IR.dict._shardName('Zoo'), 'z');
  assert.equal(IR.dict._shardName("'hood"), 'other');  // 非字母开头
  assert.equal(IR.dict._shardName('123abc'), 'other');
});
await t('_normalize：小写 + 弯撇号归一', () => {
  assert.equal(IR.dict._normalize("Emma’s"), "emma's");
  assert.equal(IR.dict._normalize('HELLO'), 'hello');
  assert.equal(IR.dict._normalize('  Word '), 'word');
});

console.log('— lookup：命中 —');
await t("lookup('hello') 返回音标/释义/词性", async () => {
  const r = await IR.dict.lookup('hello');
  assert(r && r.word === 'hello', 'word=' + (r && r.word));
  assert.equal(r.phonetic, 'həˈləʊ');
  assert(r.meaning.includes('喂'), 'meaning=' + r.meaning);
  assert.equal(r.pos, 'int./n.');
});

console.log('— lookup：词形还原（复用 IR.lemmas） —');
await t("lookup('houses') 经词干还原命中 'house'", async () => {
  const r = await IR.dict.lookup('houses');
  assert(r && r.word === 'house', 'word=' + (r && r.word));
  assert(r.meaning.includes('房屋'), 'meaning=' + r.meaning);
});
await t("lookup('apples') 命中 'apple'", async () => {
  const r = await IR.dict.lookup('apples');
  assert(r && r.word === 'apple');
});

console.log('— lookup：未命中 —');
await t("lookup('zzznotexist') 返回 null", async () => {
  const r = await IR.dict.lookup('zzznotexist');
  assert.equal(r, null);
});
await t('lookup(空) 返回 null', async () => {
  assert.equal(await IR.dict.lookup(''), null);
  assert.equal(await IR.dict.lookup(null), null);
});

console.log('— file:// 降级：fetch 抛错不崩溃 —');
await t('fetch 抛错时 lookup 返回 null（不抛未捕获异常）', async () => {
  IR.dict._resetCache();
  globalThis.fetch = makeFetch('throw');
  let threw = false;
  let r;
  try { r = await IR.dict.lookup('hello'); }
  catch (e) { threw = true; }
  assert.equal(threw, false, 'lookup 不应抛出');
  assert.equal(r, null);
  globalThis.fetch = makeFetch('ok'); // 还原
});

console.log(passed === total ? `\n全部通过（${passed}/${total}）` : `\n存在失败（${passed}/${total}）`);
