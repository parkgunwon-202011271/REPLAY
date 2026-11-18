"""[메인 PC 전용] 연구 저장소 DB에서 해커톤 데이터 묶음(hackathon/data/)을 만듭니다.

  python make_pack.py                 # 전체 다시 만듦 (몇 분)
  python make_pack.py --only prices   # 일부만: companies, filings, docs, seo, own, prices, mcap

다른 컴퓨터에서는 실행하지 않습니다(주가 DB stocks.db 와 stock_system 모듈이 필요).
2025-01-01 이후 자료는 넣지 않습니다(연구 홀드아웃 봉인).
"""
from __future__ import annotations

import argparse
import json
import logging
import shutil
import sqlite3
import sys
from datetime import date
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SS = ROOT / "stock_system"
sys.path.insert(0, str(SS))
sys.path.insert(0, str(HERE))
from collector.db import DB_PATH  # noqa: E402

import dartdoc as D  # noqa: E402

log = logging.getLogger("make_pack")
OUT = HERE.parent / "data"
SRC_DOCS = SS / "data" / "dart_docs"
CUT = "20250101"
START_Y, END_Y = 2010, 2024
FILING_RE = r"공급계약|생산중단|재해발생|영업정지|유상증자결정|공장|화재"


def companies(conn):
    t = pd.read_sql_query("SELECT symbol, name, market FROM tickers WHERE market IN ('KOSPI','KOSDAQ') AND asset_type='stock'", conn)
    t["code"] = t["symbol"].str[:6]
    dc = pd.read_sql_query("SELECT corp_code, corp_name, stock_code AS code FROM dart_corp WHERE stock_code IS NOT NULL AND stock_code <> ''", conn)
    t = t.merge(dc, on="code", how="left")
    sec = pd.read_sql_query("SELECT code, sector, date FROM krx_sector WHERE date < ?", conn, params=[CUT])
    t["sector"] = t["code"].map(sec.sort_values("date").groupby("code").last()["sector"]).fillna("기타")
    t = t.drop_duplicates("code")[["code", "name", "market", "corp_code", "corp_name", "sector"]]
    t.to_csv(OUT / "companies.csv", index=False)
    return t


def filings(conn):
    f = pd.read_sql_query("SELECT rcept_no, rcept_dt, corp_code, stock_code, corp_name, report_nm FROM dart_filings WHERE rcept_dt < ?", conn, params=[CUT])
    f = f[f["report_nm"].str.contains(FILING_RE, regex=True, na=False)]
    f["report_nm"] = f["report_nm"].str.strip()
    f.sort_values("rcept_dt").to_csv(OUT / "filings.csv.gz", index=False, compression="gzip")
    return len(f)


def docs(conn):
    rows = conn.execute("SELECT rcept_no FROM dart_docs WHERE kind='CONTRACT' AND status='ok' AND rcept_dt < ?", (CUT,)).fetchall()
    dst = OUT / "docs" / "CONTRACT"
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for (rno,) in rows:
        p = SRC_DOCS / "CONTRACT" / f"{rno}.zip"
        if p.exists() and not (dst / p.name).exists():
            shutil.copy2(p, dst / p.name)
            n += 1
    return n


def seo(conn):
    from build import name_index, norm
    listed = set(name_index(pd.read_csv(OUT / "companies.csv", dtype=str).set_index("code")))   # 상장사 이름(짧은 한글 회사명 보호)
    docs_ = conn.execute("""SELECT d.rcept_no, d.rcept_dt, f.stock_code FROM dart_docs d JOIN dart_filings f ON f.rcept_no=d.rcept_no
                            WHERE d.kind='SEO' AND d.status='ok' AND d.rcept_dt < ?""", (CUT,)).fetchall()
    out, checked = [], []
    for rno, dt, code in docs_:
        p = SRC_DOCS / "SEO" / f"{rno}.zip"
        if not p.exists():
            continue
        checked.append(rno)
        rows = D.allottees(D.xml_text(p.read_bytes()))
        tot = sum((x["shares"] or 0) for x in rows)               # 비중 계산용: 개인 포함 전체 배정 주식 수
        for x in rows:
            if D.looks_like_person(x["name"]) and norm(x["name"]) not in listed:
                continue                                         # 개인 투자자 이름은 넣지 않음
            out.append({"rcept_no": rno, "rcept_dt": dt, "code": code, "name": x["name"], "rlt": x["rlt"], "shares": x["shares"], "tot_shares": tot})
    pd.DataFrame(out).to_csv(OUT / "seo_allottees.csv", index=False)
    (OUT / "seo_checked.txt").write_text("\n".join(sorted(checked)) + "\n", encoding="utf-8")   # 원문을 확인한 공시(대상자 없음 포함)
    return len(out)


def own(conn):
    out = []
    for cc, key, payload in conn.execute("SELECT corp_code, rcept_no, payload FROM dart_struct WHERE kind='OWN'"):
        year = key.split("_")[-1]
        for it in json.loads(payload):
            out.append({"corp_code": cc, "year": year, "inv_prm": it.get("inv_prm", ""), "qota_rt": it.get("trmend_blce_qota_rt", "")})
    pd.DataFrame(out).to_csv(OUT / "own.csv", index=False)
    return len(out)


def prices(conn, codes):
    from collector.db import get_close_matrix
    d = OUT / "prices"
    d.mkdir(parents=True, exist_ok=True)
    n = 0
    for y in range(START_Y, END_Y + 1):
        syms = [f"{c}.KS" for c in codes] + [f"{c}.KQ" for c in codes]
        ph = ",".join("?" * len(syms))
        df = pd.read_sql_query(f"SELECT date, symbol, adj_close AS v FROM daily_prices WHERE symbol IN ({ph}) AND date >= ? AND date < ?",
                               conn, params=[*syms, f"{y}-01-01", f"{y + 1}-01-01"], parse_dates=["date"])
        px = df.pivot(index="date", columns="symbol", values="v").sort_index()
        wide = {}
        for c in codes:
            cols = [s for s in (f"{c}.KS", f"{c}.KQ") if s in px.columns]
            if cols:
                s = px[cols].bfill(axis=1).iloc[:, 0]
                if s.notna().any():
                    wide[c] = s
        W = pd.DataFrame(wide).astype("float32")
        W.index.name = "date"
        W.to_parquet(d / f"adj_close_{y}.parquet", compression="zstd")
        n += W.shape[1]
        log.info("  주가 %d: %d종목 × %d일", y, W.shape[1], len(W))
    bm = get_close_matrix(conn, ["^KS11", "^KQ11"], start=f"{START_Y}-01-01", col="close")
    bm = bm[bm.index < pd.Timestamp(CUT)]
    bm.index.name = "date"
    bm.to_csv(d / "bench.csv")
    return n


def mcap(codes):
    from quant.panel import marcap_panels
    parts = []
    for y in range(START_Y, END_Y + 1):
        mc = marcap_panels({c: c for c in codes}, f"{y}-01-01", f"{y}-12-31")["marcap"]
        parts.append(mc.resample("W-FRI").last())                    # 주 단위(금요일) 시가총액
    M = pd.concat(parts).astype("float32")
    M = M[M.index < pd.Timestamp(CUT)]
    M.index.name = "date"
    M.to_parquet(OUT / "mcap_weekly.parquet", compression="zstd")
    return M.shape


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=["companies", "filings", "docs", "seo", "own", "prices", "mcap"])
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    OUT.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=60)
    C = companies(conn) if "companies" in a.only else pd.read_csv(OUT / "companies.csv", dtype=str)
    codes = sorted(C["code"].unique())
    man = json.loads((OUT / "MANIFEST.json").read_text(encoding="utf-8")) if (OUT / "MANIFEST.json").exists() else {}
    man.update({"made": date.today().isoformat(), "cutoff": "2024-12-31", "companies": len(codes)})
    if "filings" in a.only:
        man["filings"] = filings(conn); log.info("공시 목록 %d", man["filings"])
    if "docs" in a.only:
        docs(conn); man["contract_docs"] = len(list((OUT / "docs" / "CONTRACT").glob("*.zip"))); log.info("공급계약 원문 %d", man["contract_docs"])
    if "seo" in a.only:
        man["seo_allottees"] = seo(conn); log.info("제3자배정 대상자(법인) %d", man["seo_allottees"])
    if "own" in a.only:
        man["own_rows"] = own(conn); log.info("타법인출자 %d", man["own_rows"])
    if "prices" in a.only:
        prices(conn, codes); log.info("주가 완료")
    if "mcap" in a.only:
        man["mcap_shape"] = list(mcap(codes)); log.info("시총 %s", man["mcap_shape"])
    (OUT / "MANIFEST.json").write_text(json.dumps(man, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
