"""DART 공시 원문(document.xml zip) 읽기 — 연구 저장소의 quant/disclosure.py 에서 필요한 부분만 옮김.

입력은 zip 바이트 또는 XML 문자열. 네트워크·DB 없이 동작합니다.
원문 파일은 외부에서 받은 데이터이므로 글자로만 읽고 실행하지 않습니다.
"""
from __future__ import annotations

import io
import re
import zipfile

_CELL = re.compile(r'<(TE|TD|TU)\b[^>]*ACODE="([A-Z_]+)"[^>]*>(.*?)</\1>', re.S)
_ROW = re.compile(r"<TR\b[^>]*>(.*?)</TR>", re.S)
_TAG = re.compile(r"<[^>]+>")


def xml_text(blob: bytes | str) -> str:
    if isinstance(blob, str):
        return blob
    if blob[:2] == b"PK":
        zf = zipfile.ZipFile(io.BytesIO(blob))
        parts = []
        for f in zf.namelist():
            raw = zf.read(f)
            for enc in ("utf-8", "cp949"):
                try:
                    parts.append(raw.decode(enc))
                    break
                except UnicodeDecodeError:
                    continue
        return "\n".join(parts)
    for enc in ("utf-8", "cp949"):
        try:
            return blob.decode(enc)
        except UnicodeDecodeError:
            continue
    return blob.decode("utf-8", "ignore")


def clean(s: str) -> str:
    s = _TAG.sub(" ", s.replace("&cr;", " "))
    s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", s).strip()


def _num(s: str) -> float | None:
    m = re.search(r"-?[\d,]+(?:\.\d+)?", s or "")
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def allottees(xml: str) -> list[dict]:
    """유상증자결정 원문의 제3자배정 대상자 표(ACLASS=THD_ASN_LST) 행들. 앞 행과 같다는 표시(\" 〃)는 앞 값을 이어받음."""
    out, prev = [], {}
    for g in re.findall(r'<TABLE-GROUP\b[^>]*ACLASS="THD_ASN_LST"[^>]*>(.*?)</TABLE-GROUP>', xml, re.S):
        for row in _ROW.findall(g):
            cells = {code: clean(v) for _, code, v in _CELL.findall(row)}
            if "PART" not in cells:
                continue
            for k in ("RLT", "SLT_JDG", "ETC"):
                if cells.get(k, "").strip() in ('"', "〃", "“", "”", "''"):
                    cells[k] = prev.get(k, "")
            rec = {"name": cells.get("PART", ""), "rlt": cells.get("RLT", ""), "shares": _num(cells.get("ALL_CNT", ""))}
            if rec["name"] and rec["name"] not in ("-", "합계", "계"):
                out.append(rec)
                prev = cells
    return out


_KOR_PERSON = re.compile(r"^[가-힣]{2,4}$")
_EN_PERSON = re.compile(r"^[A-Za-z][A-Za-z.\-]*(?:\s+[A-Za-z][A-Za-z.\-]*){1,3}$")
_CORP_HINT = re.compile(r"\(주\)|㈜|주식회사|회사|INC|Inc|LTD|Ltd|LLC|Co\.|CO\.|CORP|Corp|GmbH|Holdings|홀딩스|조합|펀드|Fund|FUND|Capital|Investment|증권|은행|보험|캐피탈|자산운용|파트너스")


def looks_like_person(name: str) -> bool:
    """개인 투자자 이름으로 보이면 True. 데이터 묶음에는 법인·단체만 남깁니다."""
    n = name.strip()
    if _CORP_HINT.search(n):
        return False
    return bool(_KOR_PERSON.match(n) or _EN_PERSON.match(n))
