/* Studio Royd — render sequence player.
   Each [data-seq] section pins a canvas and draws a rendered frame sequence.
   data-mode="auto":    plays on its own at 30 fps once triggered
                        (data-trigger="load":   when the page opens, after a short hold,
                         data-trigger="scroll": the visitor's first scroll,
                         data-trigger="enter":  the section scrolling into view).
   data-loop="reverse": an auto sequence plays forward, pauses briefly at the end,
                        plays backward, holds on the first frame, and repeats.
   data-loop="fade":    an auto sequence crossfades from its last frame back to its first.
   data-mode="forward": follows the scroll, but never rewinds.
   data-mode="scrub":   follows the scroll both ways.
   data-mode="drag":    a looping turntable. Spins slowly on its own while on screen;
                        dragging (mouse or finger) or the arrow keys turn it, with
                        momentum on release. data-drag-dir="-1" flips the direction.
                        data-variants="a,b,c" adds colourways: [data-variant] buttons
                        switch between frame sets with a crossfade at the same angle. */
(() => {
  "use strict";

  // Render backdrop colour. Replaced by matchGrey() with the grey this device actually decodes
  // from the frames: some decoders (iPhone) make it a shade lighter than the CSS colour, which
  // showed as a soft-edged box around every frame.
  let BG = "#C4C4C4";
  let BG_CLEAR = "rgba(196,196,196,0)";
  let greyMatched = false;
  const IW = 1440, IH = 1080;        // logical frame size
  const BAR_H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h")) || 64;
  const FPS = 30;
  const LOAD_HOLD = 800;             // ms the first frame holds before a "load" sequence plays
  const END_HOLD = 1500;             // fade loop: ms the last frame holds
  const TURN_HOLD = 300;             // reverse loop: short pause on the last frame before playing back
  const FADE_MS = 600;               // looping: crossfade from last frame back to first
  const MAX_LOADS = 6;               // parallel image requests
  const IDLE_FPS = 30;               // drag mode: idle spin speed, a turn in 4 s. 30 lands evenly on 60/120 Hz
                                     // screens (each frame shows for 2 or 4 refreshes); 18 stuttered
  const DRAG_TURN = 1.2;             // drag mode: stage widths of drag for one full turn
  const SETTLE = 2.2;                // drag mode: how quickly momentum eases back to the idle spin
  const SWAP_MS = 350;               // colourway crossfade
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const pad = (n) => String(n).padStart(4, "0");
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Pick frame size once: phones and small windows get the 960px set.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const drawnWidth = Math.min(innerWidth, innerHeight * IW / IH) * dpr;
  const SIZE = drawnWidth < 1100 ? "m" : "d";

  const sections = [...document.querySelectorAll("[data-seq]")].map((el) => {
    const dirs = (el.dataset.variants || el.dataset.seq).split(",").map((d) => d.trim());
    const s = {
      el,
      count: +el.dataset.count,
      mode: el.dataset.mode || "forward",
      trigger: el.dataset.trigger || "enter",
      canvas: el.querySelector("canvas"),
      ctx: null,
      xf: null,
      // One frame set per variant (colourway).
      sets: dirs.map((dir) => ({ dir, imgs: [], ok: [], missing: false })),
      cur: 0,            // current set
      prev: -1,          // set being crossfaded from (-1: none)
      swapStart: 0,
      swapMix: 1,
      want: -1,          // set waiting for its frame to load before switching
      drawn: -1,
      dirty: false,
      idx: 0,            // frame currently shown
      pos: 0,            // playback position in frames (auto and drag modes)
      state: "idle",     // idle → playing → done (auto mode)
      lastT: 0,
      armAt: 0,
      loop: el.dataset.loop || "",       // "", "reverse" or "fade"
      sign: 1,           // playback direction (reverse loop)
      until: 0,          // end of the current hold (looping)
      fadeStart: 0,
      fadeT: 0,          // 0–1 crossfade back to frame 0 (looping)
      stage: el.querySelector(".stage"),
      dragDir: +(el.dataset.dragDir || 1),
      vel: 0,            // drag mode: turning speed in frames per second
      dragging: false,
      lastX: 0,
      lastMoveT: 0,
      idleDir: 1,        // drag mode: the idle spin follows the last direction turned
      buttons: [...el.querySelectorAll("[data-variant]")],
      // data-show="a,b" or several windows "a,b;c,d" (fractions of the sequence), or "end":
      // hidden until the sequence has finished playing, then faded in by CSS.
      fades: [...el.querySelectorAll("[data-show]")].map((n) => ({
        n, end: n.dataset.show === "end",
        r: n.dataset.show.split(";").map((w) => w.split(",").map(Number)),
      })),
      labels: null,
    };
    s.dir = s.sets[0].dir;
    return s;
  });

  /* ---------- Loading ---------- */
  let queue = [];
  let active = 0;
  // Bump a set's number after re-rendering it, so browsers drop the cached frames.
  const FRAMES_V = { turn: 2 };
  const src = (dir, i) => `frames/${SIZE}/${dir}/${pad(i)}.webp` + (FRAMES_V[dir] ? `?v=${FRAMES_V[dir]}` : "");

  // Average the frame's top-left 16x16 corner (always plain backdrop in every render) and make
  // it the page grey: body, top-bar fade and canvas fill all follow --grey / --grey-rgb.
  function matchGrey(img) {
    greyMatched = true;
    try {
      const t = document.createElement("canvas");
      t.width = t.height = 1;
      const x = t.getContext("2d", { willReadFrequently: true });
      x.drawImage(img, 0, 0, 16, 16, 0, 0, 1, 1);
      const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
      if (Math.abs(r - g) > 6 || Math.abs(g - b) > 6) return;   // not a neutral grey: keep the CSS one
      BG = `rgb(${r},${g},${b})`;
      BG_CLEAR = `rgba(${r},${g},${b},0)`;
      const root = document.documentElement.style;
      root.setProperty("--grey", BG);
      root.setProperty("--grey-rgb", `${r} ${g} ${b}`);
      sections.forEach((s) => { s.dirty = true; });
    } catch (e) { /* canvas read blocked: keep the CSS grey */ }
  }

  function pump() {
    while (active < MAX_LOADS && queue.length) {
      const { s, set, i } = queue.shift();
      if (set.imgs[i] || set.missing) continue;
      const img = new Image();
      img.decoding = "async";
      set.imgs[i] = img;
      active++;
      img.onload = () => {
        if (!greyMatched) matchGrey(img);
        set.ok[i] = true; active--; s.dirty = true; schedule(); pump();
      };
      img.onerror = () => {
        active--;
        if (i === 0) hideVariant(s, set);   // not rendered yet: hide its button
        pump();
      };
      img.src = src(set.dir, i);
    }
  }
  function prioritise(s, set) {
    const mine = queue.filter((q) => q.s === s && (!set || q.set === set));
    queue = mine.concat(queue.filter((q) => !mine.includes(q)));
    pump();
  }
  // First frames of every section, then each section's main set in page order,
  // then the other colourways last.
  sections.forEach((s) => queue.push({ s, set: s.sets[0], i: 0 }));
  sections.forEach((s) => { for (let i = 1; i < s.count; i++) queue.push({ s, set: s.sets[0], i }); });
  sections.forEach((s) => {
    s.sets.slice(1).forEach((set) => { for (let i = 0; i < s.count; i++) queue.push({ s, set, i }); });
  });
  pump();

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { const s = sections.find((x) => x.el === e.target); prioritise(s, s.sets[s.cur]); }
    });
  }, { rootMargin: "150% 0px" });
  sections.forEach((s) => io.observe(s.el));

  /* ---------- Layout & drawing ---------- */
  function layout(s) {
    const c = s.canvas;
    const ds = s.el.dataset;
    if (s.labels || ds.box || ds.fit) s.stage.style.height = "";   // measure at full screen height first
    const w = c.clientWidth, h = c.clientHeight;
    const contain = Math.min(w / IW, h / IH);
    const cover = Math.max(w / IW, h / IH);
    // Landscape: fill most of the screen, cropping at most a little.
    // Portrait: enlarge past "contain" so the product isn't tiny.
    let scale = w >= h ? Math.min(cover, contain * 1.32) : Math.min(cover, contain * 1.6);
    // Hero and assembly on tall screens (phones): fill the screen like the desktop version
    // instead of a letterboxed frame with soft top and bottom edges.
    if (w < h && (s.el.querySelector(".hero-top") || ds.fit)) scale = cover;
    let dx = (w - IW * scale) / 2, dy = (h - IH * scale) / 2;
    // Phones turned sideways (short landscape screens): the parts fit between the heading and the
    // bottom of the screen instead of running under the text. data-parts: the parts' top and
    // bottom rows in the first frame. The exploded view also keeps room for its labels, which
    // hang under the lowest label point (shorter lines on these screens, see style.css).
    const short = w > h && h < 520;
    const lowest = s.labels ? Math.max(...s.labels.map((L) => Math.max(...L.pts.map((p) => p[1])))) : 0;
    const heading = s.el.querySelector(".hero-top, .block-top:not(.block-end)");
    if (short && ds.parts && heading) {
      const [pt, pb] = ds.parts.split(",").map(Number);
      const hang = lowest ? s.labels[0].el.offsetHeight + 12 : 0;
      const a = heading.offsetTop + heading.offsetHeight + 16, b = h - 8;
      scale = Math.min(scale, (b - a) / (pb - pt));
      if (lowest) scale = Math.min(scale, (b - hang - a) / (lowest - pt));
      const bottom = Math.max(pb * scale, lowest * scale + hang);
      dx = (w - IW * scale) / 2;
      dy = a + (b - a - (bottom - pt * scale)) / 2 - pt * scale;
    }
    // Assembly: the heading and subtitle sit 56px under the finished product (data-fit: its top
    // and bottom in the last frame, in frame pixels).
    // Phones: the frame fills the screen and the text goes under the product (closer on short
    // screens, so it always ends at least 24px above the bottom).
    // Landscape: the product and the text are fitted together between the top bar and the
    // bottom of the screen, centred there. The frame shrinks only when they don't fit.
    const head = s.el.querySelector(".block-end");
    const textUnder = !!(ds.fit && head);
    s.el.classList.toggle("text-under", textUnder);
    if (textUnder) {
      const [ft, fb] = ds.fit.split(",").map(Number);
      let textY;
      if (w < h) {
        textY = Math.min(dy + fb * scale + 56, h - head.offsetHeight - 24);
      } else {
        const gap = short ? 24 : 56;                // phones turned sideways: closer, so the product is larger
        const lo = BAR_H + h * 0.03, hi = h - Math.max(24, h * 0.05);
        const room = hi - lo - gap - head.offsetHeight;
        scale = Math.min(scale, room / (fb - ft));
        const top = lo + (room - (fb - ft) * scale) / 2;
        dx = (w - IW * scale) / 2;
        dy = top - ft * scale;
        textY = top + (fb - ft) * scale + gap;
      }
      s.el.style.setProperty("--text-y", `${Math.round(textY)}px`);
    }
    // Turntable: when its text fits to the left, the product moves right (data-shift, share of
    // the width, never past the right margin) and the text sits centre left (.side in CSS).
    // data-box = the product's extent over the whole spin: left, top, right, bottom in frame pixels.
    const text = s.el.querySelector(".block-tl");
    // Short landscape screens: always beside the text, sized to fit between the top bar and the
    // bottom of the screen and centred in the space to the right of the text.
    if (ds.box && text) {
      const [bl, bt, br, bb] = ds.box.split(",").map(Number);
      const pad = text.offsetLeft;
      const shift = Math.max(0, Math.min(parseFloat(ds.shift) * w, w - pad - (dx + br * scale)));
      const minTop = BAR_H + h * 0.03;              // keep the headband clear of the top bar
      if (short) {
        const left = pad + text.offsetWidth + 48, right = w - pad, bottom = h - Math.max(24, h * 0.05);
        scale = Math.min(scale, (right - left) / (br - bl), (bottom - minTop) / (bb - bt));
        dx = (left + right - (bl + br) * scale) / 2;
        dy = (minTop + bottom - (bt + bb) * scale) / 2;
        s.el.classList.add("side");
      } else if (dx + bl * scale + shift >= pad + text.offsetWidth + 48) {
        dx += shift;
        const top = dy + bt * scale;
        if (top < minTop) dy += minTop - top;
        s.el.classList.add("side");
      } else {
        s.el.classList.remove("side");
      }
    }
    // Turntable on tall screens (phones): the product's top lands 72px under the heading and
    // subtitle, and the colour dots move to the centre, 88px under the product (.dots-under).
    // data-box gives the product's top and bottom rows.
    const under = w < h && text && ds.box && !s.el.classList.contains("side");
    s.el.classList.toggle("dots-under", !!under);
    let dotsEnd = 0;
    if (under) {
      const [, bt, , bb] = ds.box.split(",").map(Number);
      dy = text.offsetTop + text.offsetHeight + 72 - bt * scale;
      const dotsTop = dy + bb * scale + 88;
      s.el.style.setProperty("--dots-y", `${Math.round(dotsTop - text.offsetTop)}px`);
      s.el.style.setProperty("--dots-x", `${Math.round(w / 2 - text.offsetLeft)}px`);
      dotsEnd = dotsTop + 20;
    }
    // Exploded view: the pinned stage ends 40px under the lowest label instead of at the bottom
    // of the screen, so the next section follows right after it (no overlap; the page grey
    // below matches the render). A label hangs ~72px below its part (12px offset, 34px line,
    // 8px gap, name). The frame is still placed for the full height, so nothing moves.
    let ch = h;
    if (s.labels) {
      ch =Math.min(h, Math.round(dy + lowest * scale + 72 + 40));
      s.stage.style.height = `${ch}px`;
    } else if (w < h && ds.box) {
      // Turntable on tall screens: the stage ends 40px under the colour dots, so the next
      // section follows without most of a screen of empty grey.
      ch = Math.min(h, Math.round(dotsEnd + 40));
      s.stage.style.height = `${ch}px`;
    }
    c.width = Math.round(w * dpr);
    c.height = Math.round(ch * dpr);
    s.ctx = c.getContext("2d");
    s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.ctx.imageSmoothingQuality = "high";
    s.xf = { w, h, s: scale, dx, dy };
    s.drawn = -1;
    s.dirty = true;
  }

  function nearestIn(ok, count, i) {
    if (ok[i]) return i;
    for (let d = 1; d < count; d++) {
      if (ok[i - d]) return i - d;
      if (ok[i + d]) return i + d;
    }
    return -1;
  }

  function feather(ctx, x, y, w, h, horizontal, flip) {
    const g = horizontal
      ? ctx.createLinearGradient(flip ? x + w : x, 0, flip ? x : x + w, 0)
      : ctx.createLinearGradient(0, flip ? y + h : y, 0, flip ? y : y + h);
    g.addColorStop(0, BG);
    g.addColorStop(1, BG_CLEAR);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }

  function edges(s) {
    const { ctx, xf } = s;
    const { w, h, dx, dy } = xf;
    const dw = IW * xf.s, dh = IH * xf.s;
    const f = Math.min(dw * 0.06, 90);
    if (dx > 0.5) { feather(ctx, dx, 0, f, h, true, false); feather(ctx, dx + dw - f, 0, f, h, true, true); }
    if (dy > 0.5) { feather(ctx, 0, dy, w, f, false, false); feather(ctx, 0, dy + dh - f, w, f, false, true); }
  }

  // Draws frame `want` of the current set. mix > 0 blends frame 0 over it (loop
  // crossfade); a colourway swap blends from the previous set at the same frame.
  function draw(s, want, mix = 0) {
    const set = s.sets[s.cur];
    const i = nearestIn(set.ok, s.count, want);
    const swapping = s.prev >= 0;
    if (i < 0 || (i === s.drawn && !s.dirty && mix === 0 && !swapping)) return;
    s.dirty = false;
    const { ctx, xf } = s;
    const { w, h, dx, dy } = xf;
    const dw = IW * xf.s, dh = IH * xf.s;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    if (swapping) {
      const from = s.sets[s.prev];
      const j = nearestIn(from.ok, s.count, want);
      if (j >= 0) ctx.drawImage(from.imgs[j], dx, dy, dw, dh);
      ctx.globalAlpha = s.swapMix;
    }
    ctx.drawImage(set.imgs[i], dx, dy, dw, dh);
    ctx.globalAlpha = 1;
    if (mix > 0 && set.ok[0]) {
      ctx.globalAlpha = mix;
      ctx.drawImage(set.imgs[0], dx, dy, dw, dh);
      ctx.globalAlpha = 1;
    }
    edges(s);
    s.drawn = i;
  }

  /* ---------- Overlays ---------- */
  function windowOpacity(p, a, b, fade = 0.045) {
    if (p < a - fade || p > b + fade) return 0;
    if (p < a) return (p - (a - fade)) / fade;
    if (p > b) return 1 - (p - b) / fade;
    return 1;
  }

  function buildLabels(s) {
    const data = window.EXPLODE_LABELS;
    const host = s.el.querySelector(".labels");
    if (!data || !host) return null;
    return data.map((d) => {
      const el = document.createElement("div");
      el.className = "label";
      el.innerHTML = `<span class="label-text"></span><span class="label-line"></span>`;
      el.querySelector(".label-text").textContent = d.name;
      host.appendChild(el);
      return { el, pts: d.pts };
    });
  }

  // p = how far through the sequence the shown frame is (0–1).
  function update(s, p) {
    const idx = s.idx;
    s.el.dataset.frame = idx;          // current frame, handy for testing
    s.fades.forEach(({ n, r, end }) => {
      if (end) { n.classList.toggle("is-shown", s.state === "done"); return; }
      const o = Math.max(...r.map(([a, b]) => windowOpacity(p, a, b)));
      n.style.opacity = o.toFixed(3);
      n.style.transform = reduceMotion ? "" : `translateY(${((1 - o) * 14).toFixed(1)}px)`;
      n.style.visibility = o < 0.01 ? "hidden" : "visible";
    });

    if (s.labels) {
      const { dx, dy, w } = s.xf, sc = s.xf.s;
      const stageTop = s.stage.getBoundingClientRect().top;   // moves up once the stage unpins
      s.labels.forEach((L, k) => {
        const [x, y] = L.pts[Math.min(idx, L.pts.length - 1)];
        const sx = dx + x * sc, sy = dy + y * sc;
        const start = 0.06 + k * 0.1;              // labels appear one at a time
        let o = clamp((p - start) / 0.06, 0, 1);
        if (sx < 40 || sx > w - 40) o = 0;          // hide if the part is off-screen
        o *= clamp((stageTop + sy + 12 - BAR_H) / 40, 0, 1);   // fade out before sliding under the top bar
        L.el.style.opacity = o.toFixed(3);
        // Hangs below the part: line on top, name underneath.
        L.el.style.transform = `translate(${sx.toFixed(1)}px, ${(sy + 12).toFixed(1)}px) translate(-50%, 0)` +
          (reduceMotion ? "" : ` translateY(${((o - 1) * 8).toFixed(1)}px)`);
      });
    }
  }

  /* ---------- Auto playback ---------- */
  function start(s) {
    if (s.state !== "idle") return;
    s.state = "playing";
    s.lastT = performance.now();
    prioritise(s, s.sets[s.cur]);
    schedule();
  }

  // Advance at 30 fps, but never past a frame that hasn't loaded yet.
  function advance(s, now) {
    const ok = s.sets[s.cur].ok;
    const dt = clamp((now - s.lastT) / 1000, 0, 0.1);   // rAF time can trail performance.now()
    s.lastT = now;
    if (s.sign < 0) {
      // Reverse leg: all frames were loaded on the way forward.
      s.pos = Math.max(0, s.pos - dt * FPS);
      s.idx = Math.floor(s.pos);
      if (s.pos <= 0) {                                      // back at the start: hold, then play forward
        s.idx = 0; s.pos = 0; s.sign = 1;
        s.state = "holdStart"; s.until = now + LOAD_HOLD;
      }
      return;
    }
    const want = s.pos + dt * FPS;
    const target = Math.min(Math.floor(want), s.count - 1);
    let k = Math.floor(s.pos);
    while (k < target && ok[k + 1]) k++;
    s.pos = k < target ? k : want;
    s.idx = Math.min(Math.floor(s.pos), s.count - 1);
    if (s.idx >= s.count - 1) {
      s.idx = s.count - 1;
      if (s.loop) { s.state = "holdEnd"; s.until = now + (s.loop === "reverse" ? TURN_HOLD : END_HOLD); }
      else s.state = "done";
    }
  }

  // Playback states: playing → (fade loop) holdEnd → fade → holdStart → playing …
  // A reverse loop pauses briefly at the end (holdEnd, TURN_HOLD), plays backward, and holds (holdStart) at frame 0.
  function step(s, now) {
    if (s.state === "playing") {
      advance(s, now);
    } else if (s.state === "holdEnd") {
      if (now >= s.until) {
        if (s.loop === "reverse") { s.state = "playing"; s.sign = -1; s.pos = s.count - 1; s.lastT = now; }
        else { s.state = "fade"; s.fadeStart = now; }
      }
    } else if (s.state === "fade") {
      s.fadeT = clamp((now - s.fadeStart) / FADE_MS, 0, 1);
      if (s.fadeT >= 1) {
        s.state = "holdStart"; s.idx = 0; s.pos = 0; s.fadeT = 0; s.dirty = true;
        s.until = now + LOAD_HOLD;
      }
    } else if (s.state === "holdStart") {
      if (now >= s.until) { s.state = "playing"; s.lastT = now; }
    }
  }

  /* ---------- Drag (turntable) ---------- */
  const wrap = (s, i) => ((i % s.count) + s.count) % s.count;
  const fromControl = (e) => e.target.closest("button, a, input");

  function initDrag(s) {
    const st = s.stage;
    st.addEventListener("pointerdown", (e) => {
      if ((e.pointerType === "mouse" && e.button !== 0) || fromControl(e)) return;
      s.dragging = true;
      s.lastX = e.clientX;
      s.lastMoveT = performance.now();
      s.vel = 0;
      st.setPointerCapture(e.pointerId);
      st.classList.add("is-dragging");
      schedule();
    });
    st.addEventListener("pointermove", (e) => {
      if (!s.dragging) return;
      const t = performance.now();
      const df = (e.clientX - s.lastX) * s.count / (st.clientWidth * DRAG_TURN) * s.dragDir;
      s.pos += df;
      const dt = Math.max((t - s.lastMoveT) / 1000, 0.001);
      s.vel = 0.75 * s.vel + 0.25 * (df / dt);         // smoothed for the release momentum
      if (df) s.idleDir = Math.sign(df);
      s.lastX = e.clientX;
      s.lastMoveT = t;
      schedule();
    });
    const end = () => {
      if (!s.dragging) return;
      s.dragging = false;
      st.classList.remove("is-dragging");
      if (performance.now() - s.lastMoveT > 80) s.vel = 0;  // held still before letting go
      s.vel = clamp(s.vel, -s.count * 0.6, s.count * 0.6);   // a flick spins at most ~0.6 turn/s
      s.lastT = performance.now();
      schedule();
    };
    st.addEventListener("pointerup", end);
    st.addEventListener("pointercancel", end);
    st.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (fromControl(e)) return;
      e.preventDefault();
      const d = (e.key === "ArrowRight" ? 3 : -3) * s.dragDir;   // 3 frames = 9°
      s.pos += d;
      s.vel = 0;
      s.idleDir = Math.sign(d);
      schedule();
    });
  }

  // Idle spin and release momentum; dragging moves pos directly.
  function spin(s, now, onScreen) {
    const dt = clamp((now - (s.lastT || now)) / 1000, 0, 0.1);
    s.lastT = now;
    if (onScreen && !s.dragging) {
      const idle = reduceMotion ? 0 : IDLE_FPS * s.idleDir;
      s.vel += (idle - s.vel) * (1 - Math.exp(-dt * SETTLE));
      s.pos += s.vel * dt;
    }
    s.idx = wrap(s, Math.round(s.pos));
    return onScreen && !s.dragging;
  }

  /* ---------- Colourways ---------- */
  function hideVariant(s, set) {
    set.missing = true;
    const k = s.sets.indexOf(set);
    const b = s.buttons.find((x) => +x.dataset.variant === k);
    if (b && k > 0) b.hidden = true;
  }

  function initVariants(s) {
    s.buttons.forEach((b) => b.addEventListener("click", () => {
      const k = +b.dataset.variant;
      if (k === s.cur || s.sets[k].missing) return;
      s.want = k;                                  // switch once its frames are in
      prioritise(s, s.sets[k]);
      s.buttons.forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      schedule();
    }));
  }

  // Switch to the requested set as soon as it has the frame we're on, then crossfade.
  function swap(s, now) {
    if (s.want >= 0 && nearestIn(s.sets[s.want].ok, s.count, s.idx) === s.idx) {
      s.prev = s.cur;
      s.cur = s.want;
      s.dir = s.sets[s.cur].dir;
      s.want = -1;
      s.swapStart = now;
      s.swapMix = 0;
    }
    if (s.prev >= 0) {
      s.swapMix = clamp((now - s.swapStart) / SWAP_MS, 0, 1);
      if (s.swapMix >= 1) { s.prev = -1; s.dirty = true; }
    }
    return s.want >= 0 || s.prev >= 0;
  }

  /* ---------- Main loop ---------- */
  let ticking = false;
  function schedule() {
    if (!ticking) { ticking = true; requestAnimationFrame(tick); }
  }

  function tick(now) {
    ticking = false;
    const vh = innerHeight;
    let keepGoing = false;

    sections.forEach((s) => {
      const r = s.el.getBoundingClientRect();

      if (s.mode === "auto") {
        if (s.state === "idle") {
          let go;
          if (s.trigger === "load") {
            // Hold the first frame briefly once it's on screen, then play.
            if (s.sets[s.cur].ok[0] && !s.armAt) s.armAt = now + LOAD_HOLD;
            go = s.armAt > 0 && now >= s.armAt;
            keepGoing = true;
          } else if (s.trigger === "scroll") {
            go = scrollY > 2;
          } else {
            go = r.top <= vh * 0.25 && r.bottom > vh * 0.5;
          }
          if (go) start(s);
        }
        if (s.state !== "idle" && s.state !== "done") {
          const onScreen = r.bottom > 0 && r.top < vh;
          if (s.loop && !onScreen) {
            s.lastT = now;                 // a loop pauses while scrolled away
          } else {
            step(s, now);
            keepGoing = true;
          }
        }
      } else if (s.mode === "drag") {
        if (spin(s, now, r.bottom > 0 && r.top < vh)) keepGoing = true;
        if (swap(s, now)) keepGoing = true;
      } else {
        const total = r.height - vh;
        const p = clamp(-r.top / total, 0, 1);
        const at = Math.round(p * (s.count - 1));
        // "forward" keeps the furthest frame reached; "scrub" follows the scroll both ways.
        s.idx = s.mode === "forward" ? Math.max(s.idx, at) : at;
      }

      if (r.bottom < -vh * 0.25 || r.top > vh * 1.25) return; // off-screen: skip drawing
      draw(s, s.idx, s.state === "fade" ? s.fadeT : 0);
      update(s, s.idx / Math.max(1, s.count - 1));
    });

    if (keepGoing) schedule();
  }

  function relayout() {
    sections.forEach((s) => layout(s));
    schedule();
  }

  sections.forEach((s) => {
    if (s.sets[0].dir === "explode") s.labels = buildLabels(s);
    if (s.mode === "drag") { initDrag(s); initVariants(s); }
  });
  relayout();
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", relayout);

  /* ---------- Footer logo animation ---------- */
  // Plays once when the footer comes into view and stops on the wordmark (its last frame).
  const logoAnim = document.querySelector(".logo-anim");
  if (logoAnim) {
    const toEnd = () => { logoAnim.currentTime = Math.max(0, (logoAnim.duration || 0) - 0.01); };
    const obs = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect();
      if (reduceMotion) {
        if (logoAnim.readyState >= 1) toEnd(); else logoAnim.addEventListener("loadedmetadata", toEnd, { once: true });
        return;
      }
      logoAnim.play().catch(() => toEnd());     // if playback is blocked, still show the wordmark
    }, { threshold: 0.6 });
    obs.observe(logoAnim);
  }
})();
