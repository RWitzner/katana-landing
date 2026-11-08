// Katana's head as a GPU particle cloud.
//
// Every particle has a fixed home on the head, read from two images: face.png
// (how bright) and depth.png (how far forward). Each frame the GPU moves the
// particles home, lets them wander a little, and pushes them with a fluid
// simulation that the cursor stirs. Particles far from home glow red, so the
// head looks forged: it comes together hot and cools down to steel.
//
// Plain WebGL2, no libraries. Query parameters: ?n=128 sets the particle grid
// side (n*n particles, default 512), ?debug shows frame rate and renderer,
// ?v=hello is the version with the head centred in front of big pixel letters,
// ?bg=none leaves out the faint katakana background from glyphs.js.

const params = new URLSearchParams(location.search);
const IS_PHONE = matchMedia("(max-width: 760px) and (pointer: coarse)").matches;
const SIDE = Number(params.get("n")) || (IS_PHONE ? 128 : 512);
const HELLO = params.get("v") === "hello"; // the centred version with big letters
if (HELLO) document.documentElement.dataset.layout = "hello";
const COUNT = SIDE * SIDE;

const TUNING = {
  head: { size: 3.0, depth: 1.0, surfaceShare: 0.3 }, // world units; the image is size x size
  camera: { fov: (30 * Math.PI) / 180, z: 6 },
  stage: { maxWidth: 1800, maxHeight: 1000 }, // CSS px; past this the head stops growing and the layout stays together
  gaze: { yaw: 0.32, pitch: 0.2, follow: 0.05, drift: 0.06, farAttention: 0.12 },
  spring: 0.035, // share of the way home per frame: heals in about 1.5 s
  wander: 0.00022,
  flow: 0.00006, // how hard the fluid pushes particles
  maxPush: 0.009, // most a particle can move per frame, so a fast stroke cannot blow the head away
  fluid: {
    simSize: 256,
    dyeSize: 512,
    velocityKeep: 0.98,
    densityKeep: 0.97,
    pressureKeep: 0.95,
    pressureIterations: 5,
    curl: 30,
    dt: 1 / 60,
  },
};

const canvas = document.getElementById("head");
const gl = canvas.getContext("webgl2", {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  powerPreference: "high-performance",
});

if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
  document.documentElement.classList.add("no-gl");
  placeHead(window.innerWidth / window.innerHeight);
} else {
  start();
  if (!HELLO && params.get("bg") !== "none") import("./glyphs.js");
}

// ---------------------------------------------------------------- shaders

const HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
`;

const FULLSCREEN_VS = `${HEADER}
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const fragment = (body) => `${HEADER}
in vec2 vUv;
out vec4 o;
${body}`;

const SPLAT_FS = fragment(`
uniform sampler2D uBase;
uniform vec2 uA, uB;
uniform vec3 uColor;
uniform float uRadius, uAspect;
void main() {
  vec2 p = vUv, a = uA, b = uB;
  p.x *= uAspect; a.x *= uAspect; b.x *= uAspect;
  vec2 ab = b - a;
  float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float d = length(p - a - ab * h);
  o = vec4(texture(uBase, vUv).rgb + exp(-d * d / (uRadius * uRadius)) * uColor, 1.0);
}`);

const ADVECT_FS = fragment(`
uniform sampler2D uVelocity, uSource;
uniform vec2 uTexel;
uniform float uDt, uKeep;
void main() {
  vec2 from = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  o = uKeep * texture(uSource, from);
}`);

const CURL_FS = fragment(`
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  o = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
}`);

const VORTICITY_FS = fragment(`
uniform sampler2D uVelocity, uCurl;
uniform vec2 uTexel;
uniform float uStrength, uDt;
void main() {
  float l = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float c = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force /= length(force) + 1e-4;
  force *= uStrength * c;
  force.y *= -1.0;
  o = vec4(texture(uVelocity, vUv).xy + force * uDt, 0.0, 1.0);
}`);

const DIVERGENCE_FS = fragment(`
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  o = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}`);

const PRESSURE_FS = fragment(`
uniform sampler2D uPressure, uDivergence;
uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  o = vec4((l + r + t + b - texture(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`);

const GRADIENT_FS = fragment(`
uniform sampler2D uVelocity, uPressure;
uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  o = vec4(texture(uVelocity, vUv).xy - vec2(r - l, t - b), 0.0, 1.0);
}`);

const SCALE_FS = fragment(`
uniform sampler2D uSource;
uniform float uKeep;
void main() { o = uKeep * texture(uSource, vUv); }`);

// One step of the particles. Positions live in the head's own space.
const PARTICLES_FS = fragment(`
uniform sampler2D uPosition, uHome, uRandom, uVelocity, uDensity;
uniform mat4 uHeadToClip;
uniform mat3 uScreenToHead;
uniform float uTime, uHz, uSpring, uWander, uFlow, uMaxPush;

// ABC flow: two octaves of a sine field that has no divergence, so particles
// swirl instead of bunching up.
vec3 swirl(vec3 p, float t) {
  vec3 a = p * 1.3 + t * 0.07;
  vec3 b = p.yzx * 2.9 - t * 0.05;
  return vec3(sin(a.z) + cos(a.y), sin(a.x) + cos(a.z), sin(a.y) + cos(a.x))
       + 0.5 * vec3(sin(b.z) + cos(b.y), sin(b.x) + cos(b.z), sin(b.y) + cos(b.x));
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec3 pos = texelFetch(uPosition, c, 0).xyz;
  vec4 home = texelFetch(uHome, c, 0);
  vec4 rnd = texelFetch(uRandom, c, 0);
  bool dust = home.w < 0.0; // embers around the head; they roam further

  float wander = uWander * (dust ? 9.0 : 1.0) * mix(0.6, 1.4, rnd.y);
  pos += swirl(pos, uTime + rnd.z * 4.0) * wander * uHz;

  // The opening: particles start out scattered and are released over 2.2 s, so
  // they keep arriving from the sides instead of contracting all at once.
  float release = smoothstep(0.0, 1.6, uTime - rnd.x * 2.2);
  pos += (home.xyz - pos) * uSpring * release * (dust ? 0.06 : 1.0) * uHz;

  vec4 clip = uHeadToClip * vec4(pos, 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  vec2 flow = texture(uVelocity, uv).xy;
  // A hard edge on the mask: only particles right where the cursor went get pushed.
  float density = smoothstep(0.3, 1.2, texture(uDensity, uv).x);
  vec3 push = uScreenToHead * vec3(flow, 0.0) * uFlow * mix(0.5, 1.5, rnd.w) * density;
  float pushed = length(push);
  if (pushed > uMaxPush) push *= uMaxPush / pushed;
  pos += push * uHz;

  o = vec4(pos, 1.0);
}`);

const POINTS_VS = `${HEADER}
uniform sampler2D uPosition, uHome, uRandom;
uniform mat4 uHeadToClip;
uniform float uSide, uDotSize, uTime;
out vec4 vColor;
void main() {
  int side = int(uSide);
  ivec2 c = ivec2(gl_VertexID % side, gl_VertexID / side);
  vec3 pos = texelFetch(uPosition, c, 0).xyz;
  vec4 home = texelFetch(uHome, c, 0);
  vec4 rnd = texelFetch(uRandom, c, 0);

  vec4 clip = uHeadToClip * vec4(pos, 1.0);
  gl_Position = clip;

  float brightness = abs(home.w);
  // Halftone: bright spots get big dots, dark spots tiny ones.
  gl_PointSize = max(1.0, uDotSize * mix(0.4, 1.3, brightness) * mix(0.9, 1.1, rnd.y) / clip.w);

  // Away from home means hot.
  float away = distance(pos, home.xyz);
  float opening = 1.0 - smoothstep(4.0, 5.5, uTime);
  // Away from home means hot. In the opening, particles bound for the bright
  // parts of the face turn white further out than that, and about one in eight
  // of them is white all the way from the edge of the window.
  float heat = smoothstep(0.03, 0.3, away);
  float brightBound = smoothstep(0.25, 0.6, brightness);
  float spark = step(0.88, rnd.w);
  heat = mix(heat, smoothstep(0.1, 0.65, away) * (1.0 - spark), opening * brightBound);
  // Shadows glow dark red, the same red as the app; highlights are steel white.
  vec3 steel = mix(vec3(0.65, 0.145, 0.125), vec3(1.0, 0.99, 0.98), smoothstep(0.0, 0.5, brightness));
  vec3 hot = vec3(0.93, 0.19, 0.15);

  // A few dots catch the light.
  float glint = pow(rnd.z, 40.0) * (0.5 + 0.5 * sin(uTime * 3.0 + rnd.y * 40.0));

  float alpha = mix(0.22, 1.0, brightness) + glint * 0.6;
  alpha *= smoothstep(0.0, 1.4, uTime);
  // In the opening, particles are fainter until they are nearly home, so the
  // cloud never reads as a bright ball. The white sparks stay more visible.
  float faint = mix(0.2, 0.28, brightBound * spark);
  alpha *= mix(1.0, mix(1.0, faint, smoothstep(0.2, 1.1, away)), opening);
  vColor = vec4(mix(steel, hot, heat) * alpha, alpha);
}`;

const POINTS_FS = `${HEADER}
in vec4 vColor;
out vec4 o;
void main() { o = vColor; } // square dots, like the avatar in the app`;

// ---------------------------------------------------------------- GL helpers

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function makeProgram(fs, vs = FULLSCREEN_VS) {
  const id = gl.createProgram();
  gl.attachShader(id, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(id, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(id);
  if (!gl.getProgramParameter(id, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(id));
  }
  const uniforms = {};
  const total = gl.getProgramParameter(id, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < total; i++) {
    const { name } = gl.getActiveUniform(id, i);
    uniforms[name] = gl.getUniformLocation(id, name);
  }
  return { id, uniforms };
}

function setUniforms(program, values) {
  gl.useProgram(program.id);
  let unit = 0;
  for (const [name, value] of Object.entries(values)) {
    const location = program.uniforms[name];
    if (location == null) continue;
    if (value instanceof WebGLTexture) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, value);
      gl.uniform1i(location, unit++);
    } else if (typeof value === "number") {
      gl.uniform1f(location, value);
    } else if (value.length === 2) {
      gl.uniform2fv(location, value);
    } else if (value.length === 3) {
      gl.uniform3fv(location, value);
    } else if (value.length === 9) {
      gl.uniformMatrix3fv(location, false, value);
    } else if (value.length === 16) {
      gl.uniformMatrix4fv(location, false, value);
    }
  }
}

function makeTexture(width, height, format, data = null) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, format.internal, width, height, 0, format.pixel, format.type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, format.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, format.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function makeTarget(width, height, format, data) {
  const texture = makeTexture(width, height, format, data);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, width, height);
  if (!data) {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  return { texture, framebuffer, width, height };
}

function makeSwap(width, height, format, data) {
  let read = makeTarget(width, height, format, data);
  let write = makeTarget(width, height, format, data);
  return {
    get read() { return read; },
    get write() { return write; },
    swap() { [read, write] = [write, read]; },
  };
}

function draw(program, target, values) {
  setUniforms(program, values);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, target.width, target.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---------------------------------------------------------------- matrices (column-major)

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

const normalize = ([x, y, z]) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function lookAt(eye, center) {
  const z = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  return {
    right: x,
    up: y,
    matrix: new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ]),
  };
}

function headMatrix(x, y, scale, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // translate * rotateY(yaw) * rotateX(pitch) * scale
  return new Float32Array([
    scale * cy, 0, scale * -sy, 0,
    scale * sy * sp, scale * cp, scale * cy * sp, 0,
    scale * sy * cp, scale * -sp, scale * cy * cp, 0,
    x, y, 0, 1,
  ]);
}

// ---------------------------------------------------------------- the head's shape

function loadPixels(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      resolve(ctx.getImageData(0, 0, image.width, image.height));
    };
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampler(image) {
  const { width: w, height: h, data } = image;
  return (x, y) => {
    const fx = Math.min(Math.max(x, 0), w - 1.001);
    const fy = Math.min(Math.max(y, 0), h - 1.001);
    const ix = fx | 0, iy = fy | 0;
    const dx = fx - ix, dy = fy - iy;
    const at = (px, py) => data[4 * (py * w + px)] / 255;
    return (
      (at(ix, iy) * (1 - dx) + at(ix + 1, iy) * dx) * (1 - dy) +
      (at(ix, iy + 1) * (1 - dx) + at(ix + 1, iy + 1) * dx) * dy
    );
  };
}

// Spreads the portrait's greys so hair and eyes stay dark against the skin.
function contrast(value) {
  const t = Math.min(Math.max((value - 0.2) / 0.72, 0), 1);
  return t * t * (3 - 2 * t);
}

// Places dots on a regular grid over the portrait. Brighter spots get a dot more
// often, like a halftone. Returns the sites and the grid spacing that uses about
// the wanted number of dots.
function latticeSites(brightness, imageSize, wanted) {
  const walk = (spacing, collect) => {
    const random = seededRandom(7);
    let count = 0;
    for (let y = 0; y < imageSize; y += spacing) {
      for (let x = 0; x < imageSize; x += spacing) {
        const b = contrast(brightness(x, y));
        const dice = random();
        if (b > 0.02 && dice < 0.12 + b * 0.92) {
          count++;
          if (collect) collect.push(x, y, b);
        }
      }
    }
    return count;
  };
  let low = 0.4, high = 24;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    if (walk(mid) > wanted) low = mid;
    else high = mid;
  }
  const sites = [];
  walk(high, sites);
  return { sites, spacing: high };
}

function buildHome(faceImage, depthImage) {
  const { size, depth: depthScale } = TUNING.head;
  const imageSize = faceImage.width;
  const brightness = sampler(faceImage);
  const depth = sampler(depthImage);
  const random = seededRandom(11);
  const toWorld = size / imageSize;

  const { sites, spacing } = latticeSites(brightness, imageSize, COUNT * TUNING.head.surfaceShare);
  const siteCount = sites.length / 3;
  const dustCount = Math.floor(COUNT * 0.03);
  const home = new Float32Array(COUNT * 4);

  // Where in the texture each particle lives is shuffled, so neighbours on the
  // head do not move as one when the cloud comes together.
  const order = new Uint32Array(COUNT);
  for (let i = 0; i < COUNT; i++) order[i] = i;
  for (let i = COUNT - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const put = (index, x, y, z, w) => {
    const o = order[index] * 4;
    home[o] = x;
    home[o + 1] = y;
    home[o + 2] = z;
    home[o + 3] = w;
  };
  const place = (px, py, push, b, index) => {
    const d = depth(px, py);
    const jitter = spacing * toWorld * 0.1;
    put(
      index,
      (px / imageSize - 0.5) * size + (random() - 0.5) * jitter,
      (0.5 - py / imageSize) * size + (random() - 0.5) * jitter,
      (d - 0.5) * depthScale - push * d,
      b
    );
  };

  let index = 0;
  for (let i = 0; i < siteCount && index < COUNT; i++, index++) {
    place(sites[i * 3], sites[i * 3 + 1], 0, sites[i * 3 + 2], index);
  }
  // The rest fills the head behind the surface, dimly, so it has some body
  // when it turns.
  for (; index < COUNT - dustCount; index++) {
    const pick = Math.floor(random() * siteCount) * 3;
    place(sites[pick], sites[pick + 1], 0.05 + random() * 0.45, sites[pick + 2] * 0.12, index);
  }
  for (; index < COUNT; index++) {
    const angle = random() * Math.PI * 2;
    const reach = 0.8 + random() * 1.1;
    put(
      index,
      Math.cos(angle) * reach,
      Math.sin(angle) * reach,
      (random() - 0.5) * 1.4,
      -(0.08 + random() * 0.22)
    );
  }

  return { home, dotWorldSize: spacing * toWorld * 0.8 };
}

// Where the particles start: spread over the whole window and a bit past its
// edges, so the cloud has no outline before it comes together.
function scatteredPositions() {
  const random = seededRandom(23);
  const positions = new Float32Array(COUNT * 4);
  const aspect = innerWidth / innerHeight;
  const { x: headX, y: headY, scale } = placeHead(aspect);
  const halfHeight = TUNING.camera.z * Math.tan(viewFov() / 2) * 1.2;
  const halfWidth = halfHeight * aspect;
  for (let i = 0; i < COUNT; i++) {
    positions[i * 4] = ((random() * 2 - 1) * halfWidth - headX) / scale;
    positions[i * 4 + 1] = ((random() * 2 - 1) * halfHeight - headY) / scale;
    positions[i * 4 + 2] = (random() * 2 - 1) * 1.5;
    positions[i * 4 + 3] = 1;
  }
  return positions;
}

function randomValues() {
  const random = seededRandom(31);
  const values = new Float32Array(COUNT * 4);
  for (let i = 0; i < values.length; i++) values[i] = random();
  return values;
}

// ---------------------------------------------------------------- pixel letters

// Rectangles [x, y, width, height] on a grid 14 wide and 20 tall, with strokes
// 2 cells thick. Drawn here so the page does not have to load a font.
const steps = (count, rect) => Array.from({ length: count }, (_, i) => rect(i));
const PIXEL_GLYPHS = {
  H: [[0, 0, 2, 20], [12, 0, 2, 20], [2, 9, 10, 2]],
  E: [[0, 0, 2, 20], [2, 0, 12, 2], [2, 9, 10, 2], [2, 18, 12, 2]],
  L: [[0, 0, 2, 20], [2, 18, 11, 2]],
  O: [[3, 0, 8, 2], [3, 18, 8, 2], [0, 3, 2, 14], [12, 3, 2, 14], [1, 1, 2, 2], [11, 1, 2, 2], [1, 17, 2, 2], [11, 17, 2, 2]],
  I: [[0, 0, 2, 20]],
  "'": [[0, 0, 2, 6]],
  M: [
    [0, 0, 2, 20], [12, 0, 2, 20],
    ...steps(5, (i) => [2 + i, 2 + 2 * i, 1, 4]),
    ...steps(5, (i) => [11 - i, 2 + 2 * i, 1, 4]),
  ],
  K: [
    [0, 0, 2, 20],
    ...steps(6, (i) => [2 + 2 * i, Math.round(8 - 1.6 * i), 2, 3]),
    ...steps(5, (i) => [4 + 2 * i, 9 + Math.round(1.6 * (i + 1)), 2, 3]),
  ],
  A: [[3, 0, 8, 2], [1, 1, 2, 2], [11, 1, 2, 2], [0, 3, 2, 17], [12, 3, 2, 17], [2, 11, 10, 2]],
  T: [[0, 0, 14, 2], [6, 2, 2, 18]],
  N: [[0, 0, 2, 20], [12, 0, 2, 20], ...steps(10, (i) => [2 + i, 1 + Math.round(i * 1.75), 1, 3])],
};
const GLYPH_WIDTH = (letter) => (letter === "I" || letter === "'" ? 2 : 14);
const LETTER_GAP = 4;
const WORD_GAP = 10;
const LINE_HEIGHT = 20;
const LINE_GAP = 6;

function drawHello(lines) {
  const svg = document.getElementById("hello");
  const lineWidth = (line) =>
    [...line].reduce((sum, c, i) => sum + (c === " " ? WORD_GAP : GLYPH_WIDTH(c) + (i ? LETTER_GAP : 0)), 0);
  const width = Math.max(...lines.map(lineWidth));
  const height = lines.length * LINE_HEIGHT + (lines.length - 1) * LINE_GAP;
  let path = "";
  lines.forEach((line, row) => {
    let x = (width - lineWidth(line)) / 2;
    const y = row * (LINE_HEIGHT + LINE_GAP);
    [...line].forEach((c, i) => {
      if (c === " ") {
        x += WORD_GAP;
        return;
      }
      if (i) x += LETTER_GAP;
      for (const [rx, ry, rw, rh] of PIXEL_GLYPHS[c]) {
        path += `M${x + rx} ${y + ry}h${rw}v${rh}h${-rw}z`;
      }
      x += GLYPH_WIDTH(c);
    });
  });
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `<path d="${path}"/>`;
}

// ---------------------------------------------------------------- page layout

// How much smaller things are in the window than they would be without the
// height limit. 1 up to a laptop-sized window.
function stageShrink() {
  return Math.min(1, TUNING.stage.maxHeight / innerHeight);
}

// On tall windows the view widens instead of the head growing, so a big screen
// shows the laptop's head with more room around it.
function viewFov() {
  return 2 * Math.atan(Math.tan(TUNING.camera.fov / 2) / stageShrink());
}

// World-space placement of the head for this window shape, and the matching
// position of the red aura behind it.
function placeHead(aspect) {
  const halfHeight = TUNING.camera.z * Math.tan(viewFov() / 2);
  const halfWidth = halfHeight * aspect;
  const wide = aspect > 1 && window.innerWidth > 760;
  const narrowScale = Math.min(1, (aspect * halfHeight * 1.9) / TUNING.head.size);
  let scale = wide ? 1 : narrowScale;
  let x = wide ? halfWidth * 0.36 * Math.min(1, TUNING.stage.maxWidth / innerWidth) : 0;
  let y = wide ? -0.02 : halfHeight * 0.28;
  if (HELLO) {
    // Low enough that only the top of the head covers the letters.
    scale = wide ? 0.96 : narrowScale;
    x = 0;
    y = wide ? -halfHeight * 0.12 : halfHeight * 0.02;
    drawHello(wide ? ["HELLO I'M KATANA"] : ["HELLO I'M", "KATANA"]);
  }
  const style = document.documentElement.style;
  style.setProperty("--hx", `${50 + (x / halfWidth) * 50}%`);
  style.setProperty("--hy", `${50 - (y / halfHeight) * 50}%`);
  style.setProperty("--hsize", `${((TUNING.head.size * scale * 1.25) / (2 * halfHeight)) * window.innerHeight}px`);
  return { x, y, scale };
}

// ---------------------------------------------------------------- start

async function start() {
  gl.bindVertexArray(gl.createVertexArray()); // all geometry comes from gl_VertexID
  gl.disable(gl.DEPTH_TEST);

  const [faceImage, depthImage] = await Promise.all([
    loadPixels("assets/face.png"),
    loadPixels("assets/depth.png"),
  ]);
  const buildStart = performance.now();
  const { home, dotWorldSize } = buildHome(faceImage, depthImage);
  const buildMs = performance.now() - buildStart;

  const FLOAT32 = { internal: gl.RGBA32F, pixel: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST };
  const FLUID_RG = { internal: gl.RG16F, pixel: gl.RG, type: gl.HALF_FLOAT, filter: gl.LINEAR };
  const FLUID_R = { internal: gl.R16F, pixel: gl.RED, type: gl.HALF_FLOAT, filter: gl.LINEAR };
  const FLUID_NEAREST = { ...FLUID_R, filter: gl.NEAREST };

  const particles = makeSwap(SIDE, SIDE, FLOAT32, scatteredPositions());
  const homeTexture = makeTexture(SIDE, SIDE, FLOAT32, home);
  const randomTexture = makeTexture(SIDE, SIDE, FLOAT32, randomValues());

  const { simSize, dyeSize } = TUNING.fluid;
  const velocity = makeSwap(simSize, simSize, FLUID_RG);
  const density = makeSwap(dyeSize, dyeSize, FLUID_R);
  const pressure = makeSwap(simSize, simSize, FLUID_NEAREST);
  const curlTarget = makeTarget(simSize, simSize, FLUID_NEAREST);
  const divergenceTarget = makeTarget(simSize, simSize, FLUID_NEAREST);

  const programs = {
    splat: makeProgram(SPLAT_FS),
    advect: makeProgram(ADVECT_FS),
    curl: makeProgram(CURL_FS),
    vorticity: makeProgram(VORTICITY_FS),
    divergence: makeProgram(DIVERGENCE_FS),
    pressure: makeProgram(PRESSURE_FS),
    gradient: makeProgram(GRADIENT_FS),
    scale: makeProgram(SCALE_FS),
    particles: makeProgram(PARTICLES_FS),
    points: makeProgram(POINTS_FS, POINTS_VS),
  };

  // ------------------------------------------------------ input

  const pointer = { x: innerWidth / 2, y: innerHeight / 2, lastX: null, lastY: null, seen: false, lastSplat: 0 };
  window.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.seen = true;
  }, { passive: true });

  let placement;
  let dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    placement = placeHead(innerWidth / innerHeight);
  }
  window.addEventListener("resize", resize);
  resize();

  // ------------------------------------------------------ fluid

  const remap = (value, inHigh, outHigh) => Math.min(value / inHigh, 1) * outHigh;

  function stirFluid(now) {
    if (pointer.lastX === null) {
      pointer.lastX = pointer.x;
      pointer.lastY = pointer.y;
      return;
    }
    const dx = pointer.x - pointer.lastX;
    const dy = pointer.y - pointer.lastY;
    const moved = Math.hypot(dx, dy);
    if (moved > 0.01) {
      const radius = remap(moved, 5, 60) * (IS_PHONE ? 0.34 : 0.42);
      const force = remap(moved, 15, 10);
      // After a pause, start the stroke at the cursor instead of drawing a line
      // from where it last was.
      const start = now - pointer.lastSplat > 50 ? pointer : { x: pointer.lastX, y: pointer.lastY };
      const a = [start.x / innerWidth, 1 - start.y / innerHeight];
      const b = [pointer.x / innerWidth, 1 - pointer.y / innerHeight];
      const shared = { uA: a, uB: b, uRadius: (Math.max(radius, 1) / 200) * stageShrink(), uAspect: innerWidth / innerHeight };
      draw(programs.splat, velocity.write, { ...shared, uBase: velocity.read.texture, uColor: [dx * force, -dy * force, 0] });
      velocity.swap();
      // The mask is narrower than the push, so only particles close to the cursor move.
      draw(programs.splat, density.write, { ...shared, uRadius: shared.uRadius * 0.7, uBase: density.read.texture, uColor: [1, 1, 1] });
      density.swap();
      pointer.lastSplat = now;
    }
    pointer.lastX = pointer.x;
    pointer.lastY = pointer.y;
  }

  function stepFluid() {
    const f = TUNING.fluid;
    const texel = [1 / simSize, 1 / simSize];
    draw(programs.curl, curlTarget, { uVelocity: velocity.read.texture, uTexel: texel });
    draw(programs.vorticity, velocity.write, {
      uVelocity: velocity.read.texture,
      uCurl: curlTarget.texture,
      uTexel: texel,
      uStrength: f.curl,
      uDt: f.dt,
    });
    velocity.swap();
    draw(programs.divergence, divergenceTarget, { uVelocity: velocity.read.texture, uTexel: texel });
    draw(programs.scale, pressure.write, { uSource: pressure.read.texture, uKeep: f.pressureKeep });
    pressure.swap();
    for (let i = 0; i < f.pressureIterations; i++) {
      draw(programs.pressure, pressure.write, {
        uPressure: pressure.read.texture,
        uDivergence: divergenceTarget.texture,
        uTexel: texel,
      });
      pressure.swap();
    }
    draw(programs.gradient, velocity.write, {
      uVelocity: velocity.read.texture,
      uPressure: pressure.read.texture,
      uTexel: texel,
    });
    velocity.swap();
    draw(programs.advect, velocity.write, {
      uVelocity: velocity.read.texture,
      uSource: velocity.read.texture,
      uTexel: texel,
      uDt: f.dt,
      uKeep: f.velocityKeep,
    });
    velocity.swap();
    draw(programs.advect, density.write, {
      uVelocity: velocity.read.texture,
      uSource: density.read.texture,
      uTexel: texel,
      uDt: f.dt,
      uKeep: f.densityKeep,
    });
    density.swap();
  }

  // ------------------------------------------------------ frame

  const gaze = { yaw: 0, pitch: 0, camX: 0, camY: 0 };
  const stats = { fps: 0, frames: 0, windowStart: performance.now(), buildMs, firstFrameMs: null, framesTotal: 0 };
  const startTime = performance.now();
  let last = startTime;
  let fluidClock = 0;

  // Testing hook: skips ahead without waiting for the browser to draw, which it
  // does not do while the page is hidden.
  let skipped = 0;
  const clock = () => performance.now() + skipped;

  function loop() {
    requestAnimationFrame(loop);
    frame(clock());
  }

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const hz = Math.max(dt * 60, 0.25);
    const time = (now - startTime) / 1000;

    // The fluid's numbers are per 60 Hz step, so it runs on that clock whatever
    // the screen's refresh rate is. Otherwise a 120 Hz screen stirs half as hard.
    fluidClock = Math.min(fluidClock + dt, 3 * TUNING.fluid.dt);
    while (fluidClock >= TUNING.fluid.dt - 1e-4) {
      fluidClock -= TUNING.fluid.dt;
      stirFluid(now);
      stepFluid();
    }

    // Gaze: the head turns toward the cursor, measured from the head itself.
    const aspect = innerWidth / innerHeight;
    const { z } = TUNING.camera;
    const fov = viewFov();
    const halfHeight = z * Math.tan(fov / 2);
    const headX = (placement.x / (halfHeight * aspect)) * 0.5 + 0.5;
    const headY = 0.5 - (placement.y / halfHeight) * 0.5;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    // The head notices the cursor when it comes close. Far away it barely turns.
    const headRadius = ((TUNING.head.size * placement.scale) / (4 * halfHeight)) * innerHeight;
    const fromHeadX = (pointer.x - headX * innerWidth) / headRadius;
    const fromHeadY = (pointer.y - headY * innerHeight) / headRadius;
    const near = Math.max(0, Math.min(1, (0.95 - Math.hypot(fromHeadX, fromHeadY)) / 0.3));
    const nearness = near * near * (3 - 2 * near);
    const attention = TUNING.gaze.farAttention + (1 - TUNING.gaze.farAttention) * nearness;
    const toX = pointer.seen ? clamp(fromHeadX) * attention : 0;
    const toY = pointer.seen ? clamp(fromHeadY) * attention : 0;
    const idle = Math.sin(time * 0.35) * 0.05;
    const follow = 1 - Math.pow(1 - TUNING.gaze.follow, hz);
    gaze.yaw += (toX * TUNING.gaze.yaw + idle - gaze.yaw) * follow;
    gaze.pitch += (toY * TUNING.gaze.pitch - gaze.pitch) * follow;
    gaze.camX += (-toX * TUNING.gaze.drift - gaze.camX) * follow;
    gaze.camY += (toY * TUNING.gaze.drift - gaze.camY) * follow;

    const view = lookAt([gaze.camX, gaze.camY, z], [0, 0, 0]);
    const projection = perspective(fov, aspect, 0.1, 100);
    const head = headMatrix(placement.x, placement.y, placement.scale, gaze.yaw, gaze.pitch);
    const headToClip = multiply(projection, multiply(view.matrix, head));

    // Turns a push on screen into a push in the head's own space.
    const axis = (i) => [head[i * 4], head[i * 4 + 1], head[i * 4 + 2]];
    const s = placement.scale * placement.scale;
    const toHead = (v) => [dot(axis(0), v) / s, dot(axis(1), v) / s, dot(axis(2), v) / s];
    const screenToHead = new Float32Array([...toHead(view.right), ...toHead(view.up), 0, 0, 0]);

    draw(programs.particles, particles.write, {
      uPosition: particles.read.texture,
      uHome: homeTexture,
      uRandom: randomTexture,
      uVelocity: velocity.read.texture,
      uDensity: density.read.texture,
      uHeadToClip: headToClip,
      uScreenToHead: screenToHead,
      uTime: time,
      uHz: hz,
      uSpring: TUNING.spring,
      uWander: TUNING.wander,
      uFlow: TUNING.flow,
      uMaxPush: TUNING.maxPush,
    });
    particles.swap();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const pixelsPerWorldUnit = canvas.height / (2 * Math.tan(fov / 2));
    setUniforms(programs.points, {
      uPosition: particles.read.texture,
      uHome: homeTexture,
      uRandom: randomTexture,
      uHeadToClip: headToClip,
      uSide: SIDE,
      uDotSize: dotWorldSize * placement.scale * pixelsPerWorldUnit,
      uTime: time,
    });
    gl.drawArrays(gl.POINTS, 0, COUNT);
    gl.disable(gl.BLEND);

    stats.frames++;
    stats.framesTotal++;
    if (stats.firstFrameMs === null) stats.firstFrameMs = performance.now();
    if (now - stats.windowStart > 500) {
      stats.fps = (stats.frames * 1000) / (now - stats.windowStart);
      stats.frames = 0;
      stats.windowStart = now;
      if (statsLine) statsLine.textContent = `${COUNT.toLocaleString("en")} particles\n${stats.fps.toFixed(0)} fps\n${renderer}`;
    }
  }

  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown renderer";
  let statsLine = null;
  if (params.has("debug")) {
    statsLine = document.createElement("div");
    statsLine.id = "stats";
    document.body.append(statsLine);
  }
  window.katanaHead = {
    stats,
    renderer,
    count: COUNT,
    gaze,
    // Runs the given number of 60 fps frames right now, calling each(i) before
    // each one. Returns the real milliseconds one frame took, GPU included.
    advance(frames, each) {
      const began = performance.now();
      for (let i = 0; i < frames; i++) {
        skipped += 1000 / 60;
        if (each) each(i);
        frame(clock());
      }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return (performance.now() - began) / frames;
    },
  };

  requestAnimationFrame(loop);
}
