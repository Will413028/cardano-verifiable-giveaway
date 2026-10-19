#!/usr/bin/env python3
"""One-off consistency checks for the hardening-and-backend plan.

Usage: python3 check_plan.py [attachment_dir]
"""
import pathlib
import re
import sys

here = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent
plan = (here.parent / f"{here.name}.md").read_text()
inventory = (here / "inventory.md").read_text()
requirements = (here / "requirements.md").read_text()
errors = []

step_numbers = set(re.findall(r"^- \[[ x]\] \*\*(\d+[a-z]?)\. ", plan, re.M))


def rows(text, first_cell):
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells and re.fullmatch(first_cell, cells[0]):
            yield cells


def check_steps(owner, value):
    for ref in re.split(r"[、,]\s*", value):
        if ref != "延後" and ref not in step_numbers:
            errors.append(f"{owner}: unknown step {ref!r}")


step_blocks = {}
for block in re.split(r"^- \[[ x]\] \*\*", plan, flags=re.M)[1:]:
    step_blocks[block.split(".", 1)[0]] = block


def cross_check(owner, value):
    """Every step the attachment assigns must name the ID itself (word boundary, not a prefix)."""
    pattern = re.compile(rf"(?<![\w-]){re.escape(owner)}(?![\w])")
    for ref in re.split(r"[、,]\s*", value):
        if ref in step_blocks and not pattern.search(step_blocks[ref]):
            errors.append(f"{owner}: step {ref} does not name it")


for cells in rows(inventory, r"F\d+"):
    if len(cells) != 6 or not all(cells):
        errors.append(f"{cells[0]}: empty cell")
        continue
    if not re.match(r"(修|接受|等決定)", cells[3]):
        errors.append(f"{cells[0]}: disposition must start with 修／接受／等決定")
    check_steps(cells[0], cells[5])
    if cells[3].startswith("修"):
        cross_check(cells[0], cells[5])

for cells in rows(inventory, r"[^F|-].*"):
    if len(cells) == 3 and cells[0] not in ("行為",) and not cells[2]:
        errors.append(f"behaviour {cells[0]}: empty destination")

for cells in rows(requirements, r"BR-\d+"):
    if len(cells) != 5 or not all(cells):
        errors.append(f"{cells[0]}: empty cell")
        continue
    check_steps(cells[0], cells[4])
    cross_check(cells[0], cells[4])

defined = {cells[0] for cells in rows(requirements, r"BR-\d+")} | {cells[0] for cells in rows(inventory, r"F\d+")}
for ref in sorted(set(re.findall(r"(?<![\w-])(BR-\d+|F\d+)(?![\w])", plan))):
    if ref not in defined:
        errors.append(f"{ref}: named in plan but not defined in attachments")

for match in re.finditer(r"^- \*\*(PD\d+) [^*]+\*\*（([^）]*)）", plan, re.M):
    for field in ("狀態", "擋住步驟", "需要的事實"):
        if field not in match.group(2):
            errors.append(f"{match.group(1)}: missing {field}")

blocks = re.split(r"^- \[[ x]\] \*\*", plan, flags=re.M)[1:]
for block in blocks:
    number = block.split(".", 1)[0]
    if "收尾" in block.split("\n", 1)[0]:
        continue
    for field in ("範圍：", "消費端：", "不能動：", "驗收："):
        if field not in block:
            errors.append(f"step {number}: missing {field}")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"OK: {len(step_numbers)} steps, inventory and requirements consistent")
