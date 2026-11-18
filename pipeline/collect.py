"""리플 레이더 시제품 수집: 공급계약 원문(시연 범위) + 타법인출자현황(지분 선).

  python collect.py            # stock_system 의 DART 클라이언트·DB를 그대로 씀 (일일 한도 관리 포함)
- 원문: stock_system/data/dart_docs/CONTRACT/<rcept_no>.zip, 상태는 collector DB 의 dart_docs(kind='CONTRACT')
- 지분: dart_struct(kind='OWN', rcept_no='<corp_code>_<year>')
"""
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "stock_system"
sys.path.insert(0, str(ROOT))
from collector.dart import Dart, DailyLimitReached  # noqa: E402
from collector.db import DB_PATH  # noqa: E402

log = logging.getLogger("collect")
OUT = ROOT / "data" / "dart_docs" / "CONTRACT"
SECTORS = ("반도체", "디스플레이", "IT부품", "전기·전자", "화학", "정보기기", "통신장비")
WINDOWS = (("20160101", "20190630"), ("20120101", "20130831"))
OWN_YEARS = ("2018",)


def targets(conn):
    ph = ",".join("?" * len(SECTORS))
    rows = []
    for a, b in WINDOWS:
        rows += conn.execute(f"""SELECT f.rcept_no, f.corp_code, f.rcept_dt FROM dart_filings f
                 JOIN (SELECT DISTINCT code FROM krx_sector WHERE sector IN ({ph})) s ON s.code = f.stock_code
                 WHERE trim(f.report_nm)='단일판매ㆍ공급계약체결' AND f.rcept_dt BETWEEN ? AND ?""", (*SECTORS, a, b)).fetchall()
    return rows


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.executescript("""CREATE TABLE IF NOT EXISTS dart_docs (rcept_no TEXT PRIMARY KEY, kind TEXT, corp_code TEXT, rcept_dt TEXT,
                          status TEXT, n_bytes INTEGER, fetched_at TEXT);
                          CREATE TABLE IF NOT EXISTS dart_struct (kind TEXT, corp_code TEXT, rcept_no TEXT, payload TEXT,
                          PRIMARY KEY (kind, rcept_no));""")
    d = Dart(conn)
    OUT.mkdir(parents=True, exist_ok=True)
    rows = targets(conn)
    done = {r[0] for r in conn.execute("SELECT rcept_no FROM dart_docs WHERE kind='CONTRACT' AND status='ok'")}
    todo = [r for r in rows if r[0] not in done]
    log.info("공급계약 원문: 대상 %d, 남음 %d", len(rows), len(todo))
    t0 = time.time()
    try:
        for i, (rno, cc, dt) in enumerate(todo, 1):
            z = d.get("document.xml", rcept_no=rno)
            ok = z[:2] == b"PK"
            if ok:
                (OUT / f"{rno}.zip").write_bytes(z)
            with conn:
                conn.execute("INSERT OR REPLACE INTO dart_docs VALUES (?,?,?,?,?,?,datetime('now'))",
                             (rno, "CONTRACT", cc, dt, "ok" if ok else "err", len(z)))
            if i % 200 == 0:
                log.info("  %d/%d (%.0fs)", i, len(todo), time.time() - t0)
        # 지분(타법인출자현황): 시연 업종 기업, 2개 연도
        ph = ",".join("?" * len(SECTORS))
        corps = [r[0] for r in conn.execute(f"""SELECT DISTINCT c.corp_code FROM dart_corp c
                  JOIN (SELECT DISTINCT code FROM krx_sector WHERE sector IN ({ph})) s ON s.code = c.stock_code""", SECTORS)]
        have = {r[0] for r in conn.execute("SELECT rcept_no FROM dart_struct WHERE kind='OWN'")}
        n = 0
        for cc in corps:
            for y in OWN_YEARS:
                key = f"{cc}_{y}"
                if key in have:
                    continue
                try:
                    j = d.get_json("otrCprInvstmntSttus.json", corp_code=cc, bsns_year=y, reprt_code="11011")
                except RuntimeError:
                    j = {"list": []}
                with conn:
                    conn.execute("INSERT OR REPLACE INTO dart_struct VALUES (?,?,?,?)", ("OWN", cc, key, json.dumps(j.get("list", []), ensure_ascii=False)))
                n += 1
        log.info("지분 조회 %d건 (기업 %d)", n, len(corps))
    except DailyLimitReached as e:
        log.warning("일일 한도: %s", e)
    log.info("완료 (%.0fs), 오늘 호출 %d", time.time() - t0, d._used_today())


if __name__ == "__main__":
    main()
