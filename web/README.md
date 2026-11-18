# 리플 레이더 웹앱

## 구조
| 파일 | 내용 |
|---|---|
| `index.html` | 지도 앱 한 화면: 왼쪽 패널(검색·사건·미반영·관심 기업), 기업 상세(길찾기식 파급 경로·주가 반응), 지도 위 레이어 칩·확대 버튼·재생 막대. 주소 끝 `#japan2019`처럼 사건 id로 바로 열림 |
| `app.js` | 화면 로직. 데이터는 `data/index.json`, `data/<사건>.json`(파이프라인 출력) |
| `styles/tokens.css` | 디자인 토큰(색·글꼴·간격). **값을 바꿀 곳은 여기 하나** |
| `styles/app.css` | 화면 스타일. 컴포넌트는 `c-*` 이름 |
| `components.html` | 컴포넌트 시트(상태별 모음) — Figma 가져오기 원본 |
| `design/tokens.json` | Figma Tokens Studio용 토큰(light/dark 세트) |

## 로컬 실행
```bash
cd hackathon/web
python -m http.server 8000
# 브라우저에서 http://localhost:8000/#japan2019
```
데이터는 `fetch`로 읽어서, 파일을 더블클릭해 열면 동작하지 않습니다. 반드시 로컬 서버로 엽니다.

## Figma로 옮기기
1. **토큰:** Figma 플러그인 *Tokens Studio*에서 `design/tokens.json`을 불러오면 색·글꼴·간격 변수가 생깁니다. light/dark 세트를 바꿔 끼우면 테마가 바뀝니다.
2. **화면·컴포넌트:** *html.to.design* 같은 웹→Figma 변환 플러그인으로 로컬 주소(`index.html`, `components.html`)를 가져옵니다.
   - 모든 배치가 flex/grid + gap이라 Figma 오토 레이아웃으로 옮겨집니다.
   - 지도 캔버스(Cytoscape)는 그림으로 들어오므로, Figma에서는 `components.html`의 마커·도로 부품으로 다시 그리는 편이 깔끔합니다.
   - 지도 배치: 가운데 사건, 고리 = 1·2·3차 파급, 각 기업은 자기에게 영향을 넘긴 기업 바로 바깥(같은 1차 기업에서 갈라진 곳 = 한 '권역')
3. **되돌리기:** Figma에서 바꾼 색·간격은 `styles/tokens.css`와 `design/tokens.json`에 같은 이름으로 옮기면 웹에 반영됩니다.
