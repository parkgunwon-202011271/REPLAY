# 해커톤 자료 모음: 리플 레이더 (Ripple Radar)

2026 겨울 AI 부트캠프 어워즈 해커톤(강원대, 2026-11-20~21, 홍천 비발디파크)용 자료입니다. 발표 자료는 현장에서 만들고, 이 폴더는 그 재료를 모아 둡니다.

| 파일 | 내용 |
|---|---|
| `01_service_concept.md` | 서비스 구상: 문제, 기능, 고객·가격, 경쟁 우위, 위험, 로드맵 |
| `02_evidence.md` | 시장·규제·학술 근거(출처와 확인 수준 포함) |
| `03_our_data.md` | 우리가 가진 데이터와 확인한 수치 |
| `04_design.md` | 시제품 설계: 구조, 데이터 모델, 전파·반영 엔진, AI 구성요소, 화면, 시나리오, 일정 |

- 새 주제로 참가하는 것은 팀원 합의 완료(2026-11-18).

## 실행 환경
- **데이터는 저장소에 들어 있습니다**(`data/`, 약 55MB, 2024년까지). 따로 받을 것이 없습니다. 구성과 **추가 수집 방법**은 [DATA.md](DATA.md).
- **웹앱(`web/`)**: `cd web && python -m http.server 8000` 후 `http://localhost:8000/#japan2019`.
- **파이프라인(`pipeline/`)**: `pip install -r requirements.txt` 후 `python pipeline/build.py` → `web/data/*.json`을 다시 만듭니다.
  - `collect.py`: DART 원문 추가 수집(어느 컴퓨터에서나, DART 인증키 필요)
  - `make_pack.py`: 데이터 묶음 재생성(메인 PC 전용, 주가 DB 필요)
- 인증 정보(DART·Gemini 키)는 저장소에 넣지 않고 `.env`에만 둡니다.
