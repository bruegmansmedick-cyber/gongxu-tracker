# -*- coding: utf-8 -*-
"""
把三份「循环作业」Word 日志解析成结构化记录与实测统计。

用途：一次性数据准备 + 以后新增日志时重跑。
输入：桌面「循环作业记录工时」目录下的三份 .docx
输出：src/db/data/loop-history.json

运行：python scripts/parse_loop_logs.py
"""
import json
import os
import re
import statistics as st
import sys
import zipfile
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "src", "db", "data", "loop-history.json")
REVIEW_CSV = os.path.join(ROOT, "docs", "循环作业解析复核清单.csv")
SRC_DIR = r"C:\Users\Administrator\Desktop\循环作业记录工时"

FILES = [
    ("zd1", "1#施工支洞", "1#施工支洞循环作业施工记录.docx"),
    ("tf", "通风兼安全洞", "通风洞循环作业.docx"),
    ("zs", "闸室交通洞", "闸室交通洞循环作业.docx"),
]

# ---------------------------------------------------------------- 工序字典
# key, 名称, 所属循环(开挖/支护)
PROCESS_DICT = [
    ("m-survey", "测量放样（爆破孔）", "exc"),
    ("m-drill", "钻孔（爆破孔）", "exc"),
    ("m-check", "爆破孔验收", "exc"),
    ("m-blast", "装药爆破", "exc"),
    ("m-vent", "通风散烟", "exc"),
    ("m-muck", "出渣", "exc"),
    ("m-scale", "扒渣排险", "exc"),
    ("m-geo", "超前地质预报", "exc"),
    ("m-other", "洞内辅助作业（排水/清理）", "exc"),
    ("s-survey", "测量放样（锚杆孔）", "sup"),
    ("s-drill", "锚杆孔钻孔", "sup"),
    ("s-blow", "吹孔", "sup"),
    ("s-check", "锚杆孔验收", "sup"),
    ("s-rod", "锚杆插杆", "sup"),
    ("s-grout", "锚杆注浆", "sup"),
    ("s-mesh", "挂钢筋网", "sup"),
    ("s-meshcheck", "网片验收", "sup"),
    ("s-shot", "喷护", "sup"),
    ("s-clean", "清理回弹料", "sup"),
]
NAME_OF = {k: n for k, n, _ in PROCESS_DICT}
PROCESS_KEYS = {k for k, _, _ in PROCESS_DICT}

# 等待/故障类（不生成记录，作为下一条工序的"开工前等待原因"）
REASON_DICT = [
    ("explosive", "等炸药 / 火工品", r"等药|炸药系统|炸药出库|爆破公司|等炮"),
    ("shotcrete", "等喷浆料", r"等补方|湿喷料|拌合楼|拌合站|等料"),
    ("repair", "设备故障维修", r"损坏|维修|跳闸|故障|没电"),
    ("occupied", "机械被其他工作面占用", r"装载机.*(出渣|材料)|挖机.*(出渣|占用)"),
    ("inspect", "等验收", r"等.*验收|通知验收|验收.*到场"),
    ("measure", "等测量", r"等测量|测量.*到场"),
    ("cross", "交叉作业干扰", r"交叉|占用|影响施工"),
    ("rework", "欠挖 / 补炮返工", r"欠挖|补炮|返工|塌孔|废孔"),
    ("prep", "交接班 / 班前准备", r"就位|到场|准备|清洗|推台车到掌子面"),
]
REASON_KEYS = {k for k, _, _ in REASON_DICT}

# 人工复核后的强制归类：原文片段 -> 工序 key
MANUAL = {
    # 1#施工支洞
    "打系统锚杆孔": "s-drill",
    "22:20～22:55放样0+28.3～33.7段锚杆孔": "s-survey",
    "锚杆孔吹孔": "s-blow",
    "验收锚杆孔锚杆": "s-check",
    "挂网等装载机转材料注浆": "s-grout",
    "转材料挂网锚杆注浆": "s-grout",
    "钢筋网片验收": "s-meshcheck",
    "退台车，湿喷车进场": "s-clean",
    "扒渣清理回弹料，推台车": "s-clean",
    "等药（炸药系统维护无法出库）": "explosive",
    "爆破公司10：50到场": "explosive",
    "测量放样0+33.7～36.4段爆破孔": "m-survey",
    "收断面放锚杆孔": "s-survey",
    "准备注浆材料": "s-grout",
    "清洗注浆机，准备挂网材料": "s-clean",
    "等待湿喷料": "shotcrete",
    "清理回弹料": "s-clean",
    "0+41.4~0+44.1段打爆破孔": "m-drill",
    "人工排险接风水管": "m-scale",
    "测量放锚杆点": "s-survey",
    "推台车到掌子面": "s-clean",
    "吹孔，准备材料": "s-blow",
    "三方验收岩石断面": "m-check",
    "等料": "shotcrete",
    "0+31~0+041.8段打锚杆孔": "s-drill",
    "验孔": None,  # 由上下文判定
    "安装水泵抽排水": "m-other",
    # 通风兼安全洞
    "推台车吹0+456～0+459段锚杆孔排水孔": "s-blow",
    "验收锚杆孔排水孔": "s-check",
    "装载机转注浆机注浆材料": "s-grout",
    "补打锚杆孔排水孔锚杆补打注浆": "s-grout",
    "钻机损坏维修": "repair",
    "推台车到掌子面": "s-clean",
    "补打锚杆注浆5根网片调整": "s-mesh",
    "验收网片": "s-meshcheck",
    "等补方，营地拌合楼损坏打不了喷浆料": "shotcrete",
    "清洗湿喷车，挖机扒渣": "s-clean",
    "测量放样收断面": "m-survey",
    "4方验收": "m-check",
    "测量放样锚杆孔": "s-survey",
    "转材料推台车": "s-clean",
    "挂网插锚杆安装排水管": "s-mesh",
    "锚杆注浆0+459.4～466.3段钢筋网片绑扎": "s-mesh",
    "网片验收": "s-meshcheck",
    "清台车，湿喷车进场": "s-clean",
    "扒渣清理回弹料推台车到掌子面": "s-clean",
    "验锚杆孔排水孔": "s-check",
    "转材料加工锚杆顶拱插锚杆": "s-mesh",
    "0+466～0+472段挂网片": "s-mesh",
    "退台车进湿喷台车": "s-clean",
    "拌合楼14:00损坏维修，等待湿喷料": "shotcrete",
    "推台车测量放样": "m-survey",
    "爆破孔放样，安装风管": "m-survey",
    "单臂钻损坏维修": "repair",
    "开挖班就位": "prep",
    "测量扫断面，放样锚杆孔": "s-survey",
    "钻车损坏维修": "repair",
    "1#洞装药，系统问题需要重新出库": "explosive",
    # 闸室交通洞
    "打锁扣锚杆": "s-drill",
    "锁口锚杆注浆": "s-grout",
    "现场查看使用32锚杆": "s-grout",
    "补打塌孔锚杆孔": "s-drill",
    "加工6根锚杆并转运": "s-rod",
    "塌孔补打": "s-drill",
    "调整台车": "s-clean",
    "下层爆破孔放点": "m-survey",
    "下层打爆破孔": "m-drill",
    "吹孔": "m-drill",
    "底板塌孔重新打眼": "m-drill",
    "装药响炮": "m-blast",
    "扒断面出渣排险": "m-muck",
    "接风管打地质探测孔": "m-geo",
    "做超前地质预报": "m-geo",
    "准备钻机，台车风水管安装": "prep",
    "增压泵跳闸": "repair",
}

TIME_RE = re.compile(r"^(\d{1,2})\s*[:：]\s*(\d{2})\s*[~～\-—－]\s*[-~～]?\s*(\d{1,2})\s*[:：]\s*(\d{2})")
DATE_RES = [
    re.compile(r"^(?:20(\d{2})\s*[.\-年]\s*)?(\d{1,2})\s*[.\-月]\s*(\d{1,2})\s*[日.]?$"),
]
LOC_RE = re.compile(r"(\d+\s*\+\s*\d+(?:\.\d+)?)\s*[~～\-—]\s*(\d+\s*\+\s*\d+(?:\.\d+)?)")
BARE_LOC_RE = re.compile(r"^(\d+\s*\+\s*\d+(?:\.\d+)?)\s*[~～\-—]\s*(\d+\s*\+\s*\d+(?:\.\d+)?)\s*(?:段)?$")


def doc_lines(path):
    """按段落读取 docx 文本（含表格行）"""
    xml = zipfile.ZipFile(path).read("word/document.xml").decode("utf-8", "ignore")
    body = xml.split("<w:body>", 1)[-1]
    out = []
    for m in re.finditer(r"<w:tbl>.*?</w:tbl>|<w:p\b.*?</w:p>|<w:p\b[^>]*/>", body, re.S):
        chunk = m.group(0)
        if chunk.startswith("<w:tbl"):
            for tr in re.findall(r"<w:tr\b.*?</w:tr>", chunk, re.S):
                cells = []
                for tc in re.findall(r"<w:tc>.*?</w:tc>", tr, re.S):
                    cells.append("".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", tc, re.S)).strip())
                line = " | ".join([c for c in cells if c])
                if line:
                    out.append(line)
        else:
            t = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", chunk, re.S)).strip()
            if t:
                out.append(t)
    return out


def norm(s):
    return s.replace("：", ":").replace("～", "~").replace("—", "-").replace("－", "-").replace("，", ",").replace("　", " ")


def parse_date(line):
    t = line.strip().strip(".").replace("月", ".").replace("日", "")
    m = re.match(r"^(?:(\d{4})[.\-年])?(\d{1,2})[.\-](\d{1,2})$", t)
    if not m:
        return None
    year = int(m.group(1)) if m.group(1) else 2026
    mm = int(m.group(2))
    dd = int(m.group(3))
    if 1 <= mm <= 12 and 1 <= dd <= 31:
        return date(year, mm, dd)
    return None


def classify(text, family_hint):
    """按关键词 + 上下文判断工序 key（只返回工序，不返回等待原因）"""
    s = text
    for frag, key in MANUAL.items():
        if frag in s and key in PROCESS_KEYS:
            return key

    has = lambda *kw: any(k in s for k in kw)

    # 验收类
    if has("验收", "验孔"):
        if has("网"):
            return "s-meshcheck"
        if has("锚杆", "排水"):
            return "s-check"
        if has("爆破", "炮", "孔"):
            return "m-check"
        if has("断面"):
            return "m-survey"
        return "m-check" if family_hint == "exc" else "s-check"

    if has("注浆"):
        return "s-grout"
    if has("挂网", "钢筋网", "网片", "绑扎"):
        return "s-mesh"
    if has("喷护", "喷射混凝土", "喷混凝土", "湿喷"):
        return "s-shot"
    if has("锚杆孔", "锚杆钻孔", "打锚杆", "锚杆补打"):
        return "s-drill"
    if has("插杆", "锚杆安装", "安装排水管", "加工锚杆"):
        return "s-rod"
    if has("清理回弹料", "清台车", "退台车", "推台车", "清洗"):
        return "s-clean"
    if has("地质预报", "地质探测", "超前地质"):
        return "m-geo"
    if has("测量放样", "放样", "放点", "扫断面", "收断面", "测量"):
        if has("锚杆", "排水"):
            return "s-survey"
        if has("爆破", "炮"):
            return "m-survey"
        return "s-survey" if family_hint == "sup" else "m-survey"
    if has("装药", "响炮", "放炮", "联炮"):
        return "m-blast"
    if has("出渣"):
        return "m-muck"
    if has("吹孔"):
        return "m-drill"
    if has("扒渣", "排险", "欠挖", "补炮", "危石", "撬毛"):
        return "m-scale"
    if has("通风散烟", "散烟"):
        return "m-vent"
    if has("爆破孔", "打孔", "钻孔", "打眼", "钻眼"):
        return "m-drill"
    return None


def classify_reason(text):
    for frag, key in MANUAL.items():
        if frag in text and key in REASON_KEYS:
            return key
    for key, _, pattern in REASON_DICT:
        if re.search(pattern, text):
            return key
    return None


def parse_file(face_key, face_name, filename):
    path = os.path.join(SRC_DIR, filename)
    lines = [norm(x) for x in doc_lines(path)]
    records = []
    unclassified = []
    cur_date = None
    cur_loc = ""
    pending_reason = None
    family_hint = None

    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        d = parse_date(line)
        if d:
            cur_date = d
            i += 1
            continue
        m = BARE_LOC_RE.match(line)
        if m:
            cur_loc = f"{m.group(1)}~{m.group(2)}"
            i += 1
            continue
        tm = TIME_RE.match(line)
        if not tm:
            i += 1
            continue

        sh, sm, eh, em = (int(tm.group(k)) for k in range(1, 5))
        desc = line[tm.end():]
        # 描述可能被拆到下一行
        j = i + 1
        while j < len(lines):
            nxt = lines[j].strip()
            if not nxt or parse_date(nxt) or TIME_RE.match(nxt) or BARE_LOC_RE.match(nxt):
                break
            desc += " " + nxt
            j += 1
        desc = desc.strip(" ,、.")
        i = j

        start_day = cur_date
        if start_day is None:
            start_day = date(2026, 9, 16)
        start_shift = 0
        if sh >= 24:
            start_shift = 1
            sh -= 24
        end_shift = 0
        if eh >= 24:
            end_shift = 1
            eh -= 24
        start_day = start_day + timedelta(days=start_shift)
        start_min = sh * 60 + sm
        end_min = eh * 60 + em + (end_shift - start_shift) * 1440
        cross = False
        if end_min <= start_min:
            end_min += 1440
            cross = True
        hours = (end_min - start_min) / 60.0
        start_at = "%02d:%02d" % (sh, sm)
        end_at = "%02d:%02d" % (eh, em)
        item_text = line + " " + desc
        loc = cur_loc
        lm = LOC_RE.search(item_text)
        if lm:
            loc = f"{lm.group(1)}~{lm.group(2)}"

        key = classify(item_text, family_hint)
        line_reason = classify_reason(item_text)

        if key is None:
            # 等待 / 故障 / 准备类：不生成记录，作为下一条工序的开工前等待原因
            pending_reason = line_reason or pending_reason
            if not line_reason:
                unclassified.append(f"{face_name} {start_day} {start_at}-{end_at} {item_text[:60]}")
            continue

        family = next((f for k, _, f in PROCESS_DICT if k == key), None)
        if family:
            family_hint = family
        abnormal = hours > 12 or hours < 0.08
        records.append(
            {
                "face": face_key,
                "key": key,
                "date": start_day.isoformat(),
                "startTime": start_at,
                "endTime": end_at,
                "crossMidnight": cross,
                "hours": round(hours, 4),
                "location": loc,
                "reason": pending_reason or line_reason,
                "abnormal": abnormal,
                "note": item_text[:120],
            }
        )
        pending_reason = None

    return records, unclassified


def main():
    all_records = []
    all_unclassified = []
    for face_key, face_name, filename in FILES:
        recs, unk = parse_file(face_key, face_name, filename)
        all_records.extend(recs)
        all_unclassified.extend(unk)

    stats = []
    for face_key, face_name, _ in FILES:
        for key, name, _ in PROCESS_DICT:
            vals = [
                r["hours"]
                for r in all_records
                if r["face"] == face_key and r["key"] == key and 0.08 <= r["hours"] <= 12
            ]
            if not vals:
                continue
            stats.append(
                {
                    "face": face_key,
                    "key": key,
                    "name": name,
                    "count": len(vals),
                    "median": round(st.median(vals), 3),
                    "min": round(min(vals), 3),
                    "max": round(max(vals), 3),
                    "enough": len(vals) >= 5,
                }
            )

    payload = {
        "generatedAt": date.today().isoformat(),
        "source": [f[2] for f in FILES],
        "records": all_records,
        "stats": stats,
        "unclassified": all_unclassified,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    # 人工复核清单：原始行 ↔ 归类工序 ↔ 用时（Excel 可直接打开）
    os.makedirs(os.path.dirname(REVIEW_CSV), exist_ok=True)
    name_of = {k: n for k, n, _ in PROCESS_DICT}
    reason_label = {k: n for k, n, _ in REASON_DICT}
    with open(REVIEW_CSV, "w", encoding="utf-8-sig", newline="") as f:
        f.write("工作面,日期,开工,完工,跨零点,用时(h),归类工序,开工前等待,部位/桩号,原文,需复核\n")
        for r in all_records:
            face = dict((k, n) for k, n, _ in FILES)[r["face"]]
            need = ""
            if r["abnormal"]:
                need = "时长异常"
            elif any(k in r["note"] for k in ("验收", "验孔", "测量", "放样", "收断面", "扫断面")):
                need = "归类建议复核"
            f.write(
                "%s,%s,%s,%s,%s,%.2f,%s,%s,%s,%s,%s\n"
                % (
                    face,
                    r["date"],
                    r["startTime"],
                    r["endTime"],
                    "是" if r["crossMidnight"] else "",
                    r["hours"],
                    name_of.get(r["key"], r["key"]),
                    reason_label.get(r["reason"] or "", ""),
                    (r["location"] or "").replace(",", " "),
                    r["note"].replace(",", " "),
                    need,
                )
            )

    sys.stdout.buffer.write(
        (
            "记录 %d 条，未归类 %d 条，统计 %d 组\n输出：%s\n复核清单：%s\n"
            % (len(all_records), len(all_unclassified), len(stats), OUT, REVIEW_CSV)
        ).encode("utf-8")
    )
    for u in all_unclassified:
        sys.stdout.buffer.write(("  未归类: " + u + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
