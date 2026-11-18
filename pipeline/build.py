"""리플 레이더 시제품 파이프라인: 공시 → 관계 추출 → 개체 연결 → 그래프 → 전파 → 주가 반영 → 시나리오 JSON.

  python build.py              # 그래프 + 시나리오 3개를 web/data/*.json 으로 내보냄
LLM(Gemini)은 .env 의 GEMINI_API_KEY 가 있을 때만 '근거 기반 설명'에 씁니다. 없으면 규칙 기반 설명.
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
SS = ROOT / "stock_system"
sys.path.insert(0, str(SS))
from collector.db import DB_PATH  # noqa: E402
from quant import disclosure as D  # noqa: E402

log = logging.getLogger("build")
WEB = ROOT / "hackathon" / "web" / "data"
DOCS = SS / "data" / "dart_docs"
HOLDOUT = "2025-01-01"
LAMBDA, MAX_HOP, MIN_I = 0.6, 4, 0.002

# ---------------------------------------------------------------- 1. 회사 목록·이름 정규화
_SUFFIX = re.compile(r"\(주\)|㈜|주식회사|\(株\)|\(유\)|유한회사|유한책임회사|\bCo\.,?\s*Ltd\.?|\bLtd\.?|\bInc\.?|\bCorp\.?|\bCorporation\b|\bLimited\b|\bS\.A\.?|\bCO\.,?\s*LTD\.?", re.I)


def norm(name: str) -> str:
    s = re.sub(r"\(.*?\)", lambda m: "" if re.search(r"[A-Za-z]", m.group(0)) else m.group(0), name or "")
    s = _SUFFIX.sub("", s)
    s = re.sub(r"[\s·\.,\-]", "", s)
    return s.strip().upper()


ALIAS = {"기아자동차": "기아", "삼성SDI": "삼성SDI", "엘지디스플레이": "LG디스플레이", "에스케이하이닉스": "SK하이닉스",
         "하이닉스반도체": "SK하이닉스", "삼성전자": "삼성전자", "엘지전자": "LG전자", "엘지화학": "LG화학", "현대자동차": "현대차",
         "에스케이": "SK", "에스케이씨": "SKC", "SK HYNIX": "SK하이닉스", "SKHYNIX": "SK하이닉스", "HYNIX": "SK하이닉스",
         "SAMSUNG ELECTRONICS": "삼성전자", "SAMSUNGELECTRONICS": "삼성전자", "LG DISPLAY": "LG디스플레이", "LGDISPLAY": "LG디스플레이",
         "LG ELECTRONICS": "LG전자", "LGELECTRONICS": "LG전자", "LG CHEM": "LG화학", "LGCHEM": "LG화학", "HYUNDAI MOTOR": "현대차",
         "KIA MOTORS": "기아", "SAMSUNG SDI": "삼성SDI", "SAMSUNGSDI": "삼성SDI", "LG INNOTEK": "LG이노텍", "LGINNOTEK": "LG이노텍",
         "SAMSUNG ELECTRO-MECHANICS": "삼성전기", "SAMSUNGELECTROMECHANICS": "삼성전기"}
_PARENT_HINT = re.compile(r"(베트남|중국|미국|인도|헝가리|폴란드|멕시코|브라질|슬로바키아|천진|소주|심천|서안|우시|무석|남경|혜주|VIETNAM|CHINA|AMERICA|INDIA|HUNGARY|POLAND|MEXICO|TIANJIN|SUZHOU|XIAN|WUXI|NANJING)", re.I)


def companies(conn) -> pd.DataFrame:
    t = pd.read_sql_query("SELECT symbol, name, market FROM tickers WHERE market IN ('KOSPI','KOSDAQ') AND asset_type='stock'", conn)
    t["code"] = t["symbol"].str[:6]
    dc = pd.read_sql_query("SELECT corp_code, corp_name, stock_code FROM dart_corp WHERE stock_code IS NOT NULL AND stock_code <> ''", conn)
    t = t.merge(dc.rename(columns={"stock_code": "code"}), on="code", how="left")
    sec = pd.read_sql_query("SELECT code, sector, date FROM krx_sector WHERE date < ?", conn, params=[HOLDOUT.replace("-", "")])
    sec = sec.sort_values("date").groupby("code").last()["sector"]
    t["sector"] = t["code"].map(sec).fillna("기타")
    return t.drop_duplicates("code").set_index("code")


def name_index(C: pd.DataFrame) -> dict:
    idx = {}
    for code, r in C.iterrows():
        for nm in (r["name"], r.get("corp_name")):
            if isinstance(nm, str) and nm:
                idx.setdefault(norm(nm), code)
    for a, b in ALIAS.items():
        hit = C.index[C["name"] == b]
        if len(hit):
            idx[norm(a)] = hit[0]
    return idx


def ext_type(name: str) -> str:
    if re.search(r"공사|공단|청$|청\s|연구원|연구소|정부|시청|도청|구청|군청|조달|국방|공항|철도|대학", name):
        return "공공"
    if re.search(r"조합", name):
        return "조합"
    if re.search(r"[A-Za-z]{3,}", name) and not re.search(r"[가-힣]", name):
        return "해외"
    return "비상장"


# ---------------------------------------------------------------- 2. 관계 추출
NUM = r"([\d,]+(?:\.\d+)?)"


def parse_contract(text: str) -> dict:
    t = text[text.find("단일판매"):] if "단일판매" in text else text
    g = lambda p: (re.search(p, t).group(1).strip() if re.search(p, t) else "")  # noqa: E731
    cp = g(r"3\.\s*계약상대(?:방)?\s*(.+?)\s*-\s*(?:회사와의\s*관계|최근\s*매출액)")
    rel = g(r"회사와의\s*관계\s*(.+?)\s*(?:-\s*회사|4\.\s)")
    amt = g(r"계약금액\s*\(원\)\s*" + NUM)
    ratio = g(r"매출액\s*대비\s*\(%\)\s*" + NUM)
    title = g(r"1\.\s*판매ㆍ공급계약\s*(?:내용|구분)\s*(.+?)\s*2\.\s*계약내역")
    region = g(r"판매ㆍ공급지역\s*(.+?)\s*5\.\s")
    cdate = g(r"계약\(수주\)일자\s*(\d{4}-\d{2}-\d{2})")
    f = lambda s: float(s.replace(",", "")) if s else np.nan  # noqa: E731
    return {"counterparty": cp, "relation": rel.strip("- ") if rel else "", "amount": f(amt), "ratio": f(ratio),
            "title": re.sub(r"^(기타\s*판매ㆍ공급계약|공사수주|상품공급|제품공급)?\s*-?\s*체결계약명\s*", "", re.sub(r"\s+", " ", title))[:80], "region": region[:40], "cdate": cdate}


def contracts(conn) -> pd.DataFrame:
    rows = pd.read_sql_query("""SELECT d.rcept_no, d.rcept_dt, f.stock_code AS code, f.corp_name FROM dart_docs d
                                JOIN dart_filings f ON f.rcept_no = d.rcept_no WHERE d.kind='CONTRACT' AND d.status='ok'""", conn)
    out = []
    for r in rows.itertuples():
        p = DOCS / "CONTRACT" / f"{r.rcept_no}.zip"
        if not p.exists():
            continue
        rec = parse_contract(D.clean(D.xml_text(p.read_bytes())))
        out.append({"rcept_no": r.rcept_no, "date": pd.Timestamp(r.rcept_dt), "seller": r.code, "seller_name": r.corp_name, **rec})
    return pd.DataFrame(out)


# ---------------------------------------------------------------- 3. 그래프
def build_graph(conn, C):
    idx = name_index(C)
    N, E = {}, []

    def node_listed(code):
        r = C.loc[code]
        N.setdefault(code, {"id": code, "name": r["name"], "market": r["market"], "sector": r["sector"], "kind": "상장"})
        return code

    def node_ext(name):
        key = "X:" + norm(name)[:40]
        N.setdefault(key, {"id": key, "name": name[:40], "market": "", "sector": ext_type(name), "kind": ext_type(name)})
        return key

    def resolve(name):
        n = norm(name)
        if not n or n in ("-", "") or re.fullmatch(r"[-–]+", name.strip()):
            return None
        if n in idx:
            return node_listed(idx[n])
        if _PARENT_HINT.search(name):                                       # 해외 법인 → 상장 모회사
            for k in sorted(PARENTS, key=len, reverse=True):
                if n.startswith(k):
                    return node_listed(idx[k])
        if re.search(r"소재|일부|비공개|기재생략|^[가-힣]*사$", name) and len(n) < 14:
            return None                                                     # 익명 묘사 → 연결 안 함
        return node_ext(name)

    PARENTS = [k for k in idx if len(k) >= 4]
    # (1) 납품: 공급계약
    K = contracts(conn)
    stats = {"contracts": len(K), "named": 0, "listed_buyer": 0}
    for r in K.itertuples():
        if r.seller not in C.index:
            continue
        b = resolve(r.counterparty)
        if b is None:
            continue
        stats["named"] += 1
        stats["listed_buyer"] += int(not b.startswith("X:"))
        a = node_listed(r.seller)
        w = min(float(r.ratio) / 100, 1.0) if np.isfinite(r.ratio) else 0.05
        E.append({"src": a, "dst": b, "type": "납품", "w": max(w, 0.01), "date": r.date.strftime("%Y-%m-%d"),
                  "ev": f"{r.date:%Y-%m-%d} 공급계약 '{r.title}' {r.amount / 1e8:,.0f}억 원(매출 대비 {r.ratio}%)" if np.isfinite(r.amount) else f"{r.date:%Y-%m-%d} 공급계약", "rno": r.rcept_no})
    # (2) 투자: 제3자배정 유상증자 대상자(이미 받은 원문)
    ev = pd.read_sql_query("""SELECT d.rcept_no, d.rcept_dt, f.stock_code AS code FROM dart_docs d JOIN dart_filings f ON f.rcept_no=d.rcept_no
                              WHERE d.kind='SEO' AND d.status='ok'""", conn)
    for r in ev.itertuples():
        if r.code not in C.index:
            continue
        p = DOCS / "SEO" / f"{r.rcept_no}.zip"
        if not p.exists():
            continue
        rows = D.allottees(D.xml_text(p.read_bytes()))
        tot = sum((x["shares"] or 0) for x in rows) or 1
        for x in rows:
            n = norm(x["name"])
            if n in idx and idx[n] != r.code:
                inv = node_listed(idx[n])
                node_listed(r.code)
                E.append({"src": inv, "dst": r.code, "type": "투자", "w": max((x["shares"] or 0) / tot, 0.01), "date": f"{r.rcept_dt[:4]}-{r.rcept_dt[4:6]}-{r.rcept_dt[6:]}",
                          "ev": f"{r.rcept_dt[:4]}.{r.rcept_dt[4:6]} 제3자배정 유상증자 참여({x['rlt'] or '관계 표시 없음'})", "rno": r.rcept_no})
    # (3) 지분: 타법인출자현황
    corp2code = {r["corp_code"]: c for c, r in C.iterrows() if isinstance(r.get("corp_code"), str)}
    for cc, payload in conn.execute("SELECT corp_code, payload FROM dart_struct WHERE kind='OWN'"):
        if cc not in corp2code:
            continue
        for it in json.loads(payload):
            nm = it.get("inv_prm", "")
            q = it.get("trmend_blce_qota_rt", "") or ""
            try:
                qr = float(str(q).replace(",", ""))
            except ValueError:
                qr = np.nan
            if not nm or not np.isfinite(qr) or qr < 5:
                continue
            tgt = resolve(nm)
            if tgt is None or tgt == corp2code[cc]:
                continue
            node_listed(corp2code[cc])
            E.append({"src": corp2code[cc], "dst": tgt, "type": "지분", "w": min(qr / 100, 1.0), "date": "2018-12-31",
                      "ev": f"2018 사업보고서 타법인출자: 지분 {qr:.1f}%", "rno": ""})
    stats["edges_raw"] = len(E)
    return N, E, stats


def mcap_asof(codes, asof: pd.Timestamp) -> dict:
    from quant.panel import marcap_panels
    mc = marcap_panels({c: c for c in codes}, (asof - pd.Timedelta(days=12)).strftime("%Y-%m-%d"), asof.strftime("%Y-%m-%d"))["marcap"]
    last = mc.ffill().iloc[-1] if len(mc) else pd.Series(dtype=float)
    return {c: float(v) for c, v in last.items() if np.isfinite(v)}


def add_compete(N, E, k=3, corr=None):
    """같은 KRX 업종 안에서 '규모 근접(로그 시총) + 주가 동조(시장 조정 상관)' 점수가 높은 k개를 경쟁사로 봄."""
    by = defaultdict(list)
    for c, v in N.items():
        if not c.startswith("X:") and v.get("mcap"):
            by[v["sector"]].append(c)
    seen = set()
    for sec, cs in by.items():
        if sec in ("기타",) or len(cs) < 2:
            continue
        lm = {c: np.log(N[c]["mcap"]) for c in cs}
        for a in cs:
            def score(x):
                size = float(np.exp(-abs(lm[x] - lm[a])))
                c = float(corr.at[a, x]) if (corr is not None and a in corr.index and x in corr.columns and np.isfinite(corr.at[a, x])) else 0.0
                return 0.4 * size + 0.6 * max(c, 0.0)
            near = sorted((x for x in cs if x != a), key=score, reverse=True)[:k]
            for b in near:
                key = tuple(sorted((a, b)))
                if key in seen:
                    continue
                seen.add(key)
                sim = float(np.exp(-abs(lm[a] - lm[b])))
                c = float(corr.at[a, b]) if (corr is not None and a in corr.index and b in corr.columns and np.isfinite(corr.at[a, b])) else 0.0
                E.append({"src": a, "dst": b, "type": "경쟁", "w": round(0.15 + 0.2 * sim + 0.3 * max(c, 0), 3), "date": "",
                          "ev": f"같은 업종({sec}), 시총 비 {np.exp(abs(lm[a] - lm[b])):.1f}배, 주가 상관 {c:.2f}", "rno": ""})


def add_comove(N, E, cm: pd.DataFrame, k=3, thr=0.35):
    """코스피 대비 초과 수익의 상관(직전 1년) — '시장이 함께 움직인다고 보는' 연결."""
    seen = set()
    for a in cm.columns:
        s_ = cm[a].drop(a, errors="ignore").dropna().sort_values(ascending=False).head(k)
        for b, v in s_.items():
            if v >= thr and (b, a) not in seen:
                seen.add((a, b))
                E.append({"src": a, "dst": b, "type": "동조", "w": float(v) * 0.5, "date": "", "ev": f"주가 동조 상관 {v:.2f}(코스피 대비, 직전 1년)", "rno": ""})


# ---------------------------------------------------------------- 4. 전파
RULES = {  # (선 종류, 방향) → 부호 배수: 사건 노드의 충격 s 에 곱함. out = 사건 노드가 src, in = 사건 노드가 dst
    ("납품", "out"): (+1, "고객사: 공급 차질"),          # A가 공급 → 고객 B도 같은 방향(피해)
    ("납품", "in"): (+1, "납품업체: 주문 감소"),         # A가 구매 → 공급업체도 같은 방향
    ("경쟁", "out"): (-1, "경쟁사: 반사이익"), ("경쟁", "in"): (-1, "경쟁사: 반사이익"),
    ("투자", "out"): (+0.5, "투자 대상: 투자자 영향"), ("투자", "in"): (+1, "투자자: 지분 가치"),
    ("지분", "out"): (+0.5, "피출자사: 모회사 영향"), ("지분", "in"): (+1, "출자 회사: 지분 가치"),
    ("동조", "out"): (+1, "주가 동조"), ("동조", "in"): (+1, "주가 동조"),
}


def propagate(seeds: dict, E: list, kinds=None):
    """seeds: {노드: 충격(−1~+1)}. 반환: {노드: {I, hop, path, why}}"""
    adj = defaultdict(list)
    for i, e in enumerate(E):
        if kinds and e["type"] not in kinds:
            continue
        adj[e["src"]].append((e["dst"], e, "out"))
        adj[e["dst"]].append((e["src"], e, "in"))
    res = {s: {"I": v, "hop": 0, "path": [s], "why": ["사건 발생"], "edges": []} for s, v in seeds.items()}
    frontier = dict(seeds)
    for hop in range(1, MAX_HOP + 1):
        nxt = defaultdict(float)
        best = {}
        for u, su in frontier.items():
            for v, e, d in adj[u]:
                last = res[u].get("types", [])[-1] if res[u].get("types") else None
                if e["type"] in ("경쟁", "동조") and last in ("경쟁", "동조"):
                    continue                                   # 경쟁의 경쟁·동조의 동조는 잡음이 커서 막음
                mult, why = RULES[(e["type"], d)]
                val = su * mult * e["w"] * (LAMBDA ** (hop - 1)) / max(1, len(adj[u]) ** 0.25)
                if abs(val) < MIN_I or v in seeds:
                    continue
                nxt[v] += val
                if v not in best or abs(val) > abs(best[v][0]):
                    best[v] = (val, u, why, e)
        frontier = {}
        for v, val in nxt.items():
            if v in res:
                res[v]["I"] += val
                continue
            _, u, why, e = best[v]
            res[v] = {"I": val, "hop": hop, "path": res[u]["path"] + [v], "why": res[u]["why"] + [why],
                      "edges": res[u]["edges"] + [e.get("ev", "")], "types": res[u].get("types", []) + [e["type"]]}
            frontier[v] = val
    return res


# ---------------------------------------------------------------- 5. 주가 반영
def prices(conn, codes, start, end):
    from collector.db import get_close_matrix
    syms = []
    for c in codes:
        syms += [f"{c}.KS", f"{c}.KQ"]
    px = get_close_matrix(conn, syms, start=start, col="adj_close")
    px = px[px.index < pd.Timestamp(HOLDOUT)]
    px = px.loc[:end]
    out = {}
    for c in codes:
        cols = [s for s in (f"{c}.KS", f"{c}.KQ") if s in px.columns]
        if cols:
            out[c] = px[cols].bfill(axis=1).iloc[:, 0]
    bm = get_close_matrix(conn, ["^KS11", "^KQ11"], start=start, col="close").loc[:end]
    return pd.DataFrame(out), bm


def reactions(conn, res, N, t0: str, days=60):
    codes = [n for n in res if not n.startswith("X:")]
    start = (pd.Timestamp(t0) - pd.Timedelta(days=420)).strftime("%Y-%m-%d")
    end = (pd.Timestamp(t0) + pd.Timedelta(days=120)).strftime("%Y-%m-%d")
    P, BM = prices(conn, codes, start, end)
    r = P.pct_change(fill_method=None)
    rb = BM.pct_change()
    pre = r[r.index < pd.Timestamp(t0)].tail(250)
    post = r[r.index >= pd.Timestamp(t0)].head(days + 1)
    out = {}
    for c in codes:
        if c not in post.columns or post[c].notna().sum() < 5:
            continue
        b = rb["^KQ11" if N[c].get("market") == "KOSDAQ" else "^KS11"].reindex(post.index)
        ab = (post[c] - b).fillna(0)
        car = (1 + ab).cumprod() - 1
        sd = float((pre[c] - rb["^KS11"].reindex(pre.index)).std())
        z = car / (sd * np.sqrt(np.arange(1, len(car) + 1))) if sd > 0 else car * 0
        I = res[c]["I"]
        st = []
        for zz in z.values:
            if abs(I) < MIN_I:
                st.append("영향 미미")
            elif np.sign(zz) == np.sign(I) and abs(zz) >= 2:
                st.append("반영 완료")
            elif np.sign(zz) == np.sign(I) and abs(zz) >= 1:
                st.append("진행 중")
            elif np.sign(zz) != np.sign(I) and abs(zz) >= 1:
                st.append("반대로 움직임")
            else:
                st.append("미반영")
        out[c] = {"dates": [d.strftime("%Y-%m-%d") for d in car.index], "car": [round(float(x), 4) for x in car.values],
                  "z": [round(float(x), 2) for x in z.values], "status": st}
    return out


# ---------------------------------------------------------------- 6. 설명 (Gemini 있으면 문장 다듬기, 없으면 규칙)
def explain(res_v, N):
    path = " → ".join(N.get(p, {}).get("name", p) for p in res_v["path"])
    steps = "; ".join(w for w in res_v["why"][1:])
    ev = " / ".join(e for e in res_v["edges"] if e)
    return f"{path}. 경로: {steps}. 근거: {ev}" if ev else f"{path}. 경로: {steps}"


# ---------------------------------------------------------------- 7. 시나리오
SCENARIOS = [
    {"id": "japan2019", "title": "2019 일본 반도체 소재 수출규제", "date": "2019-07-01", "asof": "2019-06-30",
     "desc": "일본이 불화수소·포토레지스트·플루오린 폴리이미드의 한국 수출 심사를 강화(7/1 발표, 7/4 시행)",
     "seeds_ext": {"일본 반도체 소재 3종 공급": -1.0},
     "seed_links": [("일본 반도체 소재 3종 공급", "005930", "납품", 0.30), ("일본 반도체 소재 3종 공급", "000660", "납품", 0.30),
                    ("일본 반도체 소재 3종 공급", "034220", "납품", 0.25)],
     "substitutes": ["036830", "102710", "171010", "093370", "005290", "036490", "120110", "011790"]},
    {"id": "hynix2013", "title": "2013 SK하이닉스 중국 우시 공장 화재", "date": "2013-09-04", "asof": "2013-09-03",
     "desc": "SK하이닉스 우시 D램 공장 화재로 생산 차질(2013-09-04)", "seeds": {"000660": -1.0},
     "rivals": [("005930", 0.6), ("마이크론(미국 D램)", 0.5)]},
]


def auto_scenario(conn, N, E):
    """생산중단·재해발생 공시(2016-01~2019-06) 가운데 연결망에서 연결이 가장 많은 회사의 사건을 자동 선택."""
    deg, sup = defaultdict(int), defaultdict(int)
    for e in E:
        if e["type"] in ("납품", "지분", "투자"):
            deg[e["src"]] += 1
            deg[e["dst"]] += 1
        if e["type"] == "납품":                                          # 공급망 연결(납품)이 많은 사건을 우선
            sup[e["src"]] += 1
            sup[e["dst"]] += 1
    ev = pd.read_sql_query("""SELECT rcept_dt, stock_code AS code, corp_name, trim(report_nm) AS nm FROM dart_filings
                              WHERE (trim(report_nm) IN ('생산중단', '재해발생')) AND rcept_dt BETWEEN '20160101' AND '20190630'""", conn)
    ev = ev[ev["code"].isin([n for n in N if not n.startswith("X:")])]
    if not len(ev):
        return None
    ev["deg"] = ev["code"].map(deg).fillna(0)
    ev["sup"] = ev["code"].map(sup).fillna(0)
    r = ev.sort_values(["sup", "deg", "rcept_dt"], ascending=[False, False, True]).iloc[0]
    d = f"{r.rcept_dt[:4]}-{r.rcept_dt[4:6]}-{r.rcept_dt[6:]}"
    return {"id": "auto", "title": f"[자동 감지] {r.corp_name} {r.nm} 공시", "date": d,
            "asof": (pd.Timestamp(d) - pd.Timedelta(days=1)).strftime("%Y-%m-%d"),
            "desc": f"{d} DART '{r.nm}' 공시를 파이프라인이 자동으로 골라 연결망(직접 연결 {int(r.deg)}개, 그중 납품 {int(r.sup)}개)에 얹은 사례", "seeds": {r.code: -1.0}}


def run_scenario(conn, sc, N_all, E_all, C):
    asof = pd.Timestamp(sc["asof"])
    E = [e for e in E_all if e["date"] and pd.Timestamp(e["date"]) <= asof]   # 사건 전 정보만(경쟁·동조는 시나리오에서 새로 만듦)
    N = dict(N_all)
    seeds = dict(sc.get("seeds", {}))
    for nm, v in sc.get("seeds_ext", {}).items():
        key = "X:" + nm
        N[key] = {"id": key, "name": nm, "market": "", "sector": "해외 공급", "kind": "해외"}
        seeds[key] = v
    for a, b, t, w in sc.get("seed_links", []):
        E.append({"src": "X:" + a, "dst": b, "type": t, "w": w, "date": "", "ev": "사건 정의(수작업): 일본산 소재 의존", "rno": ""})
    for s in sc.get("substitutes", []):
        if s in C.index:
            N.setdefault(s, {"id": s, "name": C.loc[s, "name"], "market": C.loc[s, "market"], "sector": C.loc[s, "sector"], "kind": "상장"})
            E.append({"src": "X:" + list(sc["seeds_ext"])[0], "dst": s, "type": "경쟁", "w": 0.6, "date": "", "ev": "사건 정의(수작업): 국내 대체 공급 후보", "rno": ""})
    for code_or_name, w in sc.get("rivals", []):                       # 사건 정의: 주요 경쟁사(수작업)
        key = code_or_name if code_or_name in C.index else "X:" + code_or_name
        if key.startswith("X:"):
            N.setdefault(key, {"id": key, "name": code_or_name, "market": "", "sector": "해외 경쟁사", "kind": "해외"})
        else:
            N.setdefault(key, {"id": key, "name": C.loc[key, "name"], "market": C.loc[key, "market"], "sector": C.loc[key, "sector"], "kind": "상장"})
        for s in list(seeds):
            E.append({"src": s, "dst": key, "type": "경쟁", "w": w, "date": "", "ev": "사건 정의(수작업): 주요 경쟁사", "rno": ""})
    listed = [n for n in N if not n.startswith("X:")]
    mc = mcap_asof(listed, asof)
    for c in listed:
        N[c] = {**N[c], "mcap": mc.get(c)}
    P, BMp = prices(conn, listed, (asof - pd.Timedelta(days=380)).strftime("%Y-%m-%d"), asof.strftime("%Y-%m-%d"))
    R = P.pct_change(fill_method=None)
    mkt = BMp["^KS11"].pct_change(fill_method=None).reindex(R.index)
    X = R.sub(mkt, axis=0).dropna(axis=1, thresh=150)                 # 코스피 대비 초과 수익
    corr = X.corr(min_periods=150)
    add_compete(N, E, corr=corr)
    add_comove(N, E, corr)
    res = propagate(seeds, E)
    react = reactions(conn, res, N, sc["date"])
    keep = set(res)
    nodes = []
    for n, v in res.items():
        info = N.get(n, {"id": n, "name": n, "kind": "?"})
        nodes.append({**info, "mcap": info.get("mcap"), "I": round(v["I"], 4), "hop": v["hop"], "why": explain(v, N), "react": react.get(n)})
    edges = [e for e in E if e["src"] in keep and e["dst"] in keep]
    return {"id": sc["id"], "title": sc["title"], "date": sc["date"], "desc": sc["desc"], "nodes": nodes, "edges": edges,
            "summary": {"n_nodes": len(nodes), "n_edges": len(edges), "by_hop": pd.Series([x["hop"] for x in nodes]).value_counts().sort_index().to_dict(),
                        "by_type": pd.Series([e["type"] for e in edges]).value_counts().to_dict()}}


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    conn = sqlite3.connect(DB_PATH, timeout=60)
    C = companies(conn)
    N, E, stats = build_graph(conn, C)
    log.info("그래프: 노드 %d, 선 %d (%s) | 공급계약 %d건 중 상대방 연결 %d, 상장 구매자 %d", len(N), len(E),
             pd.Series([e["type"] for e in E]).value_counts().to_dict(), stats["contracts"], stats["named"], stats["listed_buyer"])
    WEB.mkdir(parents=True, exist_ok=True)
    out_index = []
    auto = auto_scenario(conn, N, E)
    for sc in SCENARIOS + ([auto] if auto else []):
        S = run_scenario(conn, sc, N, E, C)
        (WEB / f"{sc['id']}.json").write_text(json.dumps(S, ensure_ascii=False, default=str), encoding="utf-8")
        out_index.append({"id": sc["id"], "title": sc["title"], "date": sc["date"], **S["summary"]})
        log.info("시나리오 %s: %s", sc["id"], S["summary"])
    (WEB / "index.json").write_text(json.dumps({"scenarios": out_index, "graph": {"nodes": len(N), "edges": len(E), **stats}}, ensure_ascii=False, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
