#!/usr/bin/env python3
# 墨读 InkRead — M3 词典分片构建
# 读取 tools/cache/ecdict.csv，清理后按首字母分片输出到 web/dict/：
#   a.json ... z.json（26 个）+ other.json（非字母开头）
# 每个文件结构：{ "word": {"p":"音标","t":"中文释义","pos":"词性"}, ... }
#   - 字段名简短以省体积；word 全小写为 key
#   - 只保留 word 形如英文单词（字母/撇号/连字符/点）、且 translation 非空的词条
#   - 可选频率过滤：--freq 只保留 frq>0 或 bnc>0 的常用词（用于把体积压到预算内）
# 幂等：若 web/dict/ 下 27 个分片均已存在且非空，则跳过。
# 用法：python build_dict.py [--freq] [--force]
import os
import sys
import csv
import json
import re
import glob

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
CSV = os.path.join(SCRIPT_DIR, "cache", "ecdict.csv")
DICT_DIR = os.path.join(ROOT, "dict")

# 仅保留“像英文单词”的条目：首字符为字母，且只包含字母/撇号/连字符/点
WORD_RE = re.compile(r"^[a-z][a-z'.\-]*$")
SHARDS = [chr(ord("a") + i) for i in range(26)] + ["other"]


def shard_of(word):
    ch = word[0]
    return ch if ch.isalpha() else "other"


def already_built():
    if not os.path.isdir(DICT_DIR):
        return False
    for s in SHARDS:
        p = os.path.join(DICT_DIR, s + ".json")
        if not os.path.exists(p) or os.path.getsize(p) == 0:
            return False
    return True


def main():
    use_freq = "--freq" in sys.argv
    force = "--force" in sys.argv
    if not os.path.exists(CSV):
        print("[error] 未找到 %s，请先运行 download_dict.py" % CSV, file=sys.stderr)
        sys.exit(1)
    if already_built() and not force:
        print("[skip] web/dict/ 分片已存在，跳过（用 --force 重新生成）")
        return

    os.makedirs(DICT_DIR, exist_ok=True)
    shards = {s: {} for s in SHARDS}
    kept = skipped = 0

    with open(CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            word = (row.get("word") or "").strip()
            if not word:
                continue
            lw = word.lower()
            if not WORD_RE.match(lw):
                skipped += 1
                continue
            trans = (row.get("translation") or "").strip()
            if not trans:
                skipped += 1
                continue
            if use_freq:
                try:
                    if not (int(row.get("frq") or 0) > 0 or int(row.get("bnc") or 0) > 0):
                        skipped += 1
                        continue
                except ValueError:
                    pass
            rec = {"t": trans}
            phon = (row.get("phonetic") or "").strip()
            if phon:
                rec["p"] = phon
            pos = (row.get("pos") or "").strip()
            if pos:
                rec["pos"] = pos
            shards[shard_of(lw)][lw] = rec
            kept += 1

    total = 0
    for s in SHARDS:
        data = shards[s]
        fn = os.path.join(DICT_DIR, s + ".json")
        with open(fn, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, separators=(",", ":"))
        size = os.path.getsize(fn)
        total += size
        print(f"  {s}.json  {len(data):>7} 词  {size//1024:>6} KB")

    print(f"[ok] 保留 {kept} 词，跳过 {skipped} 词")
    print(f"[ok] 分片总大小 {total//1024//1024} MB ({total} 字节)"
          + ("（已启用 --freq 频率过滤）" if use_freq else ""))


if __name__ == "__main__":
    main()
