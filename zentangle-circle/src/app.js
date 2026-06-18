(() => {
  "use strict";

  const PAPER = "#f3ece0";
  const INK = "#17130f";
  const SELECT = "#1668ff";          // bright blue selection highlight

  const DEFAULT_THICKNESS = 3;
  const DEFAULT_WAVINESS = 0.3;      // slider step -> 1..5 bends, with rising amplitude
  const DEFAULT_DENSITY = 20;        // px between strands in a fan
  const AMP_MIN_FRAC = 0.05;
  const AMP_MAX_FRAC = 0.22;
  const MAX_BENDS = 5;
  const MAX_FAN = 40;                // cap on strands in a fan

  const config = {
    margin: 22,
    bottomReserve: 96,
    circleWidth: 3.2,
    snap: 18,
    hit: 16,
    handleHit: 20,
    dragThreshold: 8,
    minCurve: 18
  };

  const app = document.getElementById("app");
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d", { alpha: false });
  const toolbar = document.getElementById("toolbar");

  const view = { cssW: 1, cssH: 1, dpr: 1, circle: { cx: 0, cy: 0, r: 1 } };

  // A fan is the unit of the drawing: two shared endpoint nodes (a, b) plus an
  // inner and outer boundary (each a set of chord-relative control points). The
  // strands that fill the fan are interpolated between inner and outer; how many
  // there are comes from the fan's density. A plain curve is a fan whose inner
  // and outer boundaries are equal (one strand).
  const state = {
    nodes: [],
    fans: [],
    selectedId: null,
    nextNodeId: 1,
    nextFanId: 1,
    gesture: null
  };

  // Settings a new fan inherits — tracks the most recently selected/edited fan.
  const lastSettings = { thickness: DEFAULT_THICKNESS, waviness: DEFAULT_WAVINESS, density: DEFAULT_DENSITY };

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function pointerPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, id: e.pointerId };
  }

  function node(id) { return state.nodes.find(n => n.id === id) || null; }
  function fanById(id) { return state.fans.find(f => f.id === id) || null; }
  function selectedFan() { return fanById(state.selectedId); }

  function addNode(x, y, snapped) {
    const n = { id: state.nextNodeId++, x, y, snapped: !!snapped };
    state.nodes.push(n);
    return n;
  }

  // --- selection / toolbar -----------------------------------------------

  function rememberSettings(fan) {
    lastSettings.thickness = fan.thickness;
    lastSettings.waviness = fan.waviness;
    lastSettings.density = fan.density;
  }

  function setSelected(id) {
    state.selectedId = id;
    const fan = selectedFan();
    if (fan) rememberSettings(fan);
    syncToolbar();
  }

  function syncToolbar() {
    if (!selectedFan()) {
      toolbar.hidden = true;
      closeFlyouts();
      return;
    }
    toolbar.hidden = false;
    markActiveOptions();
  }

  // --- sizing -------------------------------------------------------------

  function updateCircle() {
    const top = config.margin;
    const bottom = view.cssH - config.bottomReserve;
    const usableH = Math.max(80, bottom - top);
    const usableW = Math.max(80, view.cssW - config.margin * 2);
    const d = Math.max(80, Math.min(usableW, usableH));
    view.circle = { cx: view.cssW / 2, cy: top + usableH / 2, r: d / 2 };
  }

  function resize() {
    const rect = app.getBoundingClientRect();
    const old = { ...view.circle };

    view.cssW = Math.max(1, Math.floor(rect.width));
    view.cssH = Math.max(1, Math.floor(rect.height));
    view.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

    canvas.width = Math.floor(view.cssW * view.dpr);
    canvas.height = Math.floor(view.cssH * view.dpr);

    updateCircle();

    if (old.r > 1 && state.nodes.length) {
      const ratio = view.circle.r / old.r;
      for (const n of state.nodes) {
        n.x = view.circle.cx + (n.x - old.cx) * ratio;
        n.y = view.circle.cy + (n.y - old.cy) * ratio;
      }
    }

    state.gesture = null;
    render();
  }

  // --- circle geometry ----------------------------------------------------

  function insideCircle(p, inset = 0) {
    const c = view.circle;
    return Math.hypot(p.x - c.cx, p.y - c.cy) <= Math.max(0, c.r - inset);
  }

  function projectInsideCircle(p) {
    const c = view.circle;
    const dx = p.x - c.cx;
    const dy = p.y - c.cy;
    const d = Math.hypot(dx, dy) || 1;
    if (d <= c.r) return { x: p.x, y: p.y };
    return { x: c.cx + dx / d * c.r, y: c.cy + dy / d * c.r };
  }

  function nearestCirclePoint(p) {
    const c = view.circle;
    const dx = p.x - c.cx;
    const dy = p.y - c.cy;
    const d = Math.hypot(dx, dy) || 1;
    return {
      point: { x: c.cx + dx / d * c.r, y: c.cy + dy / d * c.r },
      d: Math.abs(d - c.r)
    };
  }

  // --- strand geometry ----------------------------------------------------
  // A "strand" is anything renderable: { a, b, controls } (committed) or a
  // preview ghost with { start, end, controls }.

  function endA(s) { return s.a != null ? node(s.a) : s.start; }
  function endB(s) { return s.b != null ? node(s.b) : s.end; }

  function chordBasis(s) {
    const A = endA(s);
    const B = endB(s);
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    return { A, B, dx, dy, len, ux, uy, nx: -uy, ny: ux };
  }

  function waveParams(waviness) {
    const s = clamp(waviness || 0, 0, 1) * MAX_BENDS;
    const band = Math.min(MAX_BENDS - 1, Math.floor(s));
    const frac = clamp(s - band, 0, 1);
    return { bends: band + 1, ampFrac: lerp(AMP_MIN_FRAC, AMP_MAX_FRAC, frac) };
  }

  const fract = (x) => x - Math.floor(x);
  const randomSeed = () => Math.floor(Math.random() * 100000);
  const seeded = (seed, i, salt) => fract(Math.sin(seed * 127.1 + i * 311.7 + salt * 74.7) * 43758.5453);

  function controlsFor(waviness, seed) {
    const { bends, ampFrac } = waveParams(waviness);
    const arr = [];
    for (let i = 1; i <= bends; i++) {
      const baseT = (i - 0.5) / bends;
      const tJit = (seeded(seed, i, 1) - 0.5) * (0.6 / bends);
      const ampJit = lerp(0.55, 1.3, seeded(seed, i, 2));
      const sign = i % 2 === 1 ? 1 : -1;
      arr.push({ t: clamp(baseT + tJit, 0.04, 0.96), off: sign * ampFrac * ampJit, tweaked: false });
    }
    return arr;
  }

  function cloneControls(controls) {
    return controls.map(k => ({ t: k.t, off: k.off, tweaked: !!k.tweaked, dt: k.dt || 0, doff: k.doff || 0 }));
  }

  // Re-flow controls to a waviness: untweaked peaks track the procedural shape
  // (so the slider tweens), tweaked peaks ride along by their stored delta.
  function reflowControls(controls, waviness, seed) {
    const target = controlsFor(waviness, seed);
    const merged = target.map((tc, i) => {
      const old = controls[i];
      if (old && old.tweaked) {
        return { t: clamp(tc.t + old.dt, 0.04, 0.96), off: tc.off + old.doff, tweaked: true, dt: old.dt, doff: old.doff };
      }
      return tc;
    });
    merged.sort((a, b) => a.t - b.t);
    return merged;
  }

  function controlWorldPoints(s) {
    const b = chordBasis(s);
    return s.controls.map(k => ({
      x: b.A.x + b.dx * k.t + b.nx * k.off * b.len,
      y: b.A.y + b.dy * k.t + b.ny * k.off * b.len
    }));
  }

  function knots(s) {
    return [endA(s), ...controlWorldPoints(s), endB(s)];
  }

  function catmullRomPoint(points, t) {
    if (points.length === 1) return { ...points[0] };
    const segCount = points.length - 1;
    const scaled = clamp(t, 0, 1) * segCount;
    const seg = Math.min(segCount - 1, Math.floor(scaled));
    const u = scaled - seg;
    const p0 = points[Math.max(0, seg - 1)];
    const p1 = points[seg];
    const p2 = points[seg + 1];
    const p3 = points[Math.min(points.length - 1, seg + 2)];
    const u2 = u * u;
    const u3 = u2 * u;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3)
    };
  }

  function curvePoint(s, t) {
    return catmullRomPoint(knots(s), t);
  }

  // --- fan strands --------------------------------------------------------

  function innerStrand(fan) { return { a: fan.a, b: fan.b, controls: fan.inner.controls }; }
  function outerStrand(fan) { return { a: fan.a, b: fan.b, controls: fan.outer.controls }; }

  // Mean separation (px) between inner and outer, divided by density, gives the
  // strand count.
  function fanCount(fan) {
    const basis = chordBasis(fan);
    const n = fan.inner.controls.length;
    let sep = 0;
    for (let i = 0; i < n; i++) sep += Math.abs(fan.outer.controls[i].off - fan.inner.controls[i].off);
    sep = (sep / Math.max(1, n)) * basis.len;
    const density = fan.density || DEFAULT_DENSITY;
    return clamp(Math.round(sep / density) + 1, 1, MAX_FAN + 1);
  }

  function isSpread(fan) { return fanCount(fan) > 1; }

  // Strands interpolated from inner (f=0) to outer (f=1).
  function fanStrands(fan) {
    const count = fanCount(fan);
    const strands = [];
    for (let j = 0; j < count; j++) {
      const f = count === 1 ? 0 : j / (count - 1);
      const controls = fan.inner.controls.map((ic, i) => {
        const oc = fan.outer.controls[i];
        return { t: lerp(ic.t, oc.t, f), off: lerp(ic.off, oc.off, f) };
      });
      strands.push({ a: fan.a, b: fan.b, controls });
    }
    return strands;
  }

  // --- hit-testing --------------------------------------------------------

  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return dist(p, a);
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }

  function strandDistance(p, s) {
    let best = Infinity;
    let prev = curvePoint(s, 0);
    const steps = 64;
    for (let i = 1; i <= steps; i++) {
      const next = curvePoint(s, i / steps);
      const d = distanceToSegment(p, prev, next);
      if (d < best) best = d;
      prev = next;
    }
    return best;
  }

  function bandPolygon(fan, steps = 32) {
    const inner = innerStrand(fan);
    const outer = outerStrand(fan);
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(curvePoint(outer, i / steps));
    for (let i = steps; i >= 0; i--) pts.push(curvePoint(inner, i / steps));
    return pts;
  }

  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (((a.y > p.y) !== (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
    }
    return inside;
  }

  function findFanNear(p, tol = config.hit) {
    let best = null;
    for (const fan of state.fans) {
      let d = strandDistance(p, innerStrand(fan));
      if (fanCount(fan) > 1) {
        d = Math.min(d, strandDistance(p, outerStrand(fan)));
        if (d > tol && pointInPoly(p, bandPolygon(fan))) d = 0;
      }
      if (d <= tol && (!best || d < best.d)) best = { fan, d };
    }
    return best;
  }

  // Snappable edges: each fan's inner and outer boundary, skipping fans on the
  // node being dragged.
  function nearestBoundaryPoint(p, excludeNodeId = null) {
    let best = null;
    const consider = (s) => {
      const steps = 80;
      for (let i = 0; i <= steps; i++) {
        const q = curvePoint(s, i / steps);
        const d = dist(p, q);
        if (!best || d < best.d) best = { point: q, d };
      }
    };
    for (const fan of state.fans) {
      if (excludeNodeId != null && (fan.a === excludeNodeId || fan.b === excludeNodeId)) continue;
      consider(innerStrand(fan));
      if (isSpread(fan)) consider(outerStrand(fan));
    }
    return best;
  }

  function anchorAt(p, excludeNodeId = null) {
    const q = projectInsideCircle(p);

    let bestNode = null;
    for (const n of state.nodes) {
      if (n.id === excludeNodeId) continue;
      const d = dist(q, n);
      if (d <= config.snap && (!bestNode || d < bestNode.d)) bestNode = { n, d };
    }
    if (bestNode) return { nodeId: bestNode.n.id, x: bestNode.n.x, y: bestNode.n.y, snapped: true };

    const circleHit = nearestCirclePoint(q);
    const curveHit = nearestBoundaryPoint(q, excludeNodeId);
    let best = circleHit.d <= config.snap ? { point: circleHit.point, d: circleHit.d } : null;
    if (curveHit && curveHit.d <= config.snap && (!best || curveHit.d < best.d)) best = curveHit;
    if (best) return { nodeId: null, x: best.point.x, y: best.point.y, snapped: true };

    return { nodeId: null, x: q.x, y: q.y, snapped: false };
  }

  function nodeSnap(p, excludeNodeId = null) {
    const q = projectInsideCircle(p);
    const circleHit = nearestCirclePoint(q);
    const curveHit = nearestBoundaryPoint(q, excludeNodeId);
    let best = circleHit.d <= config.snap ? { point: circleHit.point, d: circleHit.d } : null;
    if (curveHit && curveHit.d <= config.snap && (!best || curveHit.d < best.d)) best = curveHit;
    if (best) return { x: best.point.x, y: best.point.y, snapped: true };
    return { x: q.x, y: q.y, snapped: false };
  }

  function hitHandle(p) {
    const fan = selectedFan();
    if (!fan) return null;
    if (dist(p, node(fan.a)) <= config.handleHit) return fan.a;
    if (dist(p, node(fan.b)) <= config.handleHit) return fan.b;
    return null;
  }

  function hitControl(p) {
    const fan = selectedFan();
    if (!fan) return null;
    const innerPts = controlWorldPoints(innerStrand(fan));
    for (let i = 0; i < innerPts.length; i++) {
      if (dist(p, innerPts[i]) <= config.handleHit) return { boundary: "inner", index: i };
    }
    if (isSpread(fan)) {
      const outerPts = controlWorldPoints(outerStrand(fan));
      for (let i = 0; i < outerPts.length; i++) {
        if (dist(p, outerPts[i]) <= config.handleHit) return { boundary: "outer", index: i };
      }
    }
    return null;
  }

  // --- fan editing --------------------------------------------------------

  function makeGhost(start, end, settings) {
    return {
      start: { x: start.x, y: start.y, snapped: !!start.snapped },
      end: { x: end.x, y: end.y, snapped: !!end.snapped },
      thickness: settings.thickness,
      waviness: settings.waviness,
      density: settings.density,
      seed: settings.seed,
      controls: controlsFor(settings.waviness, settings.seed)
    };
  }

  function commitNewFan(ghost, startAnchor, endAnchor) {
    const aId = startAnchor.nodeId != null ? startAnchor.nodeId : addNode(ghost.start.x, ghost.start.y, ghost.start.snapped).id;
    const bId = endAnchor.nodeId != null ? endAnchor.nodeId : addNode(ghost.end.x, ghost.end.y, ghost.end.snapped).id;
    const fan = {
      id: state.nextFanId++,
      a: aId,
      b: bId,
      thickness: ghost.thickness,
      waviness: ghost.waviness,
      density: ghost.density,
      seed: ghost.seed,
      inner: { controls: cloneControls(ghost.controls) },
      outer: { controls: cloneControls(ghost.controls) }
    };
    state.fans.push(fan);
    return fan;
  }

  // Spread: set the outer boundary to a snapshot offset perpendicular by the
  // drag, so the fan widens/narrows continuously from where it was.
  function spreadFan(fan, baseOuter, from, to) {
    const basis = chordBasis(fan);
    const dragBow = ((to.x - from.x) * basis.nx + (to.y - from.y) * basis.ny) / basis.len;
    const proc = controlsFor(fan.waviness, fan.seed);
    fan.outer.controls = baseOuter.map((k, i) => {
      const off = k.off + dragBow;
      const P = proc[i];
      return { t: k.t, off, tweaked: true, dt: P ? k.t - P.t : 0, doff: P ? off - P.off : 0 };
    });
  }

  function updateControl(fan, boundary, index, p) {
    const s = boundary === "inner" ? innerStrand(fan) : outerStrand(fan);
    const b = chordBasis(s);
    const rx = p.x - b.A.x;
    const ry = p.y - b.A.y;
    let t = (rx * b.ux + ry * b.uy) / b.len;
    const off = (rx * b.nx + ry * b.ny) / b.len;
    const controls = fan[boundary].controls;
    const prev = index > 0 ? controls[index - 1].t : 0;
    const next = index < controls.length - 1 ? controls[index + 1].t : 1;
    t = clamp(t, prev + 0.03, next - 0.03);
    const P = controlsFor(fan.waviness, fan.seed)[index];
    const ctrl = { t, off, tweaked: true, dt: P ? t - P.t : 0, doff: P ? off - P.off : 0 };
    fan[boundary].controls[index] = ctrl;
    // When the fan isn't spread, keep both boundaries equal so it stays one curve.
    if (!isSpread(fan)) {
      const other = boundary === "inner" ? "outer" : "inner";
      fan[other].controls[index] = { ...ctrl };
    }
  }

  // --- drawing ------------------------------------------------------------

  function drawStrandPath(targetCtx, s) {
    const steps = 128;
    const p0 = curvePoint(s, 0);
    targetCtx.beginPath();
    targetCtx.moveTo(p0.x, p0.y);
    for (let i = 1; i <= steps; i++) {
      const p = curvePoint(s, i / steps);
      targetCtx.lineTo(p.x, p.y);
    }
  }

  function drawStrand(targetCtx, s, options = {}) {
    targetCtx.save();
    targetCtx.lineCap = "round";
    targetCtx.lineJoin = "round";
    drawStrandPath(targetCtx, s);
    targetCtx.lineWidth = options.width || DEFAULT_THICKNESS;
    targetCtx.strokeStyle = options.color || INK;
    if (options.dash) targetCtx.setLineDash(options.dash);
    targetCtx.stroke();
    targetCtx.restore();
  }

  function fillFanBand(fan) {
    const steps = 48;
    const inner = innerStrand(fan);
    const outer = outerStrand(fan);
    ctx.save();
    ctx.beginPath();
    let p = curvePoint(outer, 0);
    ctx.moveTo(p.x, p.y);
    for (let i = 1; i <= steps; i++) { p = curvePoint(outer, i / steps); ctx.lineTo(p.x, p.y); }
    for (let i = steps; i >= 0; i--) { p = curvePoint(inner, i / steps); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.restore();
  }

  function drawCircleBorder() {
    const c = view.circle;
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
    ctx.lineWidth = config.circleWidth;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
  }

  function drawEndpointHandle(p) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = SELECT;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.restore();
  }

  function drawControlHandle(p) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = SELECT;
    ctx.stroke();
    ctx.restore();
  }

  function drawSnapDot(p) {
    if (!p || !p.snapped) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.restore();
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    drawCircleBorder();

    for (const fan of state.fans) {
      const selected = fan.id === state.selectedId;
      const strands = fanStrands(fan);
      if (strands.length >= 2) fillFanBand(fan);
      for (const s of strands) drawStrand(ctx, s, { color: selected ? SELECT : INK, width: fan.thickness });
    }

    const g = state.gesture;
    if (g && g.preview) {
      drawStrand(ctx, g.preview, { width: 2.6, color: "rgba(23,19,15,0.6)", dash: [8, 7] });
      drawSnapDot(g.preview.start);
      drawSnapDot(g.preview.end);
    }

    const fan = selectedFan();
    if (fan) {
      for (const cp of controlWorldPoints(innerStrand(fan))) drawControlHandle(cp);
      if (isSpread(fan)) for (const cp of controlWorldPoints(outerStrand(fan))) drawControlHandle(cp);
      drawEndpointHandle(node(fan.a));
      drawEndpointHandle(node(fan.b));
    }
  }

  // --- pointer handling ---------------------------------------------------

  function onPointerDown(e) {
    e.preventDefault();
    const p = pointerPoint(e);
    const fan = selectedFan();

    // 1) Endpoint handle -> drag the shared node.
    const handleNodeId = fan ? hitHandle(p) : null;
    if (handleNodeId != null) {
      canvas.setPointerCapture(e.pointerId);
      state.gesture = { id: e.pointerId, kind: "move-node", nodeId: handleNodeId, from: p };
      return;
    }

    // 2) Inner/outer control point -> tweak that boundary.
    const ctrl = fan ? hitControl(p) : null;
    if (ctrl) {
      canvas.setPointerCapture(e.pointerId);
      state.gesture = { id: e.pointerId, kind: "move-control", fanId: fan.id, boundary: ctrl.boundary, index: ctrl.index, from: p };
      return;
    }

    // New fans only begin inside the circle.
    if (!insideCircle(p, -20)) return;
    canvas.setPointerCapture(e.pointerId);

    const hit = findFanNear(p);

    // 3) Drag from the selected fan -> spread it.
    if (fan && hit && hit.fan.id === fan.id) {
      state.gesture = { id: e.pointerId, kind: "spread", fanId: fan.id, from: p, baseOuter: cloneControls(fan.outer.controls) };
      return;
    }

    // 4) Otherwise: start a new fan (or tap an existing one to select).
    state.gesture = {
      id: e.pointerId,
      kind: "new-or-select",
      from: p,
      startAnchor: anchorAt(p),
      endAnchor: null,
      seed: randomSeed(),
      tapTargetId: hit ? hit.fan.id : null,
      preview: null
    };
    render();
  }

  function onPointerMove(e) {
    const g = state.gesture;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();

    const p = pointerPoint(e);
    const moved = dist(g.from, p);

    if (g.kind === "move-node") {
      const target = nodeSnap(p, g.nodeId);
      const nd = node(g.nodeId);
      nd.x = target.x; nd.y = target.y; nd.snapped = target.snapped;
      render();
      return;
    }

    if (g.kind === "move-control") {
      const fan = fanById(g.fanId);
      if (fan) updateControl(fan, g.boundary, g.index, p);
      render();
      return;
    }

    if (g.kind === "spread") {
      const fan = fanById(g.fanId);
      if (fan) spreadFan(fan, g.baseOuter, g.from, p);
      render();
      return;
    }

    if (g.kind === "new-or-select") {
      if (moved >= config.dragThreshold) {
        const endAnchor = anchorAt(p);
        g.endAnchor = endAnchor;
        g.preview = dist(g.startAnchor, endAnchor) >= config.minCurve
          ? makeGhost(g.startAnchor, endAnchor, { thickness: lastSettings.thickness, waviness: lastSettings.waviness, density: lastSettings.density, seed: g.seed })
          : null;
      } else {
        g.preview = null;
      }
      render();
    }
  }

  function onPointerUp(e) {
    const g = state.gesture;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    if (g.kind === "move-node" || g.kind === "move-control" || g.kind === "spread") {
      // selection unchanged
    } else if (g.kind === "new-or-select") {
      if (g.preview && dist(g.preview.start, g.preview.end) >= config.minCurve) {
        setSelected(commitNewFan(g.preview, g.startAnchor, g.endAnchor).id);
      } else {
        setSelected(g.tapTargetId);
      }
    }

    state.gesture = null;
    render();
  }

  // --- toolbar ------------------------------------------------------------

  const FLYOUT_TYPES = ["thickness", "waviness", "density"];
  const LEVELS = {
    thickness: [2, 3.5, 5.5, 8, 12],
    waviness: [0.1, 0.3, 0.5, 0.7, 0.9],
    density: [40, 28, 20, 13, 8]
  };

  const deleteBtn = document.getElementById("deleteBtn");
  const toolBtns = {};
  const flyouts = {};

  function wavePath(w, width, height) {
    const { bends, ampFrac } = waveParams(w);
    const amp = Math.min(ampFrac * 60, height / 2 - 3);
    const x0 = 6;
    const x1 = width - 6;
    const cy = height / 2;
    const steps = 40;
    let d = "";
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = lerp(x0, x1, t);
      const y = cy - amp * Math.sin(bends * Math.PI * t);
      d += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    }
    return d.trim();
  }

  function densityGlyph(spacing) {
    const gap = clamp(spacing * 0.42, 4, 16);
    const x0 = 6;
    const x1 = 42;
    const cx = 24;
    const xs = [];
    for (let x = cx; x <= x1; x += gap) xs.push(x);
    for (let x = cx - gap; x >= x0; x -= gap) xs.push(x);
    const lines = xs.map(x => `<line x1="${x.toFixed(1)}" y1="6" x2="${x.toFixed(1)}" y2="24"/>`).join("");
    return `<g stroke="currentColor" stroke-width="2" stroke-linecap="round">${lines}</g>`;
  }

  function optGlyph(type, value) {
    if (type === "thickness") return `<line x1="8" y1="15" x2="40" y2="15" stroke="currentColor" stroke-width="${value}" stroke-linecap="round"/>`;
    if (type === "waviness") return `<path d="${wavePath(value, 48, 30)}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    return densityGlyph(value);
  }

  function optButton(type, value) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.dataset.type = type;
    btn.dataset.value = String(value);
    btn.innerHTML = `<svg viewBox="0 0 48 30" width="46" height="29" aria-hidden="true">${optGlyph(type, value)}</svg>`;
    return btn;
  }

  const nearest = (arr, v) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

  function fanValue(fan, type) {
    if (type === "thickness") return fan.thickness;
    if (type === "waviness") return fan.waviness;
    return fan.density != null ? fan.density : DEFAULT_DENSITY;
  }

  // Each main tool button shows a glyph of the selected fan's current value.
  function updateToolbarIcons() {
    const fan = selectedFan();
    if (!fan) return;
    for (const type of FLYOUT_TYPES) {
      toolBtns[type].innerHTML = `<svg viewBox="0 0 48 30" width="40" height="25" aria-hidden="true">${optGlyph(type, fanValue(fan, type))}</svg>`;
    }
  }

  function markActiveOptions() {
    const fan = selectedFan();
    if (!fan) return;
    updateToolbarIcons();
    for (const type of FLYOUT_TYPES) {
      const nv = nearest(LEVELS[type], fanValue(fan, type));
      for (const opt of flyouts[type].children) opt.classList.toggle("active", Number(opt.dataset.value) === nv);
    }
  }

  function closeFlyouts() {
    for (const type of FLYOUT_TYPES) {
      flyouts[type].hidden = true;
      toolBtns[type].classList.remove("active");
    }
  }

  function toggleFlyout(type) {
    const wasOpen = !flyouts[type].hidden;
    closeFlyouts();
    if (!wasOpen) {
      flyouts[type].hidden = false;
      toolBtns[type].classList.add("active");
      markActiveOptions();
    }
  }

  function applyOption(type, value) {
    const fan = selectedFan();
    if (!fan) return;
    if (type === "thickness") {
      fan.thickness = value;
    } else if (type === "waviness") {
      fan.waviness = value;
      fan.inner.controls = reflowControls(fan.inner.controls, value, fan.seed);
      fan.outer.controls = reflowControls(fan.outer.controls, value, fan.seed);
    } else {
      fan.density = value;
    }
    rememberSettings(fan);
    updateToolbarIcons();
    render();
  }

  function deleteSelected() {
    const fan = selectedFan();
    if (!fan) return;
    const idx = state.fans.findIndex(f => f.id === fan.id);
    if (idx >= 0) state.fans.splice(idx, 1);
    const used = new Set();
    for (const f of state.fans) { used.add(f.a); used.add(f.b); }
    state.nodes = state.nodes.filter(n => used.has(n.id));
    setSelected(null);
    render();
  }

  for (const type of FLYOUT_TYPES) {
    toolBtns[type] = toolbar.querySelector(`[data-toolbtn="${type}"]`);
    flyouts[type] = toolbar.querySelector(`[data-flyout="${type}"]`);
    for (const v of LEVELS[type]) flyouts[type].appendChild(optButton(type, v));
    toolBtns[type].addEventListener("click", () => toggleFlyout(type));
    flyouts[type].addEventListener("click", (e) => {
      const opt = e.target.closest(".opt");
      if (!opt) return;
      applyOption(type, Number(opt.dataset.value));
      closeFlyouts();
    });
  }

  deleteBtn.addEventListener("click", deleteSelected);

  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#toolbar")) closeFlyouts();
  });

  // --- listeners ----------------------------------------------------------

  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", onPointerUp, { passive: false });
  canvas.addEventListener("pointercancel", onPointerUp, { passive: false });

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => requestAnimationFrame(resize));
  if (window.visualViewport) window.visualViewport.addEventListener("resize", resize);
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(app);

  resize();
})();
