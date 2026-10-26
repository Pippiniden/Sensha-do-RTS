// 汎用ユーティリティ（角度はすべてラジアン。0 = +x方向、時計回りが正 ※canvas座標系）

export const DEG = Math.PI / 180;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 角度を -PI..PI に正規化 */
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** a から b への最短回転量 */
export function angleDiff(a, b) {
  return wrapAngle(b - a);
}

/** current を target へ最大 maxStep 回転させる */
export function rotateToward(current, target, maxStep) {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return wrapAngle(current + Math.sign(d) * maxStep);
}

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

export function angleTo(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

/** 再現可能な乱数（mulberry32） */
export function makeRng(seed) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (a, b) => a + (b - a) * rng();
  rng.int = (a, b) => Math.floor(rng.range(a, b + 1));
  rng.gauss = () => {
    // Box-Muller
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return rng;
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

let idCounter = 0;
export function uid(prefix = "u") {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}
