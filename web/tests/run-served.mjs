/* 需要本地转发服务的测试一键跑：自己拉起 serve.py，跑完自动关掉。
   用法：node web/tests/run-served.mjs
   可选环境变量：PY=<python 可执行文件路径>（默认取 PATH 里的 python） */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PY = process.env.PY || 'python';

/* 每个测试脚本需要的端口（与各自文件头注释一致） */
const TESTS = [
  { file: 'test-proxy.mjs', port: 8644 },
  { file: 'test-store.mjs', port: 8645 },
  { file: 'test-web.mjs', port: 8647 }
];

const servers = TESTS.map(t => spawn(PY, [path.join(ROOT, 'web/tools/serve.py'), String(t.port), '--no-open'], {
  stdio: 'ignore', detached: false
}));
const kill = () => servers.forEach(s => { try { s.kill(); } catch { /* 已退出 */ } });
process.on('exit', kill);
process.on('SIGINT', () => { kill(); process.exit(130); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2500);

let failed = 0, total = 0;
for (const t of TESTS) {
  const out = await new Promise(resolve => {
    let buf = '';
    const p = spawn(process.execPath, [path.join(__dirname, t.file)], { env: { ...process.env } });
    p.stdout.on('data', d => buf += d);
    p.stderr.on('data', d => buf += d);
    p.on('close', () => resolve(buf));
  });
  const lines = out.trim().split('\n');
  const bad = lines.filter(l => /^FAIL[ ]/.test(l));      /* 注意别把 "FAILS=0/18" 这种汇总行算进去 */
  const tail = lines[lines.length - 1] || '(无输出)';
  total += lines.length;
  failed += bad.length;
  console.log(`===== ${t.file} (端口 ${t.port})`);
  bad.forEach(l => console.log('  ' + l));
  console.log('  ' + tail);
}
kill();
console.log(failed ? `FAILS=${failed}` : '全部通过');
process.exit(failed ? 1 : 0);
