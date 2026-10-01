#!/usr/bin/env python3
# 墨读 InkRead — 常用词组索引构建（数据驱动词组识别 / 词组离线翻译）
#
# 数据源：与离线词典同源的 ECDICT（tools/cache/ecdict.csv）。ECDICT 里除单词外
# 还收录了大量「多词条目」（tear down / come up with / in spite of / of course …）。
# 直接全量收录会有两个问题：① 绝大多数多词条目是专业术语（译文以 [医]/[化]/[机]/[计]
# 等领起），② 剩下的还有海量「名词性复合词」（sea bird / consulting firm），
# 这些都不是学习者眼中的「词组」。因此这里做两级过滤：
#   ① 领域术语过滤：译文首行以 [xx] / 【xx】 领起的，判为专业术语，剔除；
#   ② 功能词过滤：词组中必须含至少一个功能词（介词/小品词/冠词/代词/连词/助动词…），
#      从而保留「结构性/习语性」单位，剔除名词性复合词。
# 另外剔除含 ECDICT 占位符 sb / sth 的词条。
#
# 产出 web/dict/phrases.js → window.IR_PHRASES = { "tear down": "拆毁；拆除", ... }
# （单文件、可用 <script> 加载，file:// 与 http:// 均可用；仅存短语与中文释义）
# 幂等：目标文件已存在且非空时跳过；--force 重生成。
# 用法：python build_phrases.py [--force]
import csv
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
CSV = os.path.join(SCRIPT_DIR, "cache", "ecdict.csv")
OUT_JS = os.path.join(ROOT, "dict", "phrases.js")

TOKEN = r"[a-z][a-z'\-]*"
PHRASE_RE = re.compile(r"^%s(?: %s){1,3}$" % (TOKEN, TOKEN))
DOMAIN_LINE = re.compile(r"^\s*(\[[^\]]{1,8}\]|【[^】]{1,8}】)")
PLACEHOLDER = {"sb", "sth"}

FUNC = set((
    "a an the this that these those it its he she they we you i me him her them us my your his our their "
    "of to in on at by for with from into onto upon over under above below between among through across "
    "along around about against after before behind beside beyond during without within up down out off "
    "away back forward together apart aside as than is are was were be been being am do does did done have "
    "has had and or but not no so if when while where which who whom whose what all any some each every "
    "both either neither more most less least very too just only also even still yet ever never again once "
    "there here now then per via"
).split())

MEANING_CAP = 80


def _lines(t):
    """ECDICT 少数译文里用字面「\\n」分隔，先还原成真换行再按行拆。"""
    return t.replace("\\r", "").replace("\\n", "\n").split("\n")


def clean_meaning(t):
    """按行拆分 → 去掉领域标签 → 去重复/被包含的子串 → 控制长度。"""
    parts = []
    for ln in _lines(t):
        s = DOMAIN_LINE.sub("", ln).strip()
        s = re.sub(r"\s+", " ", s).strip()
        if s:
            parts.append(s)
    # 同一个词条常出现「通用释义」＋「[xx] 同义」两行，去掉被更完整释义包含的短串
    parts = [p for i, p in enumerate(parts)
             if not any(i != j and p != q and p in q for j, q in enumerate(parts))]
    seen = []
    for p in parts:
        if p not in seen:
            seen.append(p)
    return "；".join(seen)[:MEANING_CAP]


def first_line_tagged(t):
    return bool(DOMAIN_LINE.match(_lines(t)[0]))


def main():
    force = "--force" in sys.argv
    if os.path.exists(OUT_JS) and os.path.getsize(OUT_JS) > 0 and not force:
        print("[skip] %s 已存在（用 --force 重新生成）" % OUT_JS)
        return
    if not os.path.exists(CSV):
        print("[error] 未找到 %s，请先运行 download_dict.py" % CSV, file=sys.stderr)
        sys.exit(1)

    out = {}
    seen = 0
    kept = 0
    with open(CSV, encoding="utf-8", errors="replace", newline="") as f:
        for r in csv.DictReader(f):
            w = (r.get("word") or "").strip()
            if not w or " " not in w or w != w.lower() or not PHRASE_RE.match(w):
                continue
            seen += 1
            toks = w.split(" ")
            if any(x in PLACEHOLDER for x in toks):
                continue
            if not any(x in FUNC for x in toks):
                continue
            t = (r.get("translation") or "").strip()
            if not t or first_line_tagged(t):
                continue
            m = clean_meaning(t)
            if not m:
                continue
            out[w] = m
            kept += 1

    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    with open(OUT_JS, "w", encoding="utf-8") as fo:
        fo.write("window.IR_PHRASES=" + body + ";\n")
    size = os.path.getsize(OUT_JS)
    print("[ok] 多词条目 %d → 保留常用词组 %d" % (seen, kept))
    print("[ok] %s  %.2f MB" % (OUT_JS, size / 1048576))


if __name__ == "__main__":
    main()
