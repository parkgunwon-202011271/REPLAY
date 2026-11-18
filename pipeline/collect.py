"""DART 원문 추가 수집 — 어느 컴퓨터에서나 실행합니다(메인 PC DB 불필요).

  python collect.py status                                          # 묶음에 무엇이 얼마나 있는지
  python collect.py contracts --from 2014-01-01 --to 2015-12-31     # 공급계약 원문 받기(기본 업종: 전자·화학)
  python collect.py contracts --from 2020-01-01 --to 2024-12-31 --sectors "운송장비·부품" 화학 --limit 500
  python collect.py seo --from 2020-01-01 --to 2024-12-31           # 유상증자 제3자배정 대상자(법인)
  python collect.py own --year 2021                                 # 타법인출자현황(지분 5% 이상 선)

- 받을 목록은 묶음의 공시 목록(data/filings.csv.gz, 2009~2024)에서 고릅니다. 새 목록 조회는 하지 않습니다.
- 결과는 data/ 묶음에 바로 들어가고, 다음 `python build.py` 실행 때 지도에 반영됩니다.
- DART 인증키: 환경변수 DART_API_KEY 또는 저장소 최상위 .env 의 DART_API_KEY=... (키는 화면에 출력하지 않음)
- 하루 호출 한도: DART 는 키당 하루 2만 건. 여기서는 19,000건에서 멈춥니다(data/.dart_calls.json 에 기록).
- 2025-01-01 이후 공시는 받지 않습니다(연구 홀드아웃 봉인 — 바꾸려면 사용자 결정 필요).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import dartdoc as D  # noqa: E402
from pack import CONTRACT_NM, DATA, Pack  # noqa: E402

BASE = "https://opendart.fss.or.kr/api/"
UA = {"User-Agent": "ripple-radar-prototype/0.1 (hackathon research)"}
DAILY_LIMIT = 19_000
CUT = "20250101"
DEFAULT_SECTORS = ("반도체", "디스플레이", "IT부품", "전기·전자", "화학", "정보기기", "통신장비")
SEO_NM = ("주요사항보고서(유상증자결정)",)
CALLS = DATA / ".dart_calls.json"


class LimitReached(Exception):
    pass


def api_key() -> str:
    k = os.environ.get("DART_API_KEY", "")
    if not k:
        for env in (HERE.parent / ".env", HERE.parents[1] / ".env"):
            if env.exists():
                for line in env.read_text(encoding="utf-8").splitlines():
                    if line.strip().startswith("DART_API_KEY="):
                        k = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
            if k:
                break
    if not k:
        sys.exit("DART_API_KEY 가 없습니다. https://opendart.fss.or.kr 에서 인증키를 받아 .env 에 DART_API_KEY=... 로 넣으세요.")
    return k


class Dart:
    def __init__(self, sleep: float = 0.15):
        self.key, self.sleep = api_key(), sleep
        try:
            self.calls = json.loads(CALLS.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.calls = {}

    def used(self) -> int:
        return self.calls.get(date.today().isoformat(), 0)

    def _count(self):
        d = date.today().isoformat()
        self.calls = {d: self.calls.get(d, 0) + 1}
        CALLS.write_text(json.dumps(self.calls), encoding="utf-8")

    def get(self, endpoint: str, **params) -> bytes:
        if self.used() >= DAILY_LIMIT:
            raise LimitReached(f"오늘 {self.used()}건 호출 — 한도 {DAILY_LIMIT}")
        url = BASE + endpoint + "?" + urllib.parse.urlencode({**params, "crtfc_key": self.key})
        err = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                    body = r.read()
                self._count()
                time.sleep(self.sleep)
                if body[:5] == b"<?xml" and b"<status>020</status>" in body:
                    raise LimitReached("DART 가 오늘 한도 초과를 알림(020)")
                return body
            except (urllib.error.URLError, TimeoutError) as e:
                err = e
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"DART 연결 실패: {err}")

    def get_json(self, endpoint: str, **params) -> dict:
        d = json.loads(self.get(endpoint, **params))
        if d.get("status") == "020":
            raise LimitReached(d.get("message"))
        return d


def _ymd(s: str) -> str:
    v = s.replace("-", "")
    if v >= CUT:
        sys.exit("2025-01-01 이후는 받지 않습니다(연구 홀드아웃 봉인).")
    return v


def targets(pk: Pack, names, a: str, b: str, sectors) -> pd.DataFrame:
    f = pk.filings()
    f = f[f["report_nm"].isin(names) & (f["rcept_dt"] >= a) & (f["rcept_dt"] <= b)]
    if sectors:
        C = pk.companies()
        f = f[f["stock_code"].map(C["sector"]).isin(sectors)]
    return f


def cmd_contracts(args):
    pk, d = Pack(), Dart()
    out = DATA / "docs" / "CONTRACT"
    out.mkdir(parents=True, exist_ok=True)
    f = targets(pk, (CONTRACT_NM,), _ymd(args.start), _ymd(args.end), args.sectors)
    todo = [r for r in f.itertuples() if not (out / f"{r.rcept_no}.zip").exists()][: args.limit or None]
    print(f"공급계약: 대상 {len(f)}건, 받을 것 {len(todo)}건 (오늘 사용 {d.used()}건)")
    ok = 0
    try:
        for i, r in enumerate(todo, 1):
            z = d.get("document.xml", rcept_no=r.rcept_no)
            if z[:2] == b"PK":
                (out / f"{r.rcept_no}.zip").write_bytes(z)
                ok += 1
            if i % 100 == 0:
                print(f"  {i}/{len(todo)}")
    except LimitReached as e:
        print("멈춤:", e)
    print(f"완료: 새 원문 {ok}건. 다음: python build.py")


def cmd_seo(args):
    pk, d = Pack(), Dart()
    from build import name_index, norm
    listed = set(name_index(pk.companies()))
    path = DATA / "seo_allottees.csv"
    cur = pd.read_csv(path, dtype={"rcept_no": str, "rcept_dt": str, "code": str})
    checked = DATA / "seo_checked.txt"                    # 원문을 이미 확인한 공시(대상자 없음 포함)
    seen = set(cur["rcept_no"]) | (set(checked.read_text(encoding="utf-8").split()) if checked.exists() else set())
    f = targets(pk, SEO_NM, _ymd(args.start), _ymd(args.end), args.sectors)
    todo = [r for r in f.itertuples() if r.rcept_no not in seen][: args.limit or None]
    print(f"유상증자: 대상 {len(f)}건, 받을 것 {len(todo)}건 (오늘 사용 {d.used()}건)")
    rows, done = [], []
    try:
        for r in todo:
            z = d.get("document.xml", rcept_no=r.rcept_no)
            done.append(r.rcept_no)
            if z[:2] != b"PK":
                continue
            al = D.allottees(D.xml_text(z))
            tot = sum((x["shares"] or 0) for x in al)
            for x in al:
                if D.looks_like_person(x["name"]) and norm(x["name"]) not in listed:
                    continue                                    # 개인 투자자 이름은 저장하지 않음
                rows.append({"rcept_no": r.rcept_no, "rcept_dt": r.rcept_dt, "code": r.stock_code, "name": x["name"], "rlt": x["rlt"],
                             "shares": x["shares"], "tot_shares": tot})
    except LimitReached as e:
        print("멈춤:", e)
    if rows:
        pd.concat([cur, pd.DataFrame(rows)]).to_csv(path, index=False)
    checked.write_text("\n".join(sorted(seen | set(done))) + "\n", encoding="utf-8")
    print(f"완료: 원문 {len(done)}건 확인, 대상자(법인) {len(rows)}행 추가. 다음: python build.py")


def cmd_own(args):
    pk, d = Pack(), Dart()
    if str(args.year) >= "2025":
        sys.exit("2025년 이후 보고서는 받지 않습니다(연구 홀드아웃 봉인).")
    path = DATA / "own.csv"
    cur = pd.read_csv(path, dtype={"corp_code": str, "year": str})
    have = set(zip(cur["corp_code"], cur["year"]))
    C = pk.companies()
    C = C[C["sector"].isin(args.sectors)] if args.sectors else C
    corps = [c for c in C["corp_code"].dropna().unique() if (c, str(args.year)) not in have][: args.limit or None]
    print(f"타법인출자 {args.year}: 기업 {len(corps)}곳 (오늘 사용 {d.used()}건)")
    rows = []
    try:
        for cc in corps:
            j = d.get_json("otrCprInvstmntSttus.json", corp_code=cc, bsns_year=str(args.year), reprt_code="11011")
            for it in j.get("list", []) or []:
                rows.append({"corp_code": cc, "year": str(args.year), "inv_prm": it.get("inv_prm", ""), "qota_rt": it.get("trmend_blce_qota_rt", "")})
    except LimitReached as e:
        print("멈춤:", e)
    if rows:
        pd.concat([cur, pd.DataFrame(rows)]).to_csv(path, index=False)
    print(f"완료: {len(rows)}행 추가. 지도에 쓰려면 build.py 의 지분 연도(2018) 기준도 함께 바꾸세요.")


def cmd_status(_args):
    pk = Pack()
    f = pk.filings()
    have = {p.stem for p in (DATA / "docs" / "CONTRACT").glob("*.zip")}
    k = f[f["report_nm"] == CONTRACT_NM].copy()
    k["year"] = k["rcept_dt"].str[:4]
    k["have"] = k["rcept_no"].isin(have)
    t = k.groupby("year")["have"].agg(["size", "sum"]).rename(columns={"size": "공시", "sum": "원문 보유"})
    print("공급계약 공시(전 업종) 대비 원문 보유:")
    print(t.to_string())
    print(f"제3자배정 대상자(법인) {len(pk.allottees())}행, 타법인출자 {len(pk.own())}행, 기업 {len(pk.companies())}곳")
    try:
        calls = json.loads(CALLS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        calls = {}
    print(f"오늘 DART 호출: {calls.get(date.today().isoformat(), 0)} / {DAILY_LIMIT}")


def main():
    ap = argparse.ArgumentParser(description="리플 레이더 DART 원문 추가 수집")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    for name in ("contracts", "seo"):
        p = sub.add_parser(name)
        p.add_argument("--from", dest="start", required=True)
        p.add_argument("--to", dest="end", required=True)
        p.add_argument("--sectors", nargs="*", default=list(DEFAULT_SECTORS) if name == "contracts" else None,
                       help="KRX 업종 이름. --sectors 만 쓰고 이름을 비우면 전 업종")
        p.add_argument("--limit", type=int, default=0, help="이번에 받을 최대 건수(0 = 전부)")
    p = sub.add_parser("own")
    p.add_argument("--year", type=int, required=True)
    p.add_argument("--sectors", nargs="*", default=list(DEFAULT_SECTORS))
    p.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    {"status": cmd_status, "contracts": cmd_contracts, "seo": cmd_seo, "own": cmd_own}[a.cmd](a)


if __name__ == "__main__":
    main()
