/* 리플 레이더 — 지도 앱 형태의 화면 로직
   데이터: data/index.json(사건 목록), data/<사건>.json(파이프라인 출력: nodes, edges)
   지도 = Cytoscape. 가운데 사건, 바깥 고리 = 1·2·3·4차 파급, 부채꼴 구역 = 업종 */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const TYPES = [
    { key: "납품", cls: "t-supply", tip: "공급계약 공시" },
    { key: "투자", cls: "t-invest", tip: "제3자배정 증자" },
    { key: "지분", cls: "t-own", tip: "타법인 지분 5% 이상" },
    { key: "경쟁", cls: "t-comp", tip: "같은 업종·비슷한 규모·주가 상관" },
    { key: "동조", cls: "t-comove", tip: "주가가 함께 움직인 기업" },
  ];
  const TYPE_CLS = Object.fromEntries(TYPES.map((t) => [t.key, t.cls]));
  const ST = {
    done: { label: "반영 완료", pill: "done" },
    moving: { label: "진행 중", pill: "moving" },
    waiting: { label: "미반영", pill: "waiting" },
    odd: { label: "반대로 움직임", pill: "odd" },
    quiet: { label: "영향 미미", pill: "none" },
    none: { label: "주가 없음", pill: "none" },
  };
  const ST_KEY = { "반영 완료": "done", "진행 중": "moving", "미반영": "waiting", "반대로 움직임": "odd", "영향 미미": "quiet" };
  const REL = { 납품: ["납품처", "공급사"], 투자: ["투자 받은 곳", "투자자"], 지분: ["출자한 회사", "출자자"], 경쟁: ["경쟁사", "경쟁사"], 동조: ["주가 동조", "주가 동조"] };

  const state = {
    index: null, cache: {}, S: null, byId: new Map(), cy: null, day: 0, maxDay: 60, dates: [],
    timer: null, sel: null, routeOn: true, onlyWaiting: false, tab: "event", radarFilter: "waiting",
    layers: { 납품: true, 투자: true, 지분: true, 경쟁: true, 동조: false }, watch: loadWatch(), pulseToken: 0,
  };

  /* ---------------- 공통 ---------------- */
  function loadWatch() {
    try { const v = JSON.parse(localStorage.getItem("ripple.watch") || "null"); if (Array.isArray(v)) return v; } catch (e) { /* 저장소 없음 */ }
    return ["삼성전자", "SK하이닉스"];
  }
  function saveWatch() { try { localStorage.setItem("ripple.watch", JSON.stringify(state.watch)); } catch (e) { /* 무시 */ } }
  const pct = (x) => (x == null || isNaN(x) ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");
  const cap = (m) => (!m ? "" : m >= 1e12 ? (m / 1e12).toFixed(1) + "조" : Math.round(m / 1e8).toLocaleString() + "억");
  const short = (s, n = 12) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const dirOf = (n) => (n.I < 0 ? "harm" : "gain");
  const dirWord = (n) => (n.I < 0 ? "피해" : "수혜");
  function statusAt(n, d = state.day) {
    if (!n.react || !n.react.status) return "none";
    const s = n.react.status;
    return ST_KEY[s[Math.min(d, s.length - 1)]] || "quiet";
  }
  function carAt(n, d = state.day) { if (!n.react) return null; const c = n.react.car; return c[Math.min(d, c.length - 1)]; }
  const statusColor = (n, st) => (n.hop === 0 ? "var(--color-harm)" : st === "waiting" ? "var(--color-watch)" : st === "odd" ? "var(--color-odd)" : st === "none" ? "var(--color-external)" : `var(--color-${dirOf(n)})`);
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 1800);
  }
  const pill = (st) => `<span class="pill pill--${ST[st].pill}">${ST[st].label}</span>`;

  /* ---------------- 데이터 ---------------- */
  async function getJSON(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }
  async function getScenario(id) {
    if (!state.cache[id]) state.cache[id] = await getJSON(`data/${id}.json`);
    return state.cache[id];
  }

  /* ---------------- 지도 배치: 방사형 트리 ----------------
     가운데 사건, 고리 = 차수. 각 기업은 자기에게 영향을 넘긴 기업(경로의 앞 칸) 바로 바깥에 놓여
     같은 1차 기업에서 갈라진 기업들이 한 '권역'을 이룸 */
  const RING = 320;
  function layout(S) {
    const pos = {};
    const seeds = S.nodes.filter((n) => n.hop === 0);
    seeds.forEach((n, i) => (pos[n.id] = { x: (i - (seeds.length - 1) / 2) * 90, y: 0 }));
    const rest = S.nodes.filter((n) => n.hop > 0);
    const kids = new Map();
    const parentOf = (n) => (n.route && n.route.length > 1 ? n.route[n.route.length - 2].id : "__root");
    for (const n of rest) {
      const p = state.byId.has(parentOf(n)) || parentOf(n) === "__root" ? parentOf(n) : "__root";
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    }
    const sizeMemo = new Map();
    const size = (id) => {
      if (sizeMemo.has(id)) return sizeMemo.get(id);
      const v = 1 + (kids.get(id) || []).reduce((s, k) => s + size(k.id), 0);
      sizeMemo.set(id, v); return v;
    };
    const maxHop = Math.max(1, ...rest.map((n) => n.hop));
    const districts = [];
    const place = (list, a0, a1, h) => {
      if (!list.length) return;
      const tot = list.reduce((s, n) => s + size(n.id), 0);
      const r = RING * h;
      const avg = ((a1 - a0) * r) / list.length;
      const rows = avg >= 76 ? 1 : Math.min(3, Math.ceil(76 / Math.max(avg, 1)));
      let a = a0;
      list.forEach((n, i) => {
        const w = ((a1 - a0) * size(n.id)) / tot;
        const m = a + w / 2;
        const rr = r + (rows > 1 ? ((i % rows) - (rows - 1) / 2) * 78 : 0);
        pos[n.id] = { x: Math.cos(m) * rr, y: Math.sin(m) * rr };
        place((kids.get(n.id) || []).sort(order), a, a + w, h + 1);
        if (h === 1 && size(n.id) >= 4) districts.push({ label: `${short(n.name, 10)} 권역`, ang: m });
        a += w;
      });
    };
    const order = (x, y) => (x.sector || "").localeCompare(y.sector || "") || Math.abs(y.I) - Math.abs(x.I);
    const GAP = 0.5;                                 // 맨 위는 비워 두고 고리 이름을 씀
    place((kids.get("__root") || []).sort(order), -Math.PI / 2 + GAP / 2, Math.PI * 1.5 - GAP / 2, 1);
    return { pos, districts, maxHop };
  }

  /* ---------------- 지도 스타일 ---------------- */
  function mapStyle() {
    const c = (v) => css(v);
    const font = '"Noto Sans KR", "Malgun Gothic", sans-serif';
    return [
      { selector: "node.co", style: {
        width: "data(size)", height: "data(size)", "background-color": "data(bg)", "background-opacity": "data(bgo)",
        "border-width": "data(bw)", "border-color": "data(bc)", label: "data(label)", "font-family": font, "font-size": "data(fs)",
        "font-weight": 700, color: c("--color-ink"), "text-valign": "bottom", "text-margin-y": 4, "text-outline-color": c("--map-ground"),
        "text-outline-width": 3, "min-zoomed-font-size": 8, "z-index": 10, "overlay-opacity": 0,
        "transition-property": "background-color, border-color, background-opacity, border-width", "transition-duration": "260ms",
      } },
      { selector: "node.ext", style: { shape: "round-rectangle" } },
      { selector: "node.seed", style: { "font-weight": 800, "z-index": 40, "text-margin-y": 8, "min-zoomed-font-size": 0, "text-outline-width": 4 } },
      { selector: "node.ring", style: {
        width: "data(size)", height: "data(size)", "background-opacity": 0, "border-width": 1.6, "border-style": "dashed",
        "border-color": c("--map-ring"), label: "data(label)", "text-valign": "top", "text-margin-y": 14, color: c("--map-district"),
        "font-family": '"Noto Sans KR", "Malgun Gothic", sans-serif', "text-outline-color": c("--map-ground"),
        "font-size": 30, "font-weight": 700, "min-zoomed-font-size": 0, events: "no", "z-index": 0, "text-outline-width": 5,
        "transition-property": "none",
      } },
      { selector: "node.district", style: {
        width: 1, height: 1, "background-opacity": 0, "border-width": 0, label: "data(label)", "text-valign": "center",
        "font-size": 44, "font-weight": 800, color: c("--map-district"), "text-opacity": 0.8, "font-family": '"Noto Sans KR", "Malgun Gothic", sans-serif',
        "text-max-width": 520, "text-wrap": "wrap", "text-outline-width": 0,
        events: "no", "min-zoomed-font-size": 5, "z-index": 1, "transition-property": "none",
      } },
      { selector: "node.pulse", style: {
        width: 56, height: 56, "background-color": c("--color-harm"), "background-opacity": 0.22, "border-width": 0,
        label: "", events: "no", "z-index": 5, "transition-property": "none",
      } },
      { selector: "node.hover", style: { "min-zoomed-font-size": 0, "z-index": 90, "font-size": 26 } },
      { selector: "edge", style: {
        "curve-style": "bezier", width: 2, "line-color": c("--road-minor"), opacity: 0.95, "z-index": 2,
        "underlay-color": c("--road-minor-casing"), "underlay-padding": 1, "underlay-opacity": 1, "overlay-opacity": 0,
      } },
      { selector: "edge.t-supply", style: {
        width: "data(wd)", "line-color": c("--road-major"), "underlay-color": c("--road-major-casing"), "underlay-padding": 1.2,
        "target-arrow-shape": "triangle", "target-arrow-color": c("--road-major-casing"), "arrow-scale": 0.7, "z-index": 4, opacity: 0.85,
      } },
      { selector: "edge.t-invest", style: { width: 3 } },
      { selector: "edge.t-own", style: { width: 2, "line-color": c("--road-rail"), "line-style": "dashed", "line-dash-pattern": [7, 4], "underlay-opacity": 0 } },
      { selector: "edge.t-comp", style: { width: 1.6, "line-color": c("--road-trail"), "line-style": "dashed", "line-dash-pattern": [3, 4], "underlay-opacity": 0 } },
      { selector: "edge.t-comove", style: { width: 1.3, "line-color": c("--road-trail"), "line-style": "dotted", opacity: 0.7, "underlay-opacity": 0 } },
      { selector: ".off", style: { display: "none" } },
      { selector: "node.faded", style: { opacity: 0.22 } },
      { selector: "edge.faded", style: { opacity: 0.07 } },
      { selector: "edge.route", style: {
        width: 7, "line-color": c("--route"), "line-style": "solid", "underlay-color": c("--route-casing"), "underlay-padding": 2.5,
        "underlay-opacity": 1, opacity: 1, "z-index": 80, "target-arrow-shape": "none",
      } },
      { selector: "node.route", style: { "border-color": c("--route"), "border-width": 4, "z-index": 85, "min-zoomed-font-size": 0 } },
      { selector: "node.picked", style: { "border-color": c("--route"), "border-width": 6, "z-index": 95, "min-zoomed-font-size": 0, "font-size": 24 } },
    ];
  }

  function nodeLook(n) {
    if (n.hop === 0) return { bg: css("--color-harm"), bgo: 1, bc: css("--color-surface"), bw: 4 };
    const dir = css(`--color-${dirOf(n)}`), surf = css("--color-surface");
    switch (statusAt(n)) {
      case "done": return { bg: dir, bgo: 1, bc: surf, bw: 2.5 };
      case "moving": return { bg: dir, bgo: 0.5, bc: dir, bw: 2.5 };
      case "waiting": return { bg: dir, bgo: 0.2, bc: css("--color-watch"), bw: 4 };
      case "odd": return { bg: css("--color-odd"), bgo: 1, bc: surf, bw: 2.5 };
      case "quiet": return { bg: dir, bgo: 0.16, bc: css("--color-external"), bw: 1.5 };
      default: return { bg: css("--color-external"), bgo: 1, bc: surf, bw: 2 };
    }
  }

  /* ---------------- 지도 그리기 ---------------- */
  function buildMap() {
    const S = state.S;
    const L = layout(S);
    const els = [];
    for (let h = 1; h <= L.maxHop; h++) els.push({ group: "nodes", data: { id: `ring-${h}`, size: 2 * RING * h, label: `${h}차 파급` }, position: { x: 0, y: 0 }, classes: "ring", selectable: false, grabbable: false });
    L.districts.forEach((d, i) => {
      const r = RING * L.maxHop + 210;
      els.push({ group: "nodes", data: { id: `dist-${i}`, label: d.label }, position: { x: Math.cos(d.ang) * r, y: Math.sin(d.ang) * r }, classes: "district", selectable: false, grabbable: false });
    });
    const seed = S.nodes.find((n) => n.hop === 0);
    if (seed) els.push({ group: "nodes", data: { id: "pulse" }, position: { ...L.pos[seed.id] }, classes: "pulse", selectable: false, grabbable: false });
    for (const n of S.nodes) {
      const a = Math.min(1, Math.abs(n.I));
      els.push({
        group: "nodes", position: L.pos[n.id] || { x: 0, y: 0 }, grabbable: false,
        classes: [n.hop === 0 ? "seed" : "", n.kind !== "상장" && !n.react ? "ext" : "", "co"].join(" "),
        data: { id: n.id, label: n.hop === 0 ? short(n.name, 18) : short(n.name), size: n.hop === 0 ? 60 : 16 + 44 * Math.sqrt(a), fs: n.hop === 0 ? 30 : 11 + 16 * Math.sqrt(a), ...nodeLook(n) },
      });
    }
    const merged = new Map();                       // 같은 두 곳·같은 종류의 연결(계약 여러 건)은 선 하나로
    for (const e of S.edges) {
      if (!state.byId.has(e.src) || !state.byId.has(e.dst)) continue;
      const k = [e.src, e.dst].sort().join("|") + "|" + e.type;
      const m = merged.get(k);
      if (m) { m.w += e.w || 0; m.n += 1; } else merged.set(k, { src: e.src, dst: e.dst, type: e.type, w: e.w || 0, n: 1 });
    }
    [...merged.values()].forEach((e, i) => {
      els.push({ group: "edges", data: { id: `e${i}`, source: e.src, target: e.dst, type: e.type, n: e.n, wd: Math.min(6, 2 + 4 * Math.sqrt(Math.min(e.w, 1))) }, classes: TYPE_CLS[e.type] || "" });
    });

    if (state.cy) state.cy.destroy();
    const cy = (state.cy = cytoscape({
      container: $("#map"), elements: els, layout: { name: "preset" }, style: mapStyle(),
      minZoom: 0.06, maxZoom: 3, boxSelectionEnabled: false, autoungrabify: true,
    }));
    cy.on("tap", "node.co", (ev) => select(ev.target.id(), { fly: false }));
    cy.on("tap", (ev) => { if (ev.target === cy) closeDetail(); });
    cy.on("mouseover", "node.co", (ev) => { ev.target.addClass("hover"); $("#map").style.cursor = "pointer"; });
    cy.on("mouseout", "node.co", (ev) => { ev.target.removeClass("hover"); $("#map").style.cursor = ""; });
    applyLayers();
    fitAll(false);
    reveal(L.maxHop);
    pulse();
  }

  /* 사건이 바깥으로 번지는 첫 장면 */
  function reveal(maxHop) {
    if (reduced) return;
    const cy = state.cy;
    for (let h = 1; h <= maxHop; h++) {
      const ring = cy.$id(`ring-${h}`), size = ring.data("size");
      const nodes = cy.nodes(".co").filter((n) => state.byId.get(n.id()).hop === h);
      const edges = nodes.connectedEdges();
      ring.style({ width: 0, height: 0 }); nodes.style("opacity", 0); edges.style("opacity", 0);
      setTimeout(() => {
        if (ring.removed()) return;
        ring.animate({ style: { width: size, height: size } }, { duration: 520, easing: "ease-out-cubic", complete: () => ring.removeStyle("width height") });
        nodes.animate({ style: { opacity: 1 } }, { duration: 380, complete: () => nodes.removeStyle("opacity") });
        edges.animate({ style: { opacity: 1 } }, { duration: 380, complete: () => edges.removeStyle("opacity") });
      }, 250 + (h - 1) * 420);
    }
  }
  function pulse() {
    const p = state.cy.$id("pulse");
    if (!p.length || reduced) return;
    const token = ++state.pulseToken;
    const loop = () => {
      if (token !== state.pulseToken || p.removed()) return;
      p.style({ width: 50, height: 50, "background-opacity": 0.3 });
      p.animate({ style: { width: 190, height: 190, "background-opacity": 0 } }, { duration: 1900, easing: "ease-out-quad", complete: () => setTimeout(loop, 250) });
    };
    loop();
  }

  function paint() {
    const cy = state.cy; if (!cy) return;
    cy.batch(() => cy.nodes(".co").forEach((el) => el.data(nodeLook(state.byId.get(el.id())))));
    applyFocus();
  }
  function applyLayers() {
    const cy = state.cy;
    cy.batch(() => cy.edges().forEach((e) => e.toggleClass("off", !state.layers[e.data("type")])));
    applyFocus();
  }

  /* 선택 경로 강조 · 미반영만 보기 */
  function routeIds(n) {
    if (n.hop === 0) return [n.id];
    const ids = n.route.map((r) => r.id);
    const first = ids[0];
    const seeds = state.S.nodes.filter((x) => x.hop === 0).map((x) => x.id);
    const origin = seeds.find((s) => state.S.edges.some((e) => (e.src === s && e.dst === first) || (e.dst === s && e.src === first))) || seeds[0];
    return [origin, ...ids];
  }
  function applyFocus() {
    const cy = state.cy; if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass("faded route picked");
      const n = state.sel && state.byId.get(state.sel);
      if (n && state.routeOn && n.hop > 0) {
        const ids = routeIds(n);
        let keep = cy.collection();
        ids.forEach((id, i) => {
          keep = keep.union(cy.$id(id));
          if (i) {
            const a = ids[i - 1], b = id;
            keep = keep.union(cy.edges().filter((x) => (x.data("source") === a && x.data("target") === b) || (x.data("source") === b && x.data("target") === a)).first());
          }
        });
        cy.elements(".co, edge").not(keep).addClass("faded");
        keep.addClass("route");
        keep.edges().removeClass("off");
      } else if (state.onlyWaiting) {
        const keep = cy.nodes(".co").filter((el) => { const x = state.byId.get(el.id()); return x.hop === 0 || statusAt(x) === "waiting"; });
        cy.elements(".co, edge").not(keep).not(keep.edgesWith(keep)).addClass("faded");
      }
      if (n) cy.$id(n.id).addClass("picked");
    });
  }

  /* 패널에 가리지 않는 지도 영역 */
  function visibleRect() {
    const W = innerWidth, H = innerHeight;
    if (W <= 760) {
      const sheet = !$("#detail").hidden ? $("#detail") : $("#side");
      return { x0: 0, x1: W, y0: 60, y1: Math.max(160, sheet.getBoundingClientRect().top - 80) };
    }
    let x0 = 0;
    if (!$("#app").classList.contains("panel-hidden")) x0 = $("#side").getBoundingClientRect().right;
    if (!$("#detail").hidden) x0 = $("#detail").getBoundingClientRect().right;
    return { x0: x0 + 12, x1: W - 64, y0: 64, y1: H - 90 };
  }
  function fitTo(eles, animate = true, maxZoom = 1.4) {
    const cy = state.cy; if (!cy || !eles.length) return;
    const R = visibleRect(), bb = eles.boundingBox({ includeLabels: false });
    const z = Math.max(0.06, Math.min(maxZoom, Math.min((R.x1 - R.x0) / (bb.w + 120), (R.y1 - R.y0) / (bb.h + 120))));
    const cx = (R.x0 + R.x1) / 2, cyy = (R.y0 + R.y1) / 2;
    const pan = { x: cx - (bb.x1 + bb.w / 2) * z, y: cyy - (bb.y1 + bb.h / 2) * z };
    if (animate && !reduced) cy.animate({ zoom: z, pan }, { duration: 450, easing: "ease-in-out-cubic" });
    else cy.viewport({ zoom: z, pan });
  }
  const fitAll = (animate = true) => fitTo(state.cy.nodes(".co, .ring"), animate, 1.2);

  /* ---------------- 선택 ---------------- */
  function select(id, { fly = true } = {}) {
    const n = state.byId.get(id); if (!n) return;
    state.sel = id;
    renderDetail();
    applyFocus();
    if (state.tab === "radar") renderRadar();
    if (fly) {
      const cy = state.cy;
      const ids = state.routeOn ? routeIds(n) : [id];
      const eles = cy.collection().union(ids.map((x) => cy.$id(x)));
      requestAnimationFrame(() => fitTo(eles, true, 0.8));
    }
  }
  function closeDetail() {
    if (!state.sel) return;
    state.sel = null;
    $("#detail").hidden = true;
    $("#app").classList.remove("has-detail");
    applyFocus();
    if (state.tab === "radar") renderRadar();
  }

  /* ---------------- 상세 패널 ---------------- */
  function chartSVG(n) {
    const r = n.react; if (!r) return `<p class="note" style="padding:0">상장 주식이 아니라 주가 반응을 계산하지 않습니다.</p>`;
    const W = 360, H = 150, L = 48, Rr = 10, T = 12, B = 22;
    const car = r.car, max = state.maxDay;
    let lo = Math.min(0, ...car), hi = Math.max(0, ...car);
    const padv = (hi - lo) * 0.12 || 0.02; lo -= padv; hi += padv;
    const x = (i) => L + ((W - L - Rr) * i) / max, y = (v) => T + ((H - T - B) * (hi - v)) / (hi - lo);
    const pts = car.slice(0, max + 1).map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const col = `var(--color-${dirOf(n)})`;
    const d = Math.min(state.day, car.length - 1), cv = car[d];
    const area = `M${x(0)},${y(0)} L${pts.join(" L")} L${x(car.length - 1)},${y(0)} Z`;
    const ticks = [0, 20, 40, 60].filter((t) => t <= max);
    const top = hi - padv, bot = lo + padv;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="사건 뒤 ${max}거래일 지수 대비 누적 초과수익, D+${d} ${pct(cv)}">
      ${top > 0.005 ? `<line x1="${L}" x2="${W - Rr}" y1="${y(top)}" y2="${y(top)}" stroke="var(--color-line)"/><text x="${L - 6}" y="${y(top) + 4}" text-anchor="end">${pct(top)}</text>` : ""}
      ${bot < -0.005 ? `<line x1="${L}" x2="${W - Rr}" y1="${y(bot)}" y2="${y(bot)}" stroke="var(--color-line)"/><text x="${L - 6}" y="${y(bot) + 4}" text-anchor="end">${pct(bot)}</text>` : ""}
      <line x1="${L}" x2="${W - Rr}" y1="${y(0)}" y2="${y(0)}" stroke="var(--color-muted)" stroke-dasharray="3 3"/>
      <text x="${L - 6}" y="${y(0) + 4}" text-anchor="end">0%</text>
      <path d="${area}" fill="${col}" fill-opacity=".12"/>
      <polyline points="${pts.join(" ")}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>
      <line x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${H - B}" stroke="var(--route)" stroke-width="1.5"/>
      <circle cx="${x(d)}" cy="${y(cv)}" r="4.5" fill="${col}" stroke="var(--color-surface)" stroke-width="2"/>
      ${ticks.map((t) => `<text x="${x(t)}" y="${H - 6}" text-anchor="${t === 0 ? "start" : t === max ? "end" : "middle"}">D+${t}</text>`).join("")}
    </svg>`;
  }

  function routeHTML(n) {
    if (n.hop === 0) return `<p class="note" style="padding:0">사건이 시작된 곳입니다.</p>`;
    const origin = state.byId.get(routeIds(n)[0]);
    const soft = (t) => t === "경쟁" || t === "동조";
    const stops = [`<li class="route__stop route__stop--start"><div class="route__rail"><span class="route__pin"></span><span class="route__line ${soft(n.route[0].type) ? "route__line--dash" : ""}"></span></div>
      <div class="route__body"><span class="route__name" style="cursor:default">${esc(origin ? origin.name : state.S.title)}</span><span class="route__ev"><span class="mono">${esc(state.S.date)}</span> 사건 발생</span></div></li>`];
    n.route.forEach((st, i) => {
      const node = state.byId.get(st.id) || { name: st.id };
      const next = n.route[i + 1];
      stops.push(`<li class="route__stop ${next ? "" : "route__stop--end"}"><div class="route__rail"><span class="route__pin"></span>${next ? `<span class="route__line ${soft(next.type) ? "route__line--dash" : ""}"></span>` : ""}</div>
        <div class="route__body">
          <span class="route__how"><span class="route__type">${esc(st.type)}</span><span>${esc(st.rule)}</span></span>
          <button class="route__name" type="button" data-go="${esc(st.id)}">${esc(node.name)}</button>
          ${st.ev ? `<span class="route__ev">${esc(st.ev)}</span>` : ""}
        </div></li>`);
    });
    return `<ol class="route">${stops.join("")}</ol>`;
  }

  function neighborsHTML(n) {
    const rows = [];
    for (const e of state.S.edges) {
      let other, out;
      if (e.src === n.id) { other = e.dst; out = true; } else if (e.dst === n.id) { other = e.src; out = false; } else continue;
      const o = state.byId.get(other); if (!o) continue;
      rows.push({ o, e, rel: (REL[e.type] || ["연결", "연결"])[out ? 0 : 1] });
    }
    rows.sort((a, b) => (a.e.type === "납품" ? 0 : 1) - (b.e.type === "납품" ? 0 : 1) || Math.abs(b.o.I) - Math.abs(a.o.I));
    if (!rows.length) return `<p class="note" style="padding:0">이 사건 지도 안의 직접 연결이 없습니다.</p>`;
    return `<ul class="list" style="margin:0 calc(var(--space-4) * -1)">${rows.slice(0, 12).map(({ o, e, rel }) => {
      const st = statusAt(o);
      return `<li><button class="place" type="button" data-go="${esc(o.id)}">
        <span class="place__rank" style="background:${statusColor(o, st)}">${o.hop}</span>
        <span class="place__body"><span class="place__name">${esc(o.name)}</span><span class="place__meta">${esc(rel)} · ${esc(e.type)}${e.date ? " · " + esc(e.date) : ""}</span></span>
        <span class="place__side">${o.hop === 0 ? "" : pill(st)}</span></button></li>`;
    }).join("")}</ul>${rows.length > 12 ? `<p class="note" style="padding:var(--space-2) 0 0">외 ${rows.length - 12}곳</p>` : ""}`;
  }

  function renderDetail() {
    const n = state.byId.get(state.sel); if (!n) return;
    const st = statusAt(n), car = carAt(n);
    const a = Math.min(1, Math.abs(n.I));
    const evs = new Set((n.route || []).map((s) => s.ev).filter(Boolean));
    const rno = ([...state.S.edges].reverse().find((e) => e.rno && evs.has(e.ev)) || state.S.edges.find((e) => e.rno && (e.src === n.id || e.dst === n.id)) || {}).rno;
    const watched = state.watch.includes(n.name);
    const meta = [n.kind, n.market, n.sector, n.mcap ? "시총 " + cap(n.mcap) : ""].filter(Boolean).join(" · ");
    const el = $("#detail");
    el.innerHTML = `<div class="detail__scroll">
      <div class="detail__hero">
        <button class="detail__close" type="button" id="closeDetail" aria-label="상세 닫기"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
        <h2 class="detail__name">${esc(n.name)}</h2>
        <span class="detail__meta">${esc(meta)}</span>
        <div class="detail__status">${n.hop === 0 ? `<span class="pill" style="color:var(--color-harm);background:color-mix(in srgb,var(--color-harm) 13%,transparent)">사건 발생지</span>` : pill(st)}
          ${car != null ? `<span>D+${state.day} 초과수익 <b class="num ${car < 0 ? "harm" : "gain"}">${pct(car)}</b></span>` : ""}</div>
      </div>
      <div class="actions">
        <button class="action" type="button" id="actRoute" aria-pressed="${state.routeOn}"><span class="action__icon"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="2.5" fill="currentColor"/><circle cx="18" cy="6" r="2.5" fill="currentColor"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" fill="none" stroke="currentColor" stroke-width="2"/></svg></span>경로 보기</button>
        <button class="action" type="button" id="actWatch" aria-pressed="${watched}"><span class="action__icon"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="${watched ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>${watched ? "관심 해제" : "관심 등록"}</button>
        <a class="action" ${rno ? `href="https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${esc(rno)}" target="_blank" rel="noopener"` : `aria-disabled="true"`}><span class="action__icon"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5M10 13h6M10 17h6" stroke="currentColor" stroke-width="1.8"/></svg></span>공시 원문</a>
        <button class="action" type="button" id="actCopy"><span class="action__icon"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span>요약 복사</button>
      </div>
      <section class="section"><h3 class="section__title">예상 영향 <small>사건 자체 = 1.0</small></h3>
        <div class="meter" aria-hidden="true"><span style="${n.I < 0 ? `right:50%;width:${a * 50}%` : `left:50%;width:${a * 50}%`};background:var(--color-${dirOf(n)})"></span></div>
        <dl class="kv"><dt>방향</dt><dd class="${dirOf(n)}">${dirWord(n)} 예상</dd><dt>강도</dt><dd>${Math.abs(n.I).toFixed(3)}</dd><dt>차수</dt><dd>${n.hop === 0 ? "사건" : n.hop + "차 파급"}</dd></dl>
      </section>
      <section class="section"><h3 class="section__title">파급 경로 <small>사건에서 이 기업까지</small></h3>${routeHTML(n)}</section>
      <section class="section"><h3 class="section__title">주가 반응 <small>지수 대비 누적 초과수익</small></h3>${chartSVG(n)}</section>
      <section class="section"><h3 class="section__title">직접 연결된 곳</h3>${neighborsHTML(n)}</section>
    </div>`;
    el.hidden = false;
    $("#app").classList.add("has-detail");
    $("#closeDetail").onclick = closeDetail;
    $("#actRoute").onclick = () => { state.routeOn = !state.routeOn; renderDetail(); applyFocus(); };
    $("#actWatch").onclick = () => {
      state.watch = watched ? state.watch.filter((w) => w !== n.name) : [...state.watch, n.name];
      saveWatch(); renderDetail(); if (state.tab === "watch") renderWatch();
      toast(watched ? `${n.name} 관심 해제` : `${n.name}을(를) 관심 기업에 넣었습니다`);
    };
    $("#actCopy").onclick = () => {
      const txt = `[리플 레이더] ${state.S.title}\n${n.name}: ${dirWord(n)} 예상 ${Math.abs(n.I).toFixed(3)}, ${ST[st].label}${car != null ? `, D+${state.day} 초과수익 ${pct(car)}` : ""}\n${n.why}`;
      try {
        navigator.clipboard.writeText(txt).then(() => toast("요약을 복사했습니다"), () => toast("복사가 막혀 있습니다. 경로 글을 직접 선택해 복사하세요"));
      } catch (e) { toast("복사가 막혀 있습니다. 경로 글을 직접 선택해 복사하세요"); }
    };
    el.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => select(b.dataset.go)));
  }

  /* ---------------- 왼쪽 패널 ---------------- */
  function counts() {
    const c = { done: 0, moving: 0, waiting: 0, odd: 0, quiet: 0, none: 0 };
    state.S.nodes.forEach((n) => { if (n.hop > 0) c[statusAt(n)]++; });
    return c;
  }
  function placeRow(n, i) {
    const st = statusAt(n), car = carAt(n);
    return `<li><button class="place" type="button" data-go="${esc(n.id)}" aria-current="${state.sel === n.id}">
      <span class="place__rank" style="background:${statusColor(n, st)}">${i}</span>
      <span class="place__body"><span class="place__name">${esc(n.name)}</span>
        <span class="place__meta">${n.hop}차 · ${esc(n.sector || n.kind)} · <span class="${dirOf(n)}">${dirWord(n)} ${Math.abs(n.I).toFixed(3)}</span></span></span>
      <span class="place__side">${car != null ? `<span class="place__car ${car < 0 ? "harm" : "gain"}">${pct(car)}</span>` : ""}${pill(st)}</span>
    </button></li>`;
  }
  function thumb(sc) {
    const hops = Object.keys(sc.by_hop || {}).map(Number).filter((h) => h > 0);
    const mh = Math.max(1, ...hops);
    const rings = Array.from({ length: mh }, (_, i) => `<circle cx="28" cy="28" r="${(7 + (i + 1) * (19 / mh)).toFixed(1)}" fill="none" stroke="var(--map-ring)" stroke-width="1.2" stroke-dasharray="2 2"/>`).join("");
    return `<svg class="event__thumb" viewBox="0 0 56 56" aria-hidden="true"><rect width="56" height="56" rx="10" fill="var(--map-ground)"/>${rings}<circle cx="28" cy="28" r="5" fill="var(--color-harm)"/></svg>`;
  }
  function renderEvent() {
    const S = state.S, c = counts();
    const impacted = S.nodes.filter((n) => n.hop > 0);
    const maxHop = Math.max(0, ...impacted.map((n) => n.hop));
    const byHop = {}; impacted.forEach((n) => (byHop[n.hop] = (byHop[n.hop] || 0) + 1));
    const maxH = Math.max(1, ...Object.values(byHop));
    const top = [...impacted].sort((a, b) => Math.abs(b.I) - Math.abs(a.I)).slice(0, 6);
    const tot = impacted.length || 1;
    const seg = (k, col) => `<span style="width:${(c[k] / tot) * 100}%;background:${col}"></span>`;
    const g = state.index.graph;
    $("#pane-event").innerHTML = `
      <div class="ev-head"><span class="ev-head__kicker"><span class="dot" style="background:var(--color-harm)"></span>사건 · <span class="mono">${esc(S.date)}</span></span>
        <h1 class="ev-head__title">${esc(S.title)}</h1><p class="ev-head__desc">${esc(S.desc)}</p></div>
      <div class="facts"><div class="fact"><span class="fact__v">${impacted.length}</span><span class="fact__l">영향 기업·기관</span></div>
        <div class="fact"><span class="fact__v">${S.edges.length}</span><span class="fact__l">연결(선)</span></div>
        <div class="fact"><span class="fact__v">${maxHop}차</span><span class="fact__l">가장 먼 파급</span></div></div>
      <section class="section"><h2 class="section__title">주가 반영 현황 <small class="mono">D+${state.day}</small></h2>
        <div class="stack" role="img" aria-label="반영 완료 ${c.done}, 진행 중 ${c.moving}, 미반영 ${c.waiting}, 반대 ${c.odd}">
          ${seg("done", "var(--color-accent)")}${seg("moving", "var(--color-gain)")}${seg("waiting", "var(--color-watch)")}${seg("odd", "var(--color-odd)")}${seg("quiet", "var(--map-ring)")}${seg("none", "var(--color-external)")}</div>
        <div class="stack-legend">
          <span><span class="dot" style="background:var(--color-accent)"></span> 반영 완료 <b>${c.done}</b></span>
          <span><span class="dot" style="background:var(--color-gain)"></span> 진행 중 <b>${c.moving}</b></span>
          <span><span class="dot" style="background:var(--color-watch)"></span> 미반영 <b>${c.waiting}</b></span>
          <span><span class="dot" style="background:var(--color-odd)"></span> 반대 <b>${c.odd}</b></span>
          <span><span class="dot" style="background:var(--map-ring)"></span> 미미 <b>${c.quiet}</b></span>
          <span><span class="dot" style="background:var(--color-external)"></span> 비상장 <b>${c.none}</b></span></div></section>
      <section class="section"><h2 class="section__title">차수별 기업 수</h2>
        <div class="hops">${Object.keys(byHop).sort().map((h) => `<span>${h}차</span><span class="hops__bar"><span style="width:${(byHop[h] / maxH) * 100}%"></span></span><b class="num">${byHop[h]}</b>`).join("")}</div></section>
      <section class="section" style="padding-bottom:0;border:0"><h2 class="section__title">영향이 큰 곳</h2></section>
      <ul class="list">${top.map((n, i) => placeRow(n, i + 1)).join("")}</ul>
      <section class="section" style="padding-bottom:var(--space-2);border:0"><h2 class="section__title">다른 사건</h2></section>
      <div class="events">${state.index.scenarios.map((sc) => `<button class="event" type="button" data-sc="${esc(sc.id)}" aria-current="${sc.id === S.id}">${thumb(sc)}
        <span class="event__body"><span class="event__title">${esc(sc.title)}</span><span class="event__meta"><span class="mono">${esc(sc.date)}</span> · 기업 ${sc.n_nodes - 1}곳 · 연결 ${sc.n_edges}개</span></span></button>`).join("")}</div>
      <p class="note">연결망: 기업·기관 ${g.nodes.toLocaleString()}곳, 연결 ${g.edges.toLocaleString()}개. DART 공급계약 ${g.contracts.toLocaleString()}건(상대방 확인 ${g.named.toLocaleString()}건), 제3자배정 증자, 타법인 출자 공시로 만들었습니다. 시제품 표본은 전자·화학 업종, 2012~2013년과 2016~2019년 상반기입니다.</p>`;
    bindGo($("#pane-event"));
    $("#pane-event").querySelectorAll("[data-sc]").forEach((b) => (b.onclick = () => loadScenario(b.dataset.sc)));
  }
  function renderRadar() {
    const c = counts();
    $("#radarCount").textContent = c.waiting;
    const F = [["waiting", "미반영"], ["moving", "진행 중"], ["odd", "반대로 움직임"], ["done", "반영 완료"], ["all", "전체"]];
    const all = state.S.nodes.filter((n) => n.hop > 0 && n.react);
    const list = all.filter((n) => state.radarFilter === "all" || statusAt(n) === state.radarFilter).sort((a, b) => Math.abs(b.I) - Math.abs(a.I));
    const lead = {
      waiting: `예상 영향은 있는데 D+${state.day}까지 주가가 아직 움직이지 않은 상장사입니다. 영향이 큰 순서입니다.`,
      moving: "예상 방향으로 움직이기 시작했지만 아직 뚜렷하지 않은 곳입니다.",
      odd: "예상과 반대로 움직인 곳입니다. 연결 관계를 다시 볼 필요가 있습니다.",
      done: "예상 방향으로 이미 크게 움직인 곳입니다.", all: "주가가 있는 영향 기업 전체입니다.",
    }[state.radarFilter];
    $("#pane-radar").innerHTML = `<div class="seg" role="group" aria-label="반영 상태로 거르기">${F.map(([k, l]) => `<button class="chip" type="button" data-f="${k}" aria-pressed="${state.radarFilter === k}">${l} <span class="chip__count">${k === "all" ? all.length : c[k]}</span></button>`).join("")}</div>
      <p class="note">${lead}</p>
      ${list.length ? `<ul class="list">${list.map((n, i) => placeRow(n, i + 1)).join("")}</ul>` : `<p class="empty">D+${state.day} 기준으로 이 상태인 기업이 없습니다. 아래 재생 막대로 날짜를 옮겨 보세요.</p>`}
      <p class="note">반영 판정: 사건일부터의 지수 대비 누적 초과수익을 사건 전 변동성으로 나눈 값(z)이 2 이상이고 방향이 맞으면 반영 완료, 1 이상이면 진행 중입니다. 연구용 지표이며 투자 권유가 아닙니다.</p>`;
    $("#pane-radar").querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { state.radarFilter = b.dataset.f; renderRadar(); }));
    bindGo($("#pane-radar"));
  }
  function renderWatch() {
    const names = [...new Set(Object.values(state.cache).flatMap((S) => S.nodes.filter((n) => n.kind === "상장").map((n) => n.name)))].sort();
    const items = [];
    for (const sc of state.index.scenarios) {
      const S = state.cache[sc.id]; if (!S) continue;
      for (const n of S.nodes) if (state.watch.includes(n.name)) items.push({ S, n });
    }
    items.sort((a, b) => (a.S.date < b.S.date ? 1 : a.S.date > b.S.date ? -1 : 0) || Math.abs(b.n.I) - Math.abs(a.n.I));
    $("#pane-watch").innerHTML = `<div class="section">
        <form id="watchForm" style="display:flex;gap:var(--space-2)">
          <label class="sr-only" for="watchInput">관심 기업 추가</label>
          <input id="watchInput" list="watchNames" placeholder="기업 이름 입력" autocomplete="off" style="flex:1;min-width:0;height:36px;padding:0 12px;border:1px solid var(--color-line);border-radius:var(--radius-md);background:var(--color-surface)">
          <button class="chip" type="submit" style="height:36px">추가</button>
          <datalist id="watchNames">${names.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>
        </form>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${state.watch.map((w) => `<button class="chip" type="button" data-rm="${esc(w)}" aria-label="${esc(w)} 관심 해제">${esc(w)} <span aria-hidden="true">×</span></button>`).join("") || `<span class="note" style="padding:0">관심 기업이 없습니다.</span>`}</div>
      </div>
      <p class="note">관심 기업이 사건 지도에 들어오면 알림이 옵니다. 아래는 지난 사건을 실시간처럼 다시 본 예시입니다.</p>
      ${items.length ? `<ul class="list">${items.map(({ S, n }) => {
        const st = n.hop === 0 ? null : statusAt(n, 5);
        return `<li><button class="place" type="button" data-sc="${esc(S.id)}" data-go="${esc(n.id)}">
          <span class="place__rank" style="background:${n.hop === 0 ? "var(--color-harm)" : `var(--color-${dirOf(n)})`}">${n.hop}</span>
          <span class="place__body"><span class="place__name">${esc(n.name)} · ${n.hop === 0 ? "사건 발생" : n.hop + "차 파급"}</span>
            <span class="place__meta">${esc(S.title)} · <span class="mono">${esc(S.date)}</span></span>
            ${n.hop === 0 ? "" : `<span class="place__meta">${dirWord(n)} 예상 ${Math.abs(n.I).toFixed(3)} · ${esc((n.route[n.route.length - 1] || {}).rule || "")}</span>`}</span>
          <span class="place__side">${st ? pill(st) + `<span class="place__meta">D+5</span>` : ""}</span></button></li>`;
      }).join("")}</ul>` : `<p class="empty">관심 기업이 들어간 사건이 아직 없습니다.</p>`}`;
    $("#watchForm").onsubmit = (ev) => {
      ev.preventDefault();
      const v = $("#watchInput").value.trim(); if (!v) return;
      if (!state.watch.includes(v)) state.watch.push(v);
      saveWatch(); renderWatch(); toast(`${v}을(를) 관심 기업에 넣었습니다`);
    };
    $("#pane-watch").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { state.watch = state.watch.filter((w) => w !== b.dataset.rm); saveWatch(); renderWatch(); }));
    $("#pane-watch").querySelectorAll("[data-sc]").forEach((b) => (b.onclick = async () => { if (b.dataset.sc !== state.S.id) await loadScenario(b.dataset.sc); select(b.dataset.go); }));
  }
  function bindGo(root) { root.querySelectorAll("button[data-go]:not([data-sc])").forEach((b) => (b.onclick = () => select(b.dataset.go))); }

  function setTab(t) {
    state.tab = t;
    for (const k of ["event", "radar", "watch"]) {
      $(`#tab-${k}`).setAttribute("aria-selected", k === t);
      $(`#pane-${k}`).hidden = k !== t;
    }
    if (t === "watch") renderWatch();
    $("#sideBody").scrollTop = 0;
    if ($("#app").classList.contains("panel-hidden")) togglePanel(true);
  }

  /* ---------------- 레이어 칩 ---------------- */
  function renderLayers() {
    const cnt = {}; state.S.edges.forEach((e) => (cnt[e.type] = (cnt[e.type] || 0) + 1));
    const road = { 납품: "var(--road-major)", 투자: "var(--road-minor-casing)", 지분: "var(--road-rail)", 경쟁: "var(--road-trail)", 동조: "var(--road-trail)" };
    const style = { 지분: "dashed", 경쟁: "dashed", 동조: "dotted" };
    $("#layers").innerHTML = TYPES.filter((t) => cnt[t.key]).map((t) => `<button class="chip" type="button" data-layer="${t.key}" aria-pressed="${state.layers[t.key]}" title="${t.tip}">
        <span class="chip__road" style="color:${road[t.key]};border-top-style:${style[t.key] || "solid"}"></span>${t.key} <span class="chip__count">${cnt[t.key]}</span></button>`).join("")
      + `<button class="chip" type="button" id="onlyWaiting" aria-pressed="${state.onlyWaiting}"><span class="dot" style="background:var(--color-surface);box-shadow:inset 0 0 0 2.5px var(--color-watch)"></span>미반영만</button>`;
    $("#layers").querySelectorAll("[data-layer]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.layer; state.layers[k] = !state.layers[k]; b.setAttribute("aria-pressed", state.layers[k]); applyLayers();
    }));
    $("#onlyWaiting").onclick = (ev) => { state.onlyWaiting = !state.onlyWaiting; ev.currentTarget.setAttribute("aria-pressed", state.onlyWaiting); applyFocus(); };
  }

  /* ---------------- 시간 재생 ---------------- */
  function setDay(d) {
    state.day = Math.max(0, Math.min(state.maxDay, d));
    $("#day").value = state.day;
    $("#dlabel").textContent = `D+${state.day}`;
    $("#dateLabel").textContent = state.dates[state.day] || "";
    paint();
    renderEvent(); renderRadar();
    if (state.sel) renderDetail();
  }
  function play() {
    if (state.timer) return stop();
    if (state.day >= state.maxDay) setDay(0);
    $("#playIcon").innerHTML = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>';
    $("#play").setAttribute("aria-label", "재생 멈춤");
    state.timer = setInterval(() => { if (state.day >= state.maxDay) return stop(); setDay(state.day + 1); }, 160);
  }
  function stop() {
    clearInterval(state.timer); state.timer = null;
    $("#playIcon").innerHTML = '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>';
    $("#play").setAttribute("aria-label", "주가 반응 재생");
  }

  /* ---------------- 검색 ---------------- */
  let sugg = [], sIdx = -1;
  function runSearch() {
    const q = $("#q").value.trim().toLowerCase();
    $("#qclear").hidden = !q;
    if (!q) return hideSuggest();
    const evs = state.index.scenarios.filter((s) => s.title.toLowerCase().includes(q)).map((s) => ({ kind: "sc", id: s.id, name: s.title, meta: s.date }));
    const cos = state.S.nodes.filter((n) => n.name.toLowerCase().includes(q)).sort((a, b) => Math.abs(b.I) - Math.abs(a.I)).slice(0, 8)
      .map((n) => ({ kind: "co", id: n.id, name: n.name, meta: n.hop === 0 ? "사건" : `${n.hop}차 · ${dirWord(n)} 예상`, color: statusColor(n, statusAt(n)) }));
    sugg = [...cos, ...evs]; sIdx = sugg.length ? 0 : -1;
    const ul = $("#suggest");
    ul.innerHTML = sugg.length ? sugg.map((s, i) => `<li role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === sIdx}">
        ${s.kind === "co" ? `<span class="dot" style="background:${s.color}"></span>` : `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-harm)" stroke-width="2.4"/><circle cx="12" cy="12" r="3.5" fill="var(--color-harm)"/></svg>`}
        <span class="suggest__name">${esc(s.name)}</span><span class="suggest__meta">${esc(s.meta)}</span></li>`).join("")
      : `<li aria-disabled="true" style="cursor:default"><span class="suggest__meta" style="margin:0">이 사건 지도에 "${esc(q)}"이(가) 없습니다</span></li>`;
    ul.hidden = false; $("#q").setAttribute("aria-expanded", "true");
    ul.querySelectorAll("[data-i]").forEach((li) => li.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(+li.dataset.i); }));
  }
  function hideSuggest() { $("#suggest").hidden = true; $("#q").setAttribute("aria-expanded", "false"); }
  async function pick(i) {
    const s = sugg[i]; if (!s) return;
    hideSuggest(); $("#q").value = s.name; $("#qclear").hidden = false;
    if (s.kind === "sc") await loadScenario(s.id); else select(s.id);
  }

  /* ---------------- 패널 접기 ---------------- */
  function togglePanel(show) {
    const app = $("#app");
    const hide = show === undefined ? !app.classList.contains("panel-hidden") : !show;
    app.classList.toggle("panel-hidden", hide);
    $("#panelToggle").setAttribute("aria-expanded", !hide);
    $("#panelToggle").setAttribute("aria-label", hide ? "목록 패널 펴기" : "목록 패널 접기");
  }

  /* ---------------- 사건 불러오기 ---------------- */
  async function loadScenario(id) {
    stop();
    const S = await getScenario(id);
    state.S = S; state.sel = null; state.onlyWaiting = false;
    state.byId = new Map(S.nodes.map((n) => [n.id, n]));
    const longest = S.nodes.filter((n) => n.react).reduce((a, n) => (n.react.dates.length > a.length ? n.react.dates : a), []);
    state.dates = longest; state.maxDay = Math.max(1, longest.length - 1);
    $("#day").max = state.maxDay;
    $("#detail").hidden = true; $("#app").classList.remove("has-detail");
    if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
    renderLayers();
    state.day = 0;
    buildMap();
    setDay(0);
    $("#sideBody").scrollTop = 0;
  }

  function zoomBy(f) {
    const cy = state.cy, R = visibleRect();
    const pos = { x: (R.x0 + R.x1) / 2, y: (R.y0 + R.y1) / 2 };
    const z = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cy.zoom() * f));
    if (reduced) cy.zoom({ level: z, renderedPosition: pos });
    else cy.animate({ zoom: { level: z, renderedPosition: pos } }, { duration: 200 });
  }

  /* ---------------- 시작 ---------------- */
  async function init() {
    try {
      state.index = await getJSON("data/index.json");
    } catch (e) {
      $("#pane-event").innerHTML = `<p class="empty">데이터를 읽지 못했습니다. 파일을 직접 열었다면 <span class="mono">hackathon/web</span>에서 <span class="mono">python -m http.server</span>로 연 뒤 다시 시도하세요.</p>`;
      return;
    }
    const ids = state.index.scenarios.map((s) => s.id);
    const first = ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : ids[0];
    await loadScenario(first);
    Promise.all(ids.map(getScenario)).then(() => { if (state.tab === "watch") renderWatch(); }).catch(() => {});

    $("#play").onclick = play;
    $("#day").oninput = (e) => { stop(); setDay(+e.target.value); };
    $("#zin").onclick = () => zoomBy(1.35);
    $("#zout").onclick = () => zoomBy(1 / 1.35);
    $("#fit").onclick = () => fitAll(true);
    $("#panelToggle").onclick = () => togglePanel();
    for (const k of ["event", "radar", "watch"]) $(`#tab-${k}`).onclick = () => setTab(k);
    $("#q").addEventListener("input", runSearch);
    $("#q").addEventListener("focus", () => $("#q").value && runSearch());
    $("#q").addEventListener("blur", () => setTimeout(hideSuggest, 120));
    $("#q").addEventListener("keydown", (e) => {
      if ($("#suggest").hidden || !sugg.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); sIdx = (sIdx + (e.key === "ArrowDown" ? 1 : -1) + sugg.length) % sugg.length;
        $("#suggest").querySelectorAll("[data-i]").forEach((li, i) => li.setAttribute("aria-selected", i === sIdx));
      } else if (e.key === "Enter") { e.preventDefault(); pick(sIdx); } else if (e.key === "Escape") hideSuggest();
    });
    $("#qclear").onclick = () => { $("#q").value = ""; $("#qclear").hidden = true; hideSuggest(); $("#q").focus(); };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.activeElement !== $("#q")) closeDetail(); });
    addEventListener("hashchange", () => { const h = location.hash.slice(1); if (ids.includes(h) && h !== state.S.id) loadScenario(h); });
    const restyle = () => { if (state.cy) { state.cy.style(mapStyle()); paint(); } };
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", restyle);
    new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  init();
})();
