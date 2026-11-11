// Work page: small looping thumbnails of past projects drift up the screen in three depths.
// Far: every work as a small, pale still, moving slowly. Mid and near: the clips (and the two
// stills), larger and faster. Each layer loops: a thumbnail that leaves the top comes back in
// below the screen. Faded until the mouse is over one (style.css).
(() => {
  // slug, width, height, has a clip (media/work/<slug>.mp4; every work has <slug>.webp)
  const WORKS = [
    ["a3", 226, 400, 1], ["a4", 226, 400, 1], ["a6", 226, 400, 1], ["boxes", 226, 400, 1],
    ["chair", 320, 400, 0], ["cloth-stairs", 400, 226, 1], ["constellation-hand", 400, 226, 1],
    ["constellation", 400, 226, 1], ["coreline", 400, 226, 1], ["flow", 400, 300, 1],
    ["frame-12", 400, 226, 1], ["handbag", 320, 400, 1], ["happy-skin", 226, 400, 1],
    ["happy-skin-2", 226, 400, 1], ["headphones", 400, 300, 1],
    ["invite", 400, 226, 1], ["jawbreaker", 320, 400, 1], ["lancome", 226, 400, 1],
    ["lipstick", 226, 400, 1], ["magazine", 320, 400, 1], ["morning-after", 400, 226, 1],
    ["obb", 400, 226, 1], ["obb-cards", 400, 226, 1], ["pages", 400, 300, 1], ["pringles", 400, 226, 1],
    ["proli", 400, 226, 1], ["ropes", 320, 400, 0], ["sneaker", 320, 400, 1],
    ["teaser", 320, 400, 1], ["tools", 400, 300, 1], ["vanishing-point", 400, 226, 1],
  ];
  const wall = document.querySelector(".wall");
  const host = wall && wall.querySelector(".pins");
  if (!host) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Fixed shuffle and jitter, so the wall looks the same on every visit.
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const order = WORKS.map((w) => [rnd(), w]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

  // size: share of the near size; speed: px per second at the near size; o: resting opacity
  const layers = [
    { works: order, size: 0.5, speed: 9, o: 0.3, stills: true },
    { works: order.filter((_, i) => i % 2), size: 0.72, speed: 16, o: 0.45 },
    { works: order.filter((_, i) => !(i % 2)), size: 1, speed: 26, o: 0.55 },
  ].map((L) => {
    const el = document.createElement("div");
    el.className = "pin-layer";
    el.style.setProperty("--o", L.o);
    host.appendChild(el);
    const pins = L.works.map(([slug, w, h, clip]) => {
      let p;
      if (clip && !L.stills) {
        p = document.createElement("video");
        p.muted = true; p.loop = true; p.playsInline = true;
        p.setAttribute("muted", ""); p.setAttribute("playsinline", "");
        p.preload = still ? "none" : "auto";
        p.autoplay = !still;
        p.poster = `media/work/${slug}.webp`;
        p.src = `media/work/${slug}.mp4`;
        // 23 clips load at once; if one is turned away (busy server, weak signal), try it once more.
        p.addEventListener("error", () => { if (!p.dataset.retried) { p.dataset.retried = 1; setTimeout(() => p.load(), 1500); } });
      } else {
        p = document.createElement("img");
        p.src = `media/work/${slug}.webp`;
        p.alt = "";
        p.decoding = "async";
      }
      p.className = "pin";
      el.appendChild(p);
      return { el: p, w, h, jx: rnd(), jy: rnd() };
    });
    return { ...L, el, pins, shift: rnd() * 1000, len: 1 };
  });

  // Each layer is a grid of cells (columns depend on its thumbnail size), one thumbnail per cell
  // at a random spot inside it. The layer's loop is at least a screen plus a thumbnail tall, so
  // a thumbnail always wraps around out of sight.
  let near = 1;
  function place() {
    const W = wall.clientWidth, H = wall.clientHeight;
    near = Math.min(230, Math.max(96, W * 0.13));
    layers.forEach((L) => {
      const long = near * L.size;
      const cols = Math.max(2, Math.round(W / (long * 1.9)));
      const rows = Math.ceil(L.pins.length / cols);
      L.len = Math.max(H + near, rows * long * 1.25);
      const cw = W / cols, rh = L.len / rows;
      L.pins.forEach((p, i) => {
        const k = long / Math.max(p.w, p.h);
        p.pw = p.w * k; p.ph = p.h * k;
        p.x = (i % cols) * cw + p.jx * Math.max(0, cw - p.pw);
        p.y = Math.floor(i / cols) * rh + p.jy * Math.max(0, rh - p.ph);
        p.el.style.width = `${p.pw.toFixed(1)}px`;
        p.el.style.height = `${p.ph.toFixed(1)}px`;
      });
    });
    draw(0);
  }

  function draw(dt) {
    layers.forEach((L) => {
      L.shift = (L.shift + L.speed * (near / 200) * dt) % L.len;
      L.pins.forEach((p) => {
        let y = p.y - L.shift;
        if (y < -p.ph) y += L.len;
        // `translate`, not transform: the hover `scale` (style.css) then grows the thumbnail
        // around its own centre. With transform it scaled the offset too and the thumbnail
        // jumped away from the mouse.
        p.el.style.translate = `${p.x.toFixed(1)}px ${y.toFixed(1)}px`;
      });
    });
  }

  // Drift only while the wall is on screen; the clips pause with it.
  let on = false, last = 0;
  function tick(t) {
    if (!on) return;
    draw(Math.min(0.05, (t - last) / 1000));
    last = t;
    requestAnimationFrame(tick);
  }
  new IntersectionObserver(([e]) => {
    on = e.isIntersecting && !still;
    layers.forEach((L) => L.pins.forEach((p) => {
      if (p.el.tagName !== "VIDEO" || still) return;
      if (e.isIntersecting) p.el.play().catch(() => {}); else p.el.pause();
    }));
    if (on) { last = performance.now(); requestAnimationFrame(tick); }
  }).observe(wall);

  place();
  addEventListener("resize", place);
})();
