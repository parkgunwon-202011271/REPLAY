"""해커톤 데이터 묶음(hackathon/data/) 읽기. 파이프라인은 이 모듈로만 데이터를 읽습니다.

묶음 구성은 hackathon/DATA.md 참고. 묶음은 2024-12-31까지의 자료만 담습니다(연구 홀드아웃 봉인).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
HOLDOUT = "2025-01-01"
CONTRACT_NM = "단일판매ㆍ공급계약체결"


class Pack:
    def __init__(self, root: Path | str = DATA):
        self.root = Path(root)
        if not (self.root / "companies.csv").exists():
            raise FileNotFoundError(f"데이터 묶음이 없습니다: {self.root}. 저장소를 다시 받거나 메인 PC에서 make_pack.py 를 실행하세요.")

    # ---- 기업
    @lru_cache(maxsize=1)
    def companies(self) -> pd.DataFrame:
        c = pd.read_csv(self.root / "companies.csv", dtype=str).fillna({"sector": "기타"})
        return c.set_index("code")

    # ---- 공시 목록
    @lru_cache(maxsize=1)
    def filings(self) -> pd.DataFrame:
        f = pd.read_csv(self.root / "filings.csv.gz", dtype=str)
        f["report_nm"] = f["report_nm"].str.strip()
        return f[f["rcept_dt"] < HOLDOUT.replace("-", "")]

    def doc_path(self, kind: str, rcept_no: str) -> Path:
        return self.root / "docs" / kind / f"{rcept_no}.zip"

    def contract_docs(self) -> pd.DataFrame:
        """원문을 받아 둔 공급계약 공시: rcept_no, rcept_dt, code, corp_name"""
        f = self.filings()
        f = f[f["report_nm"] == CONTRACT_NM]
        have = {p.stem for p in (self.root / "docs" / "CONTRACT").glob("*.zip")}
        f = f[f["rcept_no"].isin(have)]
        return f.rename(columns={"stock_code": "code"})[["rcept_no", "rcept_dt", "code", "corp_name"]]

    def events(self, names: tuple[str, ...], start: str, end: str) -> pd.DataFrame:
        f = self.filings()
        f = f[f["report_nm"].isin(names) & (f["rcept_dt"] >= start) & (f["rcept_dt"] <= end)]
        return f.rename(columns={"stock_code": "code"})[["rcept_dt", "code", "corp_name", "report_nm"]].rename(columns={"report_nm": "nm"})

    # ---- 제3자배정 대상자(법인만), 지분
    def allottees(self) -> pd.DataFrame:
        a = pd.read_csv(self.root / "seo_allottees.csv", dtype={"rcept_no": str, "rcept_dt": str, "code": str, "name": str, "rlt": str})
        return a[a["rcept_dt"] < HOLDOUT.replace("-", "")]

    def own(self) -> pd.DataFrame:
        return pd.read_csv(self.root / "own.csv", dtype={"corp_code": str, "year": str, "inv_prm": str})

    # ---- 주가·지수·시총
    def _years(self, start: str, end: str):
        return range(max(2010, pd.Timestamp(start).year), min(2024, pd.Timestamp(end).year) + 1)

    @lru_cache(maxsize=32)
    def _price_year(self, y: int) -> pd.DataFrame:
        p = self.root / "prices" / f"adj_close_{y}.parquet"
        return pd.read_parquet(p) if p.exists() else pd.DataFrame()

    def prices(self, codes, start: str, end: str) -> pd.DataFrame:
        parts = [self._price_year(y) for y in self._years(start, end)]
        px = pd.concat([p for p in parts if len(p)], axis=0) if any(len(p) for p in parts) else pd.DataFrame()
        if not len(px):
            return px
        px.index = pd.to_datetime(px.index)
        px = px.loc[(px.index >= pd.Timestamp(start)) & (px.index <= pd.Timestamp(end)) & (px.index < pd.Timestamp(HOLDOUT))]
        return px[[c for c in codes if c in px.columns]].astype("float64")

    @lru_cache(maxsize=1)
    def _bench(self) -> pd.DataFrame:
        b = pd.read_csv(self.root / "prices" / "bench.csv", index_col=0, parse_dates=True)
        return b[b.index < pd.Timestamp(HOLDOUT)]

    def bench(self, start: str, end: str) -> pd.DataFrame:
        b = self._bench()
        return b.loc[(b.index >= pd.Timestamp(start)) & (b.index <= pd.Timestamp(end))]

    @lru_cache(maxsize=1)
    def _mcap(self) -> pd.DataFrame:
        m = pd.read_parquet(self.root / "mcap_weekly.parquet")
        m.index = pd.to_datetime(m.index)
        return m

    def mcap_asof(self, codes, asof: pd.Timestamp) -> dict:
        m = self._mcap()
        m = m[m.index <= asof]
        if not len(m):
            return {}
        last = m.ffill().iloc[-1]
        return {c: float(last[c]) for c in codes if c in last.index and np.isfinite(last[c])}
