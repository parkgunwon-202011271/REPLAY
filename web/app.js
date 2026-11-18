// 리플 레이더 앱: 홈 · 파급 지도 · 경보. 데이터는 data/index.json, data/<사건>.json (pipeline/build.py 가 만듦)
const TYPES = ["납품", "투자", "지분", "경쟁", "동조"];
const EDGE_STYLE = { "납품": ["solid", 1], "투자": ["dashed", 0.9], "지분": ["dotted", 0.9], "경쟁": ["solid", 0.45], "동조": ["solid", 0.22] };
const STATUS_CLASS = { "반영 완료": "c-pill--done", "진행 중": "c-pill--moving", "미반영": "c-pill--waiting", "반대로 움직임": "c-pill--odd" };
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pct = x => x == null ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = { idx: null, cache: {}, S: null, cy: null, day: 0, timer: null, sel: null, on: new Set(TYPES), topN: 140, watch: ["삼성전자", "SK하이닉스"] };

async function getScenario(id) {
  if (!state.cache[id]) {
    const S = await (await fetch(`data/${id}.json`)).json();
    S.byId = Object.fromEntries(S.nodes.map(n => [n.id, n]));
    state.cache[id] = S;
  }
  return state.cache[id];
}
const statusAt = (n, d) => !n.react ? (n.id.startsWith("X:") ? "비상장" : "가격 없음") : n.react.status[Math.min(d, n.react.status.length - 1)];
const carAt = (n, d) => n.react ? n.react.car[Math.min(d, n.react.car.length - 1)] : null;

// ── 라우터 ───────────────────────────────
function route() {
  const v = (location.hash || "#home").slice(1);
  const view = ["home", "map", "alerts"].includes(v) ? v : "home";
  document.querySelectorAll(".view").forEach(s => s.hidden = s.id !== "view-" + view);
  document.querySelectorAll("[data-nav]").forEach(a => a.dataset.nav === view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (view === "map" && state.S && !state.cy) drawMap();
  if (view === "map" && state.cy) state.cy.resize();
  if (view === "alerts") renderAlerts();
}

// ── 홈 ───────────────────────────────────
async function renderHome() {
  const g = state.idx.graph;
  document.getElementById("hero-stats").innerHTML = [
    [g.nodes, "연결망 기업·기관"], [g.edges, "연결(선)"], [g.named, "공시에서 찾은 거래 관계"], [state.idx.scenarios.length, "다시 보기 사건"],
  ].map(([v, l]) => `<div class="c-stat"><span class="c-stat__value">${Number(v).toLocaleString()}</span><span class="c-stat__label">${l}</span></div>`).join("");
  const wrap = document.getElementById("event-cards");
  wrap.innerHTML = "";
  for (const sc of state.idx.scenarios) {
    const S = await getScenario(sc.id);
    const ns = S.nodes.filter(n => n.hop > 0 && n.react);
    const d = 5, cnt = s => ns.filter(n => statusAt(n, d) === s).length;
    const parts = [["반영 완료", "--color-gain"], ["진행 중", "--color-watch"], ["미반영", "--color-line"], ["반대로 움직임", "--color-odd"]];
    const tot = Math.max(ns.length, 1);
    const btn = document.createElement("button");
    btn.className = "c-panel c-event"; btn.type = "button";
    btn.innerHTML = `<span class="c-event__date">${esc(S.date)}</span><h3 class="c-event__title">${esc(S.title)}</h3>
      <div class="c-event__nums"><span>영향 기업 <b>${S.nodes.length - 1}</b></span><span>1·2·3차 <b>${[1, 2, 3].map(h => S.summary.by_hop[h] || 0).join("·")}</b></span></div>
      <div class="c-bar" title="D+5 반영 상태">${parts.map(([s, c]) => `<span style="width:${(cnt(s) / tot * 100).toFixed(1)}%;background:var(${c})"></span>`).join("")}</div>
      <span class="c-note">D+5: 반영 완료 ${cnt("반영 완료")} · 진행 중 ${cnt("진행 중")} · 미반영 ${cnt("미반영")}</span>`;
    btn.onclick = async () => { document.getElementById("scn").value = sc.id; await loadMap(sc.id); location.hash = "#map"; };
    wrap.appendChild(btn);
  }
}

// ── 파급 지도 ────────────────────────────
function visibleNodes() {
  const S = state.S;
  const seeds = S.nodes.filter(n => n.hop === 0);
  const rest = S.nodes.filter(n => n.hop > 0).sort((a, b) => Math.abs(b.I) - Math.abs(a.I)).slice(0, state.topN);
  return seeds.concat(rest);
}
function drawMap() {
  const S = state.S, vis = visibleNodes(), ids = new Set(vis.map(n => n.id));
  const maxI = Math.max(...vis.filter(n => n.hop > 0).map(n => Math.abs(n.I)), 1e-6);
  const els = vis.map(n => ({ data: { id: n.id, label: n.name, hop: n.hop, size: n.hop === 0 ? 46 : 14 + 30 * Math.sqrt(Math.abs(n.I) / maxI) } }));
  S.edges.forEach((e, i) => { if (ids.has(e.src) && ids.has(e.dst) && state.on.has(e.type)) els.push({ data: { id: "e" + i, source: e.src, target: e.dst, type: e.type, w: e.w } }); });
  if (state.cy) state.cy.destroy();
  if (document.getElementById("view-map").hidden) { state.cy = null; return; }
  state.cy = cytoscape({
    container: document.getElementById("cy"), elements: els, wheelSensitivity: 0.25,
    layout: { name: "concentric", concentric: n => 4 - n.data("hop"), levelWidth: () => 1, minNodeSpacing: 6, animate: false },
    style: [
      { selector: "node", style: { width: "data(size)", height: "data(size)", label: "data(label)", "font-size": 9, "font-family": css("--font-body"),
        color: css("--color-ink"), "text-valign": "bottom", "text-margin-y": 3, "text-outline-width": 2, "text-outline-color": css("--color-surface") } },
      { selector: "edge", style: { width: e => 0.6 + 3 * Math.min(e.data("w"), 1), "curve-style": "haystack", "line-color": css("--color-muted"),
        opacity: e => EDGE_STYLE[e.data("type")][1] * 0.55, "line-style": e => EDGE_STYLE[e.data("type")][0] } },
      { selector: "node:selected", style: { "border-width": 4, "border-color": css("--color-ink") } },
      { selector: ".dim", style: { opacity: 0.12 } },
    ],
  });
  state.cy.on("tap", "node", ev => { state.sel = ev.target.id(); focusNode(state.sel); renderCard(); });
  state.cy.on("tap", ev => { if (ev.target === state.cy) { state.sel = null; state.cy.elements().removeClass("dim"); renderCard(); } });
  paint();
}
function focusNode(id) {
  const cy = state.cy; if (!cy) return;
  cy.elements().addClass("dim");
  const n = cy.getElementById(id);
  n.removeClass("dim"); n.connectedEdges().removeClass("dim"); n.neighborhood().removeClass("dim");
}
function nodeColor(n, st) {
  if (n.id.startsWith("X:")) return css("--color-external");
  if (st === "반대로 움직임") return css("--color-odd");
  return n.I < 0 ? css("--color-harm") : css("--color-gain");
}
function paint() {
  const S = state.S, d = state.day;
  if (state.cy) state.cy.batch(() => state.cy.nodes().forEach(el => {
    const n = S.byId[el.id()], st = statusAt(n, d), c = nodeColor(n, st), hollow = st === "미반영" || st === "영향 미미";
    el.style({ "background-color": c, "background-opacity": n.hop === 0 ? 1 : hollow ? 0.08 : st === "진행 중" ? 0.55 : 0.95,
      "border-width": n.hop === 0 ? 0 : hollow ? 2.5 : 1, "border-color": hollow ? css("--color-watch") : c, "border-style": n.id.startsWith("X:") ? "dashed" : "solid" });
  }));
  const dates = S.nodes.find(n => n.react)?.react.dates || [];
  document.getElementById("dlabel").textContent = "D+" + d;
  document.getElementById("dreal").textContent = dates[Math.min(d, dates.length - 1)] || "—";
  renderStats(); renderRadar(); renderCard();
}
function renderStats() {
  const S = state.S, ns = S.nodes.filter(n => n.hop > 0), cnt = s => ns.filter(n => statusAt(n, state.day) === s).length;
  document.getElementById("stats").innerHTML =
    `<span>영향 기업 <b>${ns.length.toLocaleString()}</b></span><span>1·2·3차 <b>${[1, 2, 3].map(h => S.summary.by_hop[h] || 0).join(" / ")}</b></span>` +
    `<span>반영 완료 <b>${cnt("반영 완료")}</b></span><span>진행 중 <b>${cnt("진행 중")}</b></span><span>미반영 <b>${cnt("미반영")}</b></span>` +
    `<span>반대로 움직임 <b>${cnt("반대로 움직임")}</b></span><span>연결 ${TYPES.map(t => `${t} ${(S.summary.by_type[t] || 0).toLocaleString()}`).join(" · ")}</span>`;
}
function spark(n) {
  if (!n.react) return `<p class="c-note">상장사가 아니거나 가격 자료가 없어 주가 반응을 계산하지 않습니다.</p>`;
  const v = n.react.car, W = 300, H = 110, pad = 18;
  const lo = Math.min(0, ...v), hi = Math.max(0, ...v), y = x => H - pad - (x - lo) / ((hi - lo) || 1) * (H - 2 * pad);
  const x = i => pad + i / (v.length - 1 || 1) * (W - 2 * pad);
  const c = n.I < 0 ? css("--color-harm") : css("--color-gain"), d = Math.min(state.day, v.length - 1);
  return `<svg class="c-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="사건 뒤 누적 초과수익">
    <line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="${css("--color-line")}"/>
    <polyline points="${v.map((a, i) => `${x(i).toFixed(1)},${y(a).toFixed(1)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="2"/>
    <line x1="${x(d)}" x2="${x(d)}" y1="${pad / 2}" y2="${H - pad / 2}" stroke="${css("--color-watch")}" stroke-width="1.5"/>
    <circle cx="${x(d)}" cy="${y(v[d])}" r="3.5" fill="${c}"/>
    <text x="${pad}" y="${H - 3}" font-size="10" fill="${css("--color-muted")}">D+0</text>
    <text x="${W - pad}" y="${H - 3}" font-size="10" fill="${css("--color-muted")}" text-anchor="end">D+${v.length - 1}</text>
    <text x="${W - pad}" y="12" font-size="10" fill="${css("--color-muted")}" text-anchor="end">누적 초과수익 ${pct(v[v.length - 1])}</text></svg>`;
}
function renderCard() {
  const S = state.S, el = document.getElementById("card");
  const n = state.sel ? S.byId[state.sel] : S.nodes.filter(x => x.hop > 0).sort((a, b) => Math.abs(b.I) - Math.abs(a.I))[0];
  if (!n) { el.innerHTML = "<p class='c-note'>노드를 누르면 기업 카드가 열립니다.</p>"; return; }
  const st = statusAt(n, state.day);
  el.innerHTML = `<div><h2 class="c-card__name">${esc(n.name)}</h2><div class="c-card__meta">${esc(n.kind)}${n.market ? " · " + esc(n.market) : ""}${n.sector ? " · " + esc(n.sector) : ""}${state.sel ? "" : " · 영향 1위"}</div></div>
    <dl class="c-kv"><dt>차수</dt><dd>${n.hop === 0 ? "사건 발생 지점" : n.hop + "차"}</dd>
    <dt>예상 영향</dt><dd style="color:var(${n.I < 0 ? "--color-harm" : "--color-gain"})">${n.I < 0 ? "피해" : "수혜"} ${Math.abs(n.I).toFixed(3)}</dd>
    <dt>지금 초과수익</dt><dd>${pct(carAt(n, state.day))}</dd>
    <dt>상태</dt><dd><span class="c-pill ${STATUS_CLASS[st] || "c-pill--none"}">${esc(st)}</span></dd></dl>
    ${spark(n)}<div class="c-why"><b>왜 영향받나</b><br>${esc(n.why)}</div>`;
}
function renderRadar() {
  const S = state.S, d = state.day;
  const rows = S.nodes.filter(n => n.hop > 0 && n.react && statusAt(n, d) === "미반영").sort((a, b) => Math.abs(b.I) - Math.abs(a.I)).slice(0, 12);
  const tb = document.querySelector("#radar tbody");
  tb.innerHTML = rows.map(n => {
    const last = n.react.car[n.react.car.length - 1], hit = Math.sign(last) === Math.sign(n.I);
    const link = (n.why.split("경로: ")[1] || "").split(".")[0];
    return `<tr data-id="${esc(n.id)}"><td>${esc(n.name)}</td><td>${n.hop}차</td><td>${esc(link)}</td><td style="color:var(${n.I < 0 ? "--color-harm" : "--color-gain"})">${n.I < 0 ? "피해" : "수혜"}</td>
      <td class="num">${pct(carAt(n, d))}</td><td><span class="c-pill c-pill--waiting">미반영</span></td><td class="num" style="color:var(${hit ? "--color-gain" : "--color-muted"})">${pct(last)}${hit ? " 따라감" : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="c-note">이 날짜에는 미반영 기업이 없습니다.</td></tr>`;
  tb.querySelectorAll("tr[data-id]").forEach(tr => tr.onclick = () => { state.sel = tr.dataset.id; state.cy?.getElementById(state.sel).select(); focusNode(state.sel); renderCard(); });
}
function buildFilters() {
  const f = document.getElementById("filters");
  f.innerHTML = TYPES.map(t => `<button class="c-chip" type="button" aria-pressed="true" data-t="${t}"><span class="c-chip__line" style="border-top-style:${EDGE_STYLE[t][0]}"></span>${t}</button>`).join("") +
    `<button class="c-chip" type="button" id="more">노드 ${state.topN}개</button>`;
  f.querySelectorAll("[data-t]").forEach(b => b.onclick = () => { const t = b.dataset.t; state.on.has(t) ? state.on.delete(t) : state.on.add(t); b.setAttribute("aria-pressed", state.on.has(t)); drawMap(); });
  document.getElementById("more").onclick = e => { state.topN = state.topN === 140 ? 300 : state.topN === 300 ? 60 : 140; e.currentTarget.textContent = `노드 ${state.topN}개`; drawMap(); };
}
async function loadMap(id) {
  state.S = await getScenario(id);
  document.getElementById("desc").textContent = `${state.S.date} · ${state.S.desc}`;
  const maxd = Math.max(...state.S.nodes.filter(n => n.react).map(n => n.react.car.length - 1), 1);
  const t = document.getElementById("t"); t.max = maxd; state.day = Math.min(state.day, maxd); t.value = state.day;
  state.sel = null; drawMap();
}

// ── 경보 (과거 사건으로 만든 예시) ────────
function renderAlerts() {
  const list = document.getElementById("watch-list");
  list.innerHTML = state.watch.map(w => `<button class="c-chip" type="button" aria-pressed="true" data-w="${esc(w)}">${esc(w)} ✕</button>`).join("");
  list.querySelectorAll("[data-w]").forEach(b => b.onclick = () => { state.watch = state.watch.filter(x => x !== b.dataset.w); renderAlerts(); });
  const items = [];
  for (const sc of state.idx.scenarios) {
    const S = state.cache[sc.id]; if (!S) continue;
    for (const n of S.nodes) {
      if (n.hop === 0 || !state.watch.some(w => n.name.includes(w))) continue;
      const st5 = statusAt(n, 5);
      items.push({ date: S.date, title: `${n.name}: ${n.hop}차 연결에서 사건 — ${S.title}`, text: n.why, I: n.I, st: st5, car: carAt(n, 5) });
    }
  }
  items.sort((a, b) => Math.abs(b.I) - Math.abs(a.I));
  document.getElementById("feed").innerHTML = items.slice(0, 30).map(a => `<div class="c-panel c-alert">
      <span class="c-alert__stripe" style="background:var(${a.I < 0 ? "--color-harm" : "--color-gain"})"></span>
      <div class="c-alert__body"><span class="c-alert__title">${esc(a.title)}</span><span class="c-alert__text">${esc(a.text)}</span>
        <span class="c-alert__text">예상 ${a.I < 0 ? "피해" : "수혜"} ${Math.abs(a.I).toFixed(3)} · D+5 초과수익 ${pct(a.car)} · <span class="c-pill ${STATUS_CLASS[a.st] || "c-pill--none"}">${esc(a.st)}</span></span></div>
      <span class="c-alert__time">${esc(a.date)}</span></div>`).join("") || `<p class="c-note">관심 기업과 연결된 사건이 없습니다. 다른 기업을 추가해 보세요.</p>`;
}

async function init() {
  state.idx = await (await fetch("data/index.json")).json();
  const g = state.idx.graph;
  document.getElementById("foot").textContent = `연결망: 노드 ${g.nodes.toLocaleString()} · 선 ${g.edges.toLocaleString()} · 공급계약 공시 ${g.contracts.toLocaleString()}건에서 거래 상대 ${g.named.toLocaleString()}건 추출(상장 구매자 ${g.listed_buyer.toLocaleString()}). 자료: DART 공시, 상장사 일간 주가. 2024년 이전 사건만 사용. 사건 정의의 일부(외부 공급원, 대체 공급 후보)는 수작업입니다.`;
  const s = document.getElementById("scn");
  s.innerHTML = state.idx.scenarios.map(x => `<option value="${x.id}">${esc(x.title)}</option>`).join("");
  s.onchange = () => loadMap(s.value);
  buildFilters();
  document.getElementById("t").oninput = e => { state.day = +e.target.value; paint(); };
  document.getElementById("play").onclick = () => {
    const btn = document.getElementById("play");
    if (state.timer) { clearInterval(state.timer); state.timer = null; btn.textContent = "재생"; return; }
    btn.textContent = "멈춤";
    state.timer = setInterval(() => { const t = document.getElementById("t"); state.day = (state.day + 1) % (+t.max + 1); t.value = state.day; paint(); }, 220);
  };
  const win = document.getElementById("watch-in");
  win.onchange = () => { const v = win.value.trim(); if (v && !state.watch.includes(v)) state.watch.push(v); win.value = ""; renderAlerts(); };
  await loadMap(state.idx.scenarios[0].id);
  await renderHome();
  const names = new Set(); Object.values(state.cache).forEach(S => S.nodes.forEach(n => n.kind === "상장" && names.add(n.name)));
  document.getElementById("watch-options").innerHTML = [...names].slice(0, 400).map(n => `<option value="${esc(n)}">`).join("");
  window.addEventListener("hashchange", route);
  route();
}
init();
