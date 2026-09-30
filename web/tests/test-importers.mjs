/* 导入器自动化测试（Node 环境）
   运行：node tests/test-importers.mjs
   覆盖：TXT 编码检测（UTF-8/GBK）、EPUB、MOBI（无压缩/PalmDOC压缩/尾部裁剪）、词表解析 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import assert from 'assert';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

globalThis.window = globalThis;
globalThis.document = { addEventListener() {} }; /* util.js 顶部浏览器监听，测试环境用桩 */
/* 以经典脚本方式加载 JSZip（与应用内 <script> 等价） */
new Function(readFileSync(path.join(ROOT, 'lib/jszip.min.js'), 'utf8'))();
const JSZip = globalThis.JSZip;

/* 以经典脚本方式加载源码（与浏览器一致） */
new Function('window', readFileSync(path.join(ROOT, 'js/util.js'), 'utf8'))(globalThis);
new Function('window', readFileSync(path.join(ROOT, 'js/importers.js'), 'utf8'))(globalThis);
new Function('window', readFileSync(path.join(ROOT, 'js/translate.js'), 'utf8'))(globalThis);

const IR = globalThis.IR;
const S = f => path.join(__dirname, 'samples', f);
const fileLike = (f, name) => {
  const buf = new Uint8Array(readFileSync(S(f)));
  const file = new File([buf], name || f);
  file.text = () => readFileSync(S(f), 'utf8');
  return file;
};

let passed = 0, total = 0;
const t = async (label, fn) => {
  total++;
  try { await fn(); console.log('  PASS', label); passed++; }
  catch (e) { console.error('  FAIL', label, '\n   →', e.message); process.exitCode = 1; }
};

console.log('— TXT 编码检测 —');
await t('UTF-8 TXT 正确解码', async () => {
  const r = await IR.importers.importTxt(fileLike('sample-utf8.txt'));
  assert(r.encoding === 'utf-8', 'encoding=' + r.encoding);
  assert(r.text.includes('quiet village'), r.text.slice(0, 80));
  assert(r.text.includes('undaunted'));
});
await t('GBK TXT 正确解码（无乱码）', async () => {
  const r = await IR.importers.importTxt(fileLike('sample-gbk.txt'));
  assert(r.encoding === 'gb18030', 'encoding=' + r.encoding);
  assert(r.text.includes('少女踏上旅程'), '文本乱码: ' + r.text.slice(0, 60));
  assert(r.text.includes('ambition'));
});
await t('detectEncoding 识别 UTF-8 / GBK 字节序列', () => {
  assert.equal(IR.importers.detectEncoding(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61])), 'utf-8');
  assert.equal(IR.importers.detectEncoding(new TextEncoder().encode('hello world')), 'utf-8');
  assert.equal(IR.importers.detectEncoding(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3])), 'gb18030');
});

console.log('— EPUB —');
await t('EPUB 解包：标题 + 章节顺序 + 行内标签剥离', async () => {
  const r = await IR.importers.importEpub(fileLike('sample.epub'));
  assert.equal(r.title, 'Ascent of Emma');
  assert(r.text.includes('quiet village'));
  assert(r.text.includes('ambition'));
  assert(r.text.includes('trepidation'));
  assert(r.text.includes('undaunted'));
  const paras = r.text.split('\n\n');
  assert(paras.length >= 4, '段落数=' + paras.length);
  assert(!/<\/?[a-z]/i.test(r.text), '残留 HTML 标签');
});

console.log('— MOBI —');
await t('MOBI（无压缩）：标题 + 文本提取', async () => {
  const r = await IR.importers.importMobi(fileLike('sample-mobi.mobi'));
  assert.equal(r.title, 'Ascent of Emma');
  assert(r.text.includes('quiet village'));
  assert(r.text.includes('undaunted'));
});
await t('MOBI（PalmDOC LZ77 压缩 + 尾部数据裁剪）', async () => {
  const r = await IR.importers.importMobi(fileLike('sample-mobi-c.mobi'));
  assert(r.text.includes('trepidation'), r.text.slice(0, 120));
  assert(r.text.includes('icy rock'));
  assert(r.text.includes('narrow path'));
});
await t('PalmDOC 解压缩单元（距离回溯对）', () => {
  /* 手工构造：字面量组 8 个 abcdefgh + 回溯对(dist=8,len=8) → 输出重复 abcdefgh
     PalmDOC 回溯对编码：pair = 0x8000 | (distance<<3) | (length-3)，distance 无 +1（libmobi/KindleUnpack 一致）。
     distance=8, length=8 → pair = 0x8000 | (8<<3) | 5 = 0x8045 */
  const data = new Uint8Array(1 + 8 + 2);
  let p = 0;
  data[p++] = 8; /* 字面量组：8 个（PalmDOC 单组上限） */
  for (let i = 0; i < 8; i++) data[p++] = 'abcdefgh'.charCodeAt(i);
  data[p++] = 0x80; data[p++] = 0x45; /* 回溯对：dist=8, len=8 */
  const out = new TextDecoder().decode(IR.importers._palmDocDecompress(data));
  assert.equal(out, 'abcdefghabcdefgh', 'got: ' + out);
});
await t('MOBI 报错路径：非 MOBI 文件', async () => {
  await assert.rejects(() => IR.importers.importMobi(fileLike('sample-utf8.txt')), /不是 MOBI/);
});
await t('中文 MOBI（GBK 编码 + 字段误标 1252）不乱码', async () => {
  const r = await IR.importers.importMobi(fileLike('sample-mobi-gbk.mobi'));
  assert(r.text.includes('你好，世界'), '解码乱码: ' + r.text.slice(0, 60));
  assert(r.text.includes('雄心'));
  assert(r.toc.some(t => t.title === '第一章'), '标题识别失败: ' + JSON.stringify(r.toc));
});

console.log('— 词表解析 —');
await t('parseVocabLines：多分隔符 + 注释行', () => {
  const rows = IR.importers.parseVocabLines('abandon, 放弃\nambitious\n# 注释\ngive\t给予\nundaunted；无畏的');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].word, 'abandon');
  assert.equal(rows[0].meaning, '放弃');
  assert.equal(rows[2].word, 'give');
  assert.equal(rows[2].meaning, '给予');
  assert.equal(rows[3].meaning, '无畏的');
});

console.log('— 词形还原 —');
await t('lemmas：复数/时态/进行时/比较级', () => {
  assert(IR.lemmas('nurturing').includes('nurture'));
  assert(IR.lemmas('stopped').includes('stop'));
  assert(IR.lemmas('studies').includes('study'));
  assert(IR.lemmas('were').includes('be'));
  assert(IR.lemmas('watches').includes('watch'));
});

console.log('— 翻译签名（M2） —');
/* 旧有道 v2 用 MD5，v3 起 translate.js 已全面改用 SHA-256（见 test-engines），MD5 用例随之移除 */
await t('SHA-256 标准向量（有道 v3 签名格式）', async () => {
  assert.equal(await IR.translate.sha256Hex('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  const long = 'appKey' + 'w'.repeat(30) + '123' + '1700000000' + 'secret';
  assert.equal(await IR.translate.sha256Hex(long), createHash('sha256').update(long).digest('hex'));
});

console.log('— M2.5 新能力（图片/目录/实体/封面元数据） —');
await t('EPUB 图片提取：blocks 含 data:image/png', async () => {
  const r = await IR.importers.importEpub(fileLike('sample.epub'));
  const img = r.blocks.find(b => b.t === 'img' && b.data);
  assert(img, '未找到图片块');
  assert(img.data.startsWith('data:image/png'), img.data.slice(0, 30));
  assert.equal(r.title, 'Ascent of Emma');
  assert(r.author === '' || typeof r.author === 'string');
});
await t('EPUB 目录识别：标题块 → toc', async () => {
  const r = await IR.importers.importEpub(fileLike('sample.epub'));
  assert(r.toc.length >= 1, 'toc 为空');
  assert(r.toc.some(t => t.title === 'Chapter Two'), '未识别到 Chapter Two 标题');
});
await t('htmlToBlocks 正则路径：recindex 图片占位', () => {
  const blocks = IR.importers.htmlToBlocks('<p>hello</p><img recindex="00007" alt="x"/><p>world</p>');
  assert(blocks.length === 3, '块数=' + blocks.length);
  assert.equal(blocks[0].t, 'p');
  assert.equal(blocks[1].t, 'img');
  assert.equal(blocks[1].recindex, '00007');
  assert.equal(blocks[2].text, 'world');
});
await t('decodeEntities：十六进制实体与命名实体', () => {
  assert.equal(IR.importers.decodeEntities('&#x2019;s &amp; &#8212;'), '\u2019s & \u2014');
  assert.equal(IR.importers.decodeEntities('&ldquo;hi&rdquo; &mdash;'), '\u201Chi\u201D \u2014');
});
await t('buildToc：Chapter 模式段落识别', () => {
  const blocks = [
    { t: 'p', text: 'Once upon a time' },
    { t: 'h', text: 'Chapter 1' },
    { t: 'p', text: 'CHAPTER 2 - The Road' },
    { t: 'p', text: '第3章 启程' },
    { t: 'p', text: 'a normal sentence' }
  ];
  const toc = IR.importers.buildToc(blocks);
  assert.equal(toc.length, 3, 'toc 长度=' + toc.length);
  assert.deepEqual(toc.map(t => t.bi), [1, 2, 3]);
});
await t('_extractImage：记录内偏移定位图片签名', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const rec = new Uint8Array([0x00, 0x00, 0x00, 0x00, ...png]);
  const r = IR.importers._extractImage(rec);
  assert(r && r.mime === 'image/png' && r.offset === 4, JSON.stringify(r));
  const bad = IR.importers._extractImage(new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(bad, null);
});
await t('sniffMime：JPEG/PNG/GIF 识别', () => {
  assert.equal(IR.importers.sniffMime(new Uint8Array([0xFF, 0xD8, 0xFF])), 'image/jpeg');
  assert.equal(IR.importers.sniffMime(new Uint8Array([0x89, 0x50, 0x4E, 0x47])), 'image/png');
  assert.equal(IR.importers.sniffMime(new Uint8Array([0x47, 0x49, 0x46])), 'image/gif');
  assert.equal(IR.importers.sniffMime(new Uint8Array([1, 2, 3])), null);
});

console.log(passed === total ? `\n全部通过（${passed}/${total}）` : `\n存在失败（${passed}/${total}）`);
