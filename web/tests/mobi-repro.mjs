/* 复现：导入真实的 Boundless.mobi，打印确切错误与诊断 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const target = process.argv[2] || 'C:\\Users\\admin\\Desktop\\READ\\Boundless (R. A. Salvatore) .mobi';

globalThis.window = globalThis;
globalThis.document = { addEventListener() {} };
new Function('window', readFileSync(path.join(ROOT, 'js/util.js'), 'utf8'))(globalThis);
new Function('window', readFileSync(path.join(ROOT, 'js/importers.js'), 'utf8'))(globalThis);
const IR = globalThis.IR;

const raw = readFileSync(target);
const buf = new Uint8Array(raw);
const file = new File([buf], path.basename(target));

/* 头部速览（PDB） */
const u16 = o => (buf[o] << 8) | buf[o + 1];
const u32 = o => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
const lines = [];
lines.push('file=' + path.basename(target) + '  size=' + buf.length + ' bytes');
lines.push('PDB type="' + String.fromCharCode(...buf.subarray(60, 68)) + '" creator="' + String.fromCharCode(...buf.subarray(68, 72)) + '"');
lines.push('numRecords=' + u16(76));
const n = u16(76);
const recOffsets = [];
for (let i = 0; i < Math.min(n, 8); i++) recOffsets.push(u32(78 + i * 8));
lines.push('first record offsets=' + recOffsets.join(','));
try {
  const book = await IR.importers.importMobi(file);
  lines.push('OK title=' + book.title + ' author=' + book.author + ' blocks=' + (book.blocks || []).length +
    ' textLen=' + (book.text || '').length + ' toc=' + ((book.toc || []).length));
  lines.push('首段预览: ' + (book.blocks || []).slice(0, 2).map(b => (b.text || '').slice(0, 60)).join(' || '));
} catch (e) {
  lines.push('EOF:');
  lines.push('ERROR: ' + e.message);
  lines.push('STACK: ' + (e.stack || '').split('\n').slice(0, 4).join(' | '));
}
/* 清洗控制字符，避免日志被识别为二进制 */
const text = lines.join('\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '·');
import('fs').then(m => m.writeFileSync(path.join(__dirname, 'mobi.log'), text, 'utf8'));
process.stdout.write(text + '\n');
