/* Fragmentor website. No dependencies.
   1. The living diagram: the Tickets example drawn in Fragmentor's own style,
      building itself and then stepping its real "Book seats" execution.
   2. Page behaviour: the hero's controls, and the command panels that draw
      themselves as they come into view.                                   */

(() => {
  "use strict";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
    };
  }
  const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;

  /* ------------------------------------------------------------------ */
  /* The living diagram                                                  */
  /* ------------------------------------------------------------------ */

  // The product's own colours, from app/renderer/styles.css and state.ts.
  const KIND = {
    function: "#37dc89",
    component: "#A3E07A",
    service: "#C084FC",
    client: "#FFB86B",
    queue: "#FFD166",
    database: "#7C9CFF",
    external: "#F472B6",
    storage: "#5EEAD4",
    structure: "#67D8FF",
    planned: "#7a8b96",
  };
  const INK = "#c6d5d0", INK_DIM = "#8a9e99", INK_FAINT = "#6f8580";
  const RULE = "#2a363d", PLATE = "#0d1113", GROUND = "#07090a";
  const SIGNAL = "#4fe38f", TRIGGER = "#9fd3ff", EFFECT = "#e2a54b";
  const SANS = '"Space Grotesk", "Segoe UI", system-ui, sans-serif';
  const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';

  // examples/tickets, block for block.
  const SYSTEM = {
    name: "Tickets", kind: "component", sub: "", children: [
      { name: "Booking API", kind: "service", sub: "REST API", children: [
        { name: "Book Seats", kind: "function", sub: "", children: [
          { name: "Reserve", kind: "function", sub: "" },
        ] },
        { name: "Cancel Booking", kind: "function", sub: "" },
        { name: "Find Event", kind: "function", sub: "" },
        { name: "Pricing", kind: "component", sub: "module", children: [
          { name: "Price Seat", kind: "function", sub: "" },
          { name: "Refund For", kind: "function", sub: "" },
        ] },
      ] },
      { name: "Box Office", kind: "client", sub: "web page" },
      { name: "Outbox", kind: "queue", sub: "message queue" },
      { name: "Reminders", kind: "planned", sub: "" },
      { name: "Tickets Database", kind: "database", sub: "PostgreSQL" },
    ],
  };

  // examples/tickets/executions/book-seats.json, counted the way Fragmentor
  // counts it: the trigger, each interaction, each answer given back, and
  // each effect. The words are the agent's own; an answer shows what came back.
  const STEPS = [
    { from: "outside", to: "Box Office", kind: "action", text: "Ada confirms five seats for the Night Gig." },
    { from: "Box Office", to: "Booking API", kind: "call", text: "The page has nothing to show until the API says whether the seats were hers." },
    { from: "Booking API", to: "Book Seats", kind: "call", text: "The server that takes the request is not a block; all it does is hand it to the block that answers this operation." },
    { from: "Book Seats", to: "Find Event", kind: "call", text: "Nothing is priced, written or sent until the event is known to be on sale." },
    { from: "Find Event", to: "Tickets Database", kind: "read", text: "The event is looked up by the id the request named." },
    { from: "Tickets Database", to: "Find Event", kind: "gives back", text: '{"id":"gig","name":"Night Gig","seatsLeft":10,"price":25}' },
    { from: "Find Event", to: "Book Seats", kind: "gives back", text: '{"event":{"id":"gig","name":"Night Gig","seatsLeft":10,"price":25}}' },
    { from: "Book Seats", to: "Price Seat", kind: "call", text: "Each of the five seats is priced on its own, all at once. The first four come back at 25, and from the fifth a booking pays a tenth less, which is the only reason the total is not 125." },
    { from: "Price Seat", to: "Book Seats", kind: "gives back", text: '{"price":22.5}' },
    { from: "Book Seats", to: "Reserve", kind: "call", text: "Every price is back and the five seats come to 122.5, so the booking can be made." },
    { from: "Reserve", to: "Tickets Database", kind: "write", text: "The seats come off the event first, so the next person to ask sees what is really left." },
    { effect: "row changed", at: "Tickets Database", text: "Five seats are left for whoever asks next." },
    { from: "Reserve", to: "Tickets Database", kind: "write", text: "The booking is written down, numbered by the seats that were left when it was made." },
    { effect: "row changed", at: "Tickets Database", text: "The booking can be found again, which is what giving it back later needs." },
    { from: "Reserve", to: "Outbox", kind: "send", text: "The confirmation goes on the queue, so nobody waits for an email to send before seeing their booking." },
    { effect: "message published", at: "Outbox", text: "Whatever sends the emails will find it there." },
    { from: "Reserve", to: "Book Seats", kind: "gives back", text: '{"bookingId":"gig-10"}' },
    { effect: "response", at: "Booking API", text: "The API answers with what was booked and what it cost." },
    { from: "Booking API", to: "Box Office", kind: "gives back", text: '{"booked":true,"message":"Booked 5 for Night Gig: booking gig-10.","total":122.5}' },
    { effect: "ui changed", at: "Box Office", text: "The page shows what happened, which is the last thing Ada sees." },
  ];

  const IN_RUN = new Set(STEPS.flatMap((s) => [s.from, s.to, s.at]).filter(Boolean));

  const VERB = { action: "uses", call: "calls", read: "reads", write: "writes", send: "sends to", "gives back": "gives back to" };
  function sentence(s) {
    if (s.effect) return `${s.effect} at ${s.at}`;
    return `${s.from === "outside" ? "Someone" : s.from} ${VERB[s.kind]} ${s.to}`;
  }

  const BW = 148, BH = 38, GAP_X = 14, GAP_Y = 46;
  const BUILD_EVERY = 110, BUILD_IN = 420;
  const STEP_MS = 900, EFFECT_MS = 650, ARROW_MS = 380, HOLD_MS = 3000, PAUSE_BEFORE_RUN = 500;

  function layout(root) {
    const blocks = [];
    function width(n) {
      if (!n.children || n.children.length === 0) return (n.w = BW);
      let sum = GAP_X * (n.children.length - 1);
      for (const c of n.children) sum += width(c);
      return (n.w = Math.max(BW, sum));
    }
    function place(n, x, depth) {
      n.x = x + n.w / 2 - BW / 2;
      n.y = depth * (BH + GAP_Y);
      blocks.push(n);
      if (!n.children) return;
      let cx = x;
      for (const c of n.children) { place(c, cx, depth + 1); cx += c.w + GAP_X; }
    }
    width(root);
    place(root, 0, 0);
    let h = 0;
    for (const b of blocks) h = Math.max(h, b.y + BH);
    // Blocks appear breadth first, the way a diagram grows under an agent.
    blocks.sort((a, b) => a.y - b.y || a.x - b.x);
    blocks.forEach((b, i) => (b.order = i));
    return { blocks, w: root.w, h, byName: Object.fromEntries(blocks.map((b) => [b.name, b])) };
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

  function edgePoint(b, tx, ty) {
    const cx = b.x + BW / 2, cy = b.y + BH / 2;
    const dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return [cx, cy];
    const s = Math.min(dx ? (BW / 2) / Math.abs(dx) : Infinity, dy ? (BH / 2) / Math.abs(dy) : Infinity);
    return [cx + dx * s, cy + dy * s];
  }

  function livingDiagram(canvas, opts) {
    const ctx = canvas.getContext("2d");
    const tree = layout(JSON.parse(JSON.stringify(SYSTEM)));
    const box = tree.byName["Box Office"];
    const outside = { x: box.x - 70, y: box.y - 4 };

    // What is on screen: the build, then the run.
    let phase = "build", phaseAt = 0, step = -1, stepAt = 0, auto = true, chips = [], hovered = null;
    let width = 0, height = 0, dpr = 1, raf = 0, running = false, now = 0;
    let scale = 1, ox = 0, oy = 0, camX = 0, camTarget = 0, pans = false;
    const mouse = { x: 0.5, y: 0.5 };

    function resize() {
      const r = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(r.width));
      height = Math.max(1, Math.round(r.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const padX = 100, padY = 60;
      const top = opts.inset ? opts.inset(width, height) : 0; // room for the execution bar
      const fit = Math.min((width - 24) / (tree.w + padX), (height - top - 16) / (tree.h + padY));
      scale = clamp(fit, 0.66, opts.maxScale || 1);
      // Too wide for the screen: keep it readable and follow the run instead.
      pans = tree.w * scale + 40 > width;
      ox = pans ? 20 : (width - tree.w * scale) / 2;
      oy = top + (height - top - tree.h * scale) / 2;
      if (!pans) camX = camTarget = 0;
      render();
    }

    function litNow() {
      if (phase !== "run" || step < 0) return null;
      const s = STEPS[step];
      return s.effect ? [s.at, EFFECT] : [s.to, s.kind === "action" ? TRIGGER : SIGNAL];
    }

    function block(b, a, lit, litColour) {
      if (a <= 0) return;
      const grow = 0.92 + 0.08 * a;
      const colour = KIND[b.kind];
      const planned = b.kind === "planned";
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(b.x + BW / 2, b.y + BH / 2);
      ctx.scale(grow, grow);
      ctx.translate(-BW / 2, -BH / 2);
      ctx.beginPath();
      ctx.roundRect(0, 0, BW, BH, 3);
      ctx.fillStyle = planned ? GROUND : (hovered === b ? "#131a1c" : PLATE);
      ctx.fill();
      if (lit) {
        ctx.shadowColor = litColour;
        ctx.shadowBlur = 22;
        ctx.strokeStyle = litColour;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = hovered === b ? INK : colour;
        ctx.lineWidth = hovered === b ? 1.5 : 1;
        if (planned) ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // The kind mark in the corner, a small stroke in the block's colour.
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.1;
      ctx.lineCap = "round";
      ctx.globalAlpha = a * (planned ? 0.45 : 0.85);
      ctx.beginPath();
      switch (b.kind) {
        case "function": ctx.moveTo(10, 15); ctx.lineTo(7, 19); ctx.lineTo(10, 23); ctx.moveTo(15, 15); ctx.lineTo(18, 19); ctx.lineTo(15, 23); break;
        case "database": ctx.ellipse(12.5, 15, 5, 2, 0, 0, Math.PI * 2); ctx.moveTo(7.5, 15); ctx.lineTo(7.5, 23); ctx.moveTo(17.5, 15); ctx.lineTo(17.5, 23); ctx.moveTo(17.5, 23); ctx.ellipse(12.5, 23, 5, 2, 0, 0, Math.PI); break;
        case "queue": ctx.moveTo(7, 16); ctx.lineTo(18, 16); ctx.moveTo(7, 19); ctx.lineTo(18, 19); ctx.moveTo(7, 22); ctx.lineTo(18, 22); break;
        case "client": ctx.arc(12.5, 16, 3, 0, Math.PI * 2); ctx.moveTo(7, 24); ctx.quadraticCurveTo(12.5, 17, 18, 24); break;
        case "service": ctx.rect(7, 14, 11, 10); ctx.moveTo(7, 18); ctx.lineTo(18, 18); break;
        default: ctx.rect(7, 14, 11, 10); ctx.rect(10, 17, 5, 4);
      }
      ctx.stroke();
      ctx.globalAlpha = a;
      ctx.fillStyle = planned ? INK_FAINT : INK;
      ctx.font = `600 12.5px ${SANS}`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(b.name, 26, 17);
      ctx.fillStyle = planned ? KIND.planned : colour;
      ctx.font = `500 8.5px ${MONO}`;
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0.08em";
      ctx.fillText(planned ? "PLANNED" : b.kind.toUpperCase() + (b.sub ? ": " + b.sub : ""), 26, 29);
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
      ctx.restore();
    }

    function containment(parent, child, a) {
      if (a <= 0) return;
      const px = parent.x + BW / 2, py = parent.y + BH, cx = child.x + BW / 2, cy = child.y, bus = py + GAP_Y / 2;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = RULE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py); ctx.lineTo(px, bus); ctx.lineTo(cx, bus); ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.fillStyle = "#3f5058";
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function plate(text, mx, my, alpha, colour) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `500 9px ${MONO}`;
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = GROUND;
      ctx.strokeStyle = RULE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(mx - w / 2, my - 8, w, 15, 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = colour || INK;
      ctx.textBaseline = "middle";
      ctx.fillText(text, mx - w / 2 + 5, my);
      ctx.restore();
    }

    function arrow(s, progress, alpha) {
      const src = s.from === "outside" ? null : tree.byName[s.from];
      const dst = tree.byName[s.to];
      const tx = dst.x + BW / 2, ty = dst.y + BH / 2;
      const [x0, y0] = src ? edgePoint(src, tx, ty) : [outside.x, outside.y];
      const [x1, y1] = edgePoint(dst, x0, y0);
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
      const p = easeOut(progress);
      const ex = x0 + dx * p, ey = y0 + dy * p;
      const data = s.kind !== "action";
      const colour = data ? SIGNAL : TRIGGER;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      if (data) { ctx.setLineDash([7, 5]); ctx.lineDashOffset = -((now / 70) % 12); }
      else { ctx.shadowColor = TRIGGER; ctx.shadowBlur = 6; }
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      if (p > 0.15) {
        const ang = Math.atan2(dy, dx);
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - 9 * Math.cos(ang - 0.42), ey - 9 * Math.sin(ang - 0.42));
        ctx.lineTo(ex - 9 * Math.cos(ang + 0.42), ey - 9 * Math.sin(ang + 0.42));
        ctx.closePath();
        ctx.fill();
      }
      if (!src) {
        ctx.fillStyle = GROUND;
        ctx.strokeStyle = INK_DIM;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x0, y0, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = INK_FAINT;
        ctx.font = `500 8.5px ${MONO}`;
        ctx.textBaseline = "middle";
        ctx.fillText("outside", x0 - 44, y0);
      }
      ctx.restore();
      if (p > 0.6 && len > 70) plate(s.kind, (x0 + x1) / 2, (y0 + y1) / 2, alpha * clamp((p - 0.6) / 0.25, 0, 1));
    }

    function chip(b, text, a) {
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = `500 8.5px ${MONO}`;
      const w = ctx.measureText(text).width + 12;
      const x = b.x + 4, y = b.y + BH + 5;
      ctx.fillStyle = "#1a1408";
      ctx.strokeStyle = EFFECT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, w, 14, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = EFFECT;
      ctx.textBaseline = "middle";
      ctx.fillText(text, x + 6, y + 7.5);
      ctx.restore();
    }

    function render() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const px = opts.parallax ? (mouse.x - 0.5) * -10 : 0;
      const py = opts.parallax ? (mouse.y - 0.5) * -6 : 0;
      ctx.translate(ox + px - camX, oy + py);
      ctx.scale(scale, scale);

      const built = (b) => (phase === "build" ? easeOut((now - phaseAt - b.order * BUILD_EVERY) / BUILD_IN) : 1);
      for (const b of tree.blocks) if (b.children) for (const c of b.children) containment(b, c, built(c));

      const lit = litNow();
      const sinceStep = now - stepAt;
      const ending = phase === "hold" && auto ? 1 - easeOut((now - phaseAt - HOLD_MS + 500) / 500) : 1;
      if (phase === "run" || phase === "hold") {
        const last = phase === "hold" ? STEPS.length - 1 : step;
        for (let i = 0; i <= last; i++) {
          const s = STEPS[i];
          if (s.effect) continue;
          const current = i === last && phase === "run";
          const progress = current ? sinceStep / ARROW_MS : 1;
          const alpha = (current ? 1 : Math.max(0.1, 0.42 - (last - i) * 0.05)) * ending;
          arrow(s, progress, alpha);
        }
      }
      for (const b of tree.blocks) {
        const isLit = lit && lit[0] === b.name && sinceStep > ARROW_MS * 0.5;
        block(b, built(b), isLit, lit && lit[1]);
      }
      for (const c of chips) chip(tree.byName[c.at], c.text, ending * easeOut((now - c.at_ms) / 250));
      // The effect of the step itself, named on its block.
      if (lit && lit[1] === EFFECT) plate(STEPS[step].effect, tree.byName[lit[0]].x + BW / 2, tree.byName[lit[0]].y - 12, easeOut(sinceStep / 250), EFFECT);
    }

    function report() {
      if (!opts.onStep) return;
      opts.onStep(phase, step, STEPS.length, step >= 0 ? STEPS[step] : null, auto);
    }

    function goTo(i) {
      step = i;
      stepAt = now;
      phase = "run";
      const s = STEPS[i];
      if (s.effect && !chips.some((c) => c.step === i)) chips.push({ step: i, at: s.at, text: s.effect, at_ms: now });
      if (i === STEPS.length - 1 && opts.onFinish) opts.onFinish();
      report();
    }
    function restart() {
      chips = [];
      goTo(0);
    }
    function next() {
      if (phase !== "run") return restart();
      if (step < STEPS.length - 1) goTo(step + 1);
      else { phase = "hold"; phaseAt = now; report(); }
    }
    function startAt(name) {
      let i = STEPS.findIndex((s) => s.to === name || s.at === name);
      if (i < 0) i = STEPS.findIndex((s) => s.from === name);
      if (i < 0) return;
      // Everything that happened before this step stays on the drawing.
      chips = STEPS.slice(0, i).map((s, k) => (s.effect ? { step: k, at: s.at, text: s.effect, at_ms: 0 } : null)).filter(Boolean);
      auto = true;
      goTo(i);
      still();
    }

    function update(ms) {
      now = ms;
      if (phase === "build") {
        if (now - phaseAt > BUILD_EVERY * tree.blocks.length + BUILD_IN + PAUSE_BEFORE_RUN) restart();
      } else if (phase === "run" && auto) {
        const s = STEPS[step];
        if (now - stepAt > (s.effect ? EFFECT_MS : STEP_MS)) next();
      } else if (phase === "hold" && auto) {
        if (now - phaseAt > HOLD_MS) restart();
      }
      follow(0.08);
    }
    function follow(k) {
      if (!pans) return;
      const l = litNow();
      const focus = l ? tree.byName[l[0]] : tree.byName["Booking API"];
      camTarget = clamp(focus.x * scale + (BW * scale) / 2 - width / 2, 0, Math.max(0, tree.w * scale + 40 - width));
      camX += (camTarget - camX) * k;
    }
    // A change made by hand while nothing is animating: move time on and draw it.
    function still() {
      if (running) return;
      now += STEP_MS;
      follow(1);
      render();
    }

    function frame(ms) {
      if (phaseAt === 0) { phaseAt = ms; stepAt = ms; }
      update(ms);
      render();
      if (running) raf = requestAnimationFrame(frame);
    }
    function start() {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }
    // Motion the page starts by itself stays off when the person asked for less of it.
    function autoStart() { if (!REDUCED) start(); }

    // Pointing at a block brightens it; clicking one starts the run there.
    function blockAt(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const px = opts.parallax ? (mouse.x - 0.5) * -10 : 0, py = opts.parallax ? (mouse.y - 0.5) * -6 : 0;
      const wx = (clientX - r.left - ox - px + camX) / scale, wy = (clientY - r.top - oy - py) / scale;
      return tree.blocks.find((b) => IN_RUN.has(b.name) && wx >= b.x && wx <= b.x + BW && wy >= b.y && wy <= b.y + BH) || null;
    }
    canvas.addEventListener("pointermove", (e) => {
      mouse.x = e.clientX / window.innerWidth;
      mouse.y = e.clientY / window.innerHeight;
      const b = FINE_POINTER ? blockAt(e.clientX, e.clientY) : null;
      if (b !== hovered) { hovered = b; canvas.style.cursor = b ? "pointer" : ""; if (!running) render(); }
    });
    canvas.addEventListener("pointerleave", () => { hovered = null; canvas.style.cursor = ""; mouse.x = mouse.y = 0.5; });
    canvas.addEventListener("click", (e) => { const b = blockAt(e.clientX, e.clientY); if (b) startAt(b.name); });

    new ResizeObserver(resize).observe(canvas);
    // Drawn from the start; paused only while wholly off screen or the tab is hidden.
    let onScreen = true;
    const io = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      onScreen && !document.hidden ? autoStart() : stop();
    }, { threshold: 0 });
    io.observe(canvas);
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : onScreen && autoStart()));

    if (REDUCED) {
      // One still: the whole run drawn, nothing moving. Step still works by hand.
      phase = "run"; auto = false; now = 1e6; stepAt = 0;
      chips = STEPS.map((s, k) => (s.effect ? { step: k, at: s.at, text: s.effect, at_ms: 0 } : null)).filter(Boolean);
      step = STEPS.length - 1;
      report();
    }
    if (document.fonts) document.fonts.ready.then(() => render());
    resize();
    autoStart();

    return {
      step() { auto = false; next(); still(); },
      play() { auto = true; report(); start(); },
      pause() { auto = false; report(); },
      resize,
      blocks: tree.blocks.length,
      steps: STEPS.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Page behaviour                                                      */
  /* ------------------------------------------------------------------ */

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(() => {
    const $ = (s, el) => (el || document).querySelector(s);

    /* The hero and its readout, styled after the app's own execution bar. */
    const canvas = $("#hero-canvas");
    if (canvas) {
      const count = $("#exec-count"), line = $("#exec-line"), words = $("#exec-words");
      const playBtn = $("#exec-play"), stepBtn = $("#exec-step"), lastWord = $("#built"), bar = $(".execbar");
      let litTimer = 0, playing = true;
      const diagram = livingDiagram(canvas, {
        parallax: !REDUCED && FINE_POINTER,
        maxScale: 1,
        inset: () => bar.offsetHeight + 20,
        onStep(phase, step, total, s, auto) {
          if (phase === "build" || !s) { count.textContent = ""; line.textContent = "Book seats · written down"; words.textContent = ""; }
          else if (phase === "hold") { count.textContent = `${total} of ${total}`; line.textContent = "The run is over."; words.textContent = "Click a block to start it from there."; }
          else { count.textContent = `${step + 1} of ${total}`; line.textContent = sentence(s); words.textContent = s.text; }
          playing = auto;
          playBtn.textContent = auto ? "Pause" : "Play";
          line.setAttribute("aria-live", auto ? "off" : "polite");
        },
        onFinish() {
          if (!lastWord) return;
          lastWord.classList.add("is-lit");
          clearTimeout(litTimer);
          litTimer = setTimeout(() => lastWord.classList.remove("is-lit"), 1600);
        },
      });
      new ResizeObserver(() => diagram.resize()).observe(bar);
      stepBtn.addEventListener("click", () => diagram.step());
      playBtn.addEventListener("click", () => (playing ? diagram.pause() : diagram.play()));
      const blocks = $("#status-blocks"), steps = $("#status-steps");
      if (blocks) blocks.textContent = String(diagram.blocks);
      if (steps) steps.textContent = String(diagram.steps);
    }

    /* The command panels draw themselves as they come into view. */
    const panels = document.querySelectorAll("[data-reveal]");
    if (REDUCED || !("IntersectionObserver" in window)) panels.forEach((el) => el.classList.add("is-in"));
    else {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
      }, { threshold: 0.35 });
      panels.forEach((el) => io.observe(el));
    }
  });
})();
