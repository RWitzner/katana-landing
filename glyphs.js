// The page's background: a grid of katakana in very faint white, with slow beams
// of light moving across it. It dims around the head and the text, so neither has
// to compete with it. /?bg=none leaves it out. Delete this file and the import in
// main.js to remove it.

const TUNING = {
  glyphs: "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン",
  font: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif',
  cell: 18, // CSS px per glyph
  fontSize: 12, // CSS px
  base: 0.022, // alpha of a glyph no beam is on
  beam: 0.07, // extra alpha in the middle of a beam
  nearHead: 0.15, // share of the alpha left behind the head
  nearText: 0.3, // share of the alpha left behind the text
  fps: 24, // the movement is slow, so this is plenty
  swapsPerTick: 6, // glyphs that change character each tick
};

const canvas = document.createElement("canvas");
canvas.id = "glyphs";
canvas.setAttribute("aria-hidden", "true");
canvas.style.animation = "aura-in 2s ease 2s both"; // arrives with the aura, after the head
document.body.prepend(canvas);
const ctx = canvas.getContext("2d");

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

let columns = 0, rows = 0, cellPx = 0, atlas = null;
let glyphOf, strength, columnShift, rowShift, mask;
let maskKey = "";

function buildAtlas() {
  const list = [...TUNING.glyphs];
  atlas = document.createElement("canvas");
  atlas.width = list.length * cellPx;
  atlas.height = cellPx;
  const a = atlas.getContext("2d");
  const dpr = cellPx / TUNING.cell;
  a.font = `400 ${TUNING.fontSize * dpr}px ${TUNING.font}`;
  a.textAlign = "center";
  a.textBaseline = "middle";
  a.fillStyle = "#fff";
  list.forEach((glyph, i) => a.fillText(glyph, (i + 0.5) * cellPx, cellPx / 2));
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  cellPx = Math.round(TUNING.cell * dpr);
  buildAtlas();
  columns = Math.ceil(canvas.width / cellPx);
  rows = Math.ceil(canvas.height / cellPx);
  const count = columns * rows;
  const kinds = [...TUNING.glyphs].length;
  glyphOf = new Uint8Array(count);
  strength = new Float32Array(count);
  mask = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    glyphOf[i] = Math.floor(Math.random() * kinds);
    strength[i] = 0.45 + Math.random() * 0.55;
  }
  columnShift = Float32Array.from({ length: columns }, () => Math.random());
  rowShift = Float32Array.from({ length: rows }, () => Math.random());
  maskKey = "";
}

// Dims the field behind the head and the text. Rebuilt when main.js moves the head.
function updateMask() {
  const style = getComputedStyle(document.documentElement);
  const hx = style.getPropertyValue("--hx"), hy = style.getPropertyValue("--hy"), size = style.getPropertyValue("--hsize");
  const key = `${hx}|${hy}|${size}|${columns}|${rows}`;
  if (key === maskKey) return;
  maskKey = key;
  const headX = (parseFloat(hx) / 100) * innerWidth;
  const headY = (parseFloat(hy) / 100) * innerHeight;
  const radius = parseFloat(size) / 1.25 / 2;
  const text = document.querySelector(".hero").getBoundingClientRect();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const x = (col + 0.5) * TUNING.cell, y = (row + 0.5) * TUNING.cell;
      const head = smooth(radius * 0.6, radius * 1.15, Math.hypot(x - headX, y - headY));
      const dx = Math.max(text.left - x, 0, x - text.right), dy = Math.max(text.top - y, 0, y - text.bottom);
      const nearText = smooth(0, 110, Math.hypot(dx, dy));
      mask[row * columns + col] =
        (TUNING.nearHead + (1 - TUNING.nearHead) * head) * (TUNING.nearText + (1 - TUNING.nearText) * nearText);
    }
  }
}

function draw(seconds) {
  updateMask();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const i = row * columns + col;
      const x = col * TUNING.cell, y = row * TUNING.cell;
      // Two bands of light at different angles, frayed a little per column and row.
      const one = 0.5 + 0.5 * Math.sin(x * 0.0042 + y * 0.0015 - seconds * 0.24 + columnShift[col] * 0.55);
      const two = 0.5 + 0.5 * Math.sin(-x * 0.002 + y * 0.0038 - seconds * 0.16 + rowShift[row] * 0.45);
      const beam = Math.max(one ** 7, 0.8 * two ** 10);
      ctx.globalAlpha = (TUNING.base + TUNING.beam * beam) * strength[i] * mask[i];
      ctx.drawImage(atlas, glyphOf[i] * cellPx, 0, cellPx, cellPx, col * cellPx, row * cellPx, cellPx, cellPx);
    }
  }
  ctx.globalAlpha = 1;
  const kinds = atlas.width / cellPx;
  for (let n = 0; n < TUNING.swapsPerTick; n++) {
    glyphOf[Math.floor(Math.random() * glyphOf.length)] = Math.floor(Math.random() * kinds);
  }
}

let last = -Infinity;
function tick(now) {
  requestAnimationFrame(tick);
  if (now - last < 1000 / TUNING.fps) return;
  last = now;
  draw(now / 1000);
}

window.addEventListener("resize", resize);
resize();
draw(0);
window.katanaGlyphs = { draw, canvas }; // for measuring
requestAnimationFrame(tick);
