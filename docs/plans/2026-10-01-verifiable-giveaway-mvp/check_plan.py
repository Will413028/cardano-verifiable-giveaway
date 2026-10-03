#!/usr/bin/env python3
"""One-off structural checks for the verifiable-giveaway MVP phase plan.

Usage (from any directory):
  python3 check_plan.py              # plan + requirements + public-safety checks
  python3 check_plan.py --validation # step 1: validation.md has evidence for every risk
  python3 check_plan.py --spike-c    # step 4: attack-scenario table has no empty cells
  python3 check_plan.py --nfr        # step 9: no NFR threshold left as a proposal

Optional: --dir <attachments dir> to run against a copy (used for mutation tests).
Exit code 0 = pass, 1 = findings printed.
"""
import argparse
import pathlib
import re
import sys

STEP_FIELDS = ["範圍：", "消費端：", "不能動：", "驗收：", "停止條件："]
DECISION_FIELDS = ["狀態：", "擋住步驟：", "需要的事實：", "建議", "結論："]
# Local filesystem paths and mail addresses must never reach the public repo.
FORBIDDEN = ["/Users/", "/private/tmp", "/home/", ".projects/", "wiki/", "daily/", "AGENTS.local", "@gmail"]


def fail(msgs):
    for m in msgs:
        print("FAIL:", m)
    return 1 if msgs else 0


def table_rows(text, header_startswith):
    """Return rows (list of cells) of the first markdown table whose header starts with the prefix."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith(header_startswith):
            rows = []
            for row in lines[i + 2:]:
                if not row.startswith("|"):
                    break
                rows.append([c.strip() for c in row.strip().strip("|").split("|")])
            return rows
    return None


def split_blocks(text, pattern):
    """Split text into blocks starting at lines matching pattern; return {id: block}."""
    blocks, cur_id, buf = {}, None, []
    for line in text.splitlines():
        m = re.match(pattern, line)
        if m:
            if cur_id is not None:
                blocks[cur_id] = "\n".join(buf)
            cur_id, buf = m.group(1), [line]
        elif cur_id is not None:
            if line.startswith("## ") or line.startswith("拍板順序"):
                blocks[cur_id] = "\n".join(buf)
                cur_id, buf = None, []
            else:
                buf.append(line)
    if cur_id is not None:
        blocks[cur_id] = "\n".join(buf)
    return blocks


def check_main(d: pathlib.Path):
    msgs = []
    plan = d.parent / (d.name + ".md")
    req = d / "requirements.md"
    for p in (plan, req):
        if not p.exists():
            return fail([f"missing {p.name}"])
    ptext, rtext = plan.read_text(), req.read_text()

    if "<!--" in ptext:
        msgs.append("plan still contains an HTML comment (template header)")

    # Steps
    steps = split_blocks(ptext, r"^- \[[ x]\] \*\*(\d+)\. ")
    if not steps:
        msgs.append("no steps found")
    for sid, block in steps.items():
        if "被擋於：" not in block.splitlines()[0]:
            msgs.append(f"step {sid}: header lacks 被擋於")
        for f in STEP_FIELDS:
            if sid == max(steps, key=int) and f == "停止條件：":
                continue  # closing step needs no stop condition
            if f not in block:
                msgs.append(f"step {sid}: missing {f}")
        if "確認正常" in block:
            msgs.append(f"step {sid}: undecidable acceptance wording 確認正常")
    last = max(steps, key=int) if steps else None
    if last and "收尾" not in steps[last].splitlines()[0]:
        msgs.append("last step is not 收尾")

    # Progress table rows match steps
    prog = table_rows(ptext, "| 步驟 | 狀態 |")
    prog_ids = {re.match(r"(\d+)", r[0]).group(1) for r in (prog or []) if re.match(r"\d+", r[0])}
    if prog_ids != set(steps):
        msgs.append(f"progress rows {sorted(prog_ids, key=int)} != steps {sorted(steps, key=int)}")

    # Decisions
    decisions = split_blocks(ptext, r"^- \*\*(D\d+) ")
    if not decisions:
        msgs.append("no decisions found")
    for did, block in decisions.items():
        for f in DECISION_FIELDS:
            if f not in block:
                msgs.append(f"{did}: missing {f}")
        opts = re.findall(r"^\s+- [A-Z]：", block, re.M)
        if len(opts) < 2:
            msgs.append(f"{did}: fewer than two options")
        if "已決" not in block and "未決" not in block:
            msgs.append(f"{did}: status neither 未決 nor 已決")
        if "狀態：未決" in block and "結論：未決" not in block:
            msgs.append(f"{did}: status 未決 but conclusion filled (decided on the owner's behalf?)")
    order = ptext.split("拍板順序", 1)
    if len(order) < 2:
        msgs.append("missing 拍板順序")
    else:
        for did in decisions:
            if not re.search(rf"\b{did}\b", order[1].split("## 進度")[0]):
                msgs.append(f"{did} not placed in 拍板順序")
    # Every "被擋於" decision reference exists
    for sid, block in steps.items():
        for ref in re.findall(r"D\d+", block.splitlines()[0]):
            if ref not in decisions:
                msgs.append(f"step {sid}: blocked by unknown {ref}")

    # Requirements: each row maps to existing steps or 不做/延後
    rows = table_rows(rtext, "| ID | 類別 |")
    if not rows:
        msgs.append("requirements table not found")
    for r in rows or []:
        rid, target = r[0], r[-1]
        if not target:
            msgs.append(f"{rid}: empty 對應")
            continue
        if target in ("不做", "延後"):
            continue
        for n in re.findall(r"\d+", target):
            if n not in steps:
                msgs.append(f"{rid}: maps to unknown step {n}")
        if not re.findall(r"\d+", target):
            msgs.append(f"{rid}: 對應 '{target}' is neither steps nor 不做/延後")
        if "推論" in r[3] and not re.search(r"D\d+", r[3]):
            msgs.append(f"{rid}: inferred requirement not tied to a decision")

    # Paraphrased source rows must be marked
    src = table_rows(rtext, "| 編號 | 來源句 |") or []
    for r in src:
        if r[0].startswith("N") and "（摘要）" not in r[1]:
            msgs.append(f"source {r[0]}: paraphrase not marked （摘要）")

    # Public safety across plan and attachments
    files = [plan] + sorted(p for p in d.rglob("*") if p.is_file() and p.suffix in (".md", ".py"))
    for p in files:
        if p.name == "check_plan.py":
            continue
        t = p.read_text()
        for s in FORBIDDEN:
            if s in t:
                msgs.append(f"{p.name}: forbidden string {s!r}")
    return fail(msgs)


def check_validation(d):
    p = d / "validation.md"
    if not p.exists():
        return fail(["validation.md missing"])
    rows = table_rows(p.read_text(), "| 風險 |") or []
    risks = table_rows((d / "requirements.md").read_text(), "| 風險 | 目前證據 |") or []
    msgs = []
    names = {r[0] for r in rows}
    for risk in risks:
        if risk[0] not in names:
            msgs.append(f"validation.md lacks risk row: {risk[0]}")
    for r in rows:
        if len(r) < 4 or any(not c for c in r[:4]):
            msgs.append(f"validation row incomplete: {r}")
    return fail(msgs)


def check_spike_c(d):
    p = d / "spike-c.md"
    if not p.exists():
        return fail(["spike-c.md missing"])
    rows = table_rows(p.read_text(), "| 攻擊劇本 |") or []
    msgs = [] if rows else ["attack table missing"]
    for r in rows:
        if any(not c for c in r):
            msgs.append(f"empty cell in attack row: {r[0]}")
        for c in r[1:]:
            m = re.match(r"(擋住|擋不住)[：:，,（(\s]*(.*)", c)
            if not m or len(m.group(2).strip()) < 2:
                msgs.append(f"attack row {r[0]}: cell must start with 擋住/擋不住 plus a reason: {c!r}")
    return fail(msgs)


def check_nfr(d):
    t = (d / "requirements.md").read_text()
    msgs = ["NFR still has a proposal threshold"] if "提案（未決）" in t else []
    for r in table_rows(t, "| 項目 | 門檻 |") or []:
        if "未決" in r[1] and not re.search(r"D\d+|延後", r[2]):
            msgs.append(f"NFR {r[0]}: 未決 without an owning decision or 延後")
    return fail(msgs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(pathlib.Path(__file__).resolve().parent))
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--validation", action="store_true")
    g.add_argument("--spike-c", action="store_true")
    g.add_argument("--nfr", action="store_true")
    a = ap.parse_args()
    d = pathlib.Path(a.dir).resolve()
    if a.validation:
        rc = check_validation(d)
    elif a.spike_c:
        rc = check_spike_c(d)
    elif a.nfr:
        rc = check_nfr(d)
    else:
        rc = check_main(d)
    if rc == 0:
        print("OK")
    sys.exit(rc)


if __name__ == "__main__":
    main()
