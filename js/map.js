// マップ：タイル（既定 1マス=10m）で地形を持つ。座標はすべてメートル。
import { makeRng, clamp } from "./util.js";

// 地形定義。仕様書 10.1 に対応
export const TERRAIN = [
  { id: "plain", name: "平地", color: "#c9c2a0", speed: 1.0, passable: true, blocksLos: false, camo: 0, cover: false },
  { id: "road", name: "道路", color: "#b3a58a", speed: 1.2, passable: true, blocksLos: false, camo: 0, cover: false },
  { id: "mud", name: "泥", color: "#8f7d5c", speed: 0.6, turn: 0.7, passable: true, blocksLos: false, camo: 0, cover: false },
  { id: "bush", name: "茂み", color: "#7e9a5a", speed: 1.0, passable: true, blocksLos: false, camo: 0.25, cover: false },
  { id: "forest", name: "森", color: "#4f6e3c", speed: 0.7, passable: true, blocksLos: false, camo: 0.5, cover: false },
  { id: "cover", name: "遮蔽地形", color: "#9c8a62", speed: 0.5, passable: true, blocksLos: false, camo: 0, cover: true },
  { id: "building", name: "建物", color: "#6d6a6a", speed: 0, passable: false, blocksLos: true, camo: 0, cover: false },
  { id: "rock", name: "岩", color: "#857f78", speed: 0, passable: false, blocksLos: true, camo: 0, cover: false },
  { id: "shallow", name: "浅瀬", color: "#8fb0c0", speed: 0.5, passable: true, blocksLos: false, camo: 0, cover: false },
  { id: "water", name: "深い水", color: "#5d88a3", speed: 0, passable: false, blocksLos: false, camo: 0, cover: false },
  { id: "bridge", name: "橋", color: "#a0896a", speed: 1.0, passable: true, blocksLos: false, camo: 0, cover: false },
];
export const T = Object.fromEntries(TERRAIN.map((t, i) => [t.id, i]));

export class GameMap {
  constructor(def) {
    this.def = def;
    this.tile = def.tile_m || 10;
    this.widthM = def.width_m;
    this.heightM = def.height_m;
    this.cols = Math.ceil(this.widthM / this.tile);
    this.rows = Math.ceil(this.heightM / this.tile);
    this.grid = new Uint8Array(this.cols * this.rows).fill(T[def.base || "plain"] ?? 0);
    this.build();
  }

  build() {
    const rng = makeRng(this.def.seed || 1);
    for (const f of this.def.features || []) {
      const tid = T[f.type];
      if (tid === undefined) continue;
      if (f.shape === "rect") this.paintRect(f.x, f.y, f.w, f.h, tid);
      else if (f.shape === "circle") this.paintCircle(f.x, f.y, f.r, tid);
      else if (f.shape === "line") this.paintLine(f.path, f.width || this.tile, tid);
      else if (f.shape === "scatter") {
        // 範囲内にランダムな小さな塊を散らす（茂みなど）
        for (let i = 0; i < (f.count || 10); i += 1) {
          const cx = f.x + rng() * f.w;
          const cy = f.y + rng() * f.h;
          this.paintCircle(cx, cy, (f.size || 12) * (0.6 + rng() * 0.8), tid);
        }
      }
    }
  }

  inBounds(c, r) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  set(c, r, tid) {
    if (this.inBounds(c, r)) this.grid[r * this.cols + c] = tid;
  }

  tileAt(c, r) {
    if (!this.inBounds(c, r)) return T.rock;
    return this.grid[r * this.cols + c];
  }

  terrainAtM(x, y) {
    return TERRAIN[this.tileAt(Math.floor(x / this.tile), Math.floor(y / this.tile))];
  }

  paintRect(x, y, w, h, tid) {
    const c0 = Math.floor(x / this.tile);
    const r0 = Math.floor(y / this.tile);
    const c1 = Math.ceil((x + w) / this.tile);
    const r1 = Math.ceil((y + h) / this.tile);
    for (let r = r0; r < r1; r += 1) for (let c = c0; c < c1; c += 1) this.set(c, r, tid);
  }

  paintCircle(x, y, rad, tid) {
    const c0 = Math.floor((x - rad) / this.tile);
    const r0 = Math.floor((y - rad) / this.tile);
    const c1 = Math.ceil((x + rad) / this.tile);
    const r1 = Math.ceil((y + rad) / this.tile);
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const cx = (c + 0.5) * this.tile;
        const cy = (r + 0.5) * this.tile;
        if ((cx - x) ** 2 + (cy - y) ** 2 <= rad * rad) this.set(c, r, tid);
      }
    }
  }

  paintLine(path, width, tid) {
    for (let i = 0; i < path.length - 1; i += 1) {
      const [ax, ay] = path[i];
      const [bx, by] = path[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len / (this.tile / 2)));
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        this.paintCircle(ax + (bx - ax) * t, ay + (by - ay) * t, width / 2, tid);
      }
    }
  }

  /** 線分上のタイルを順に訪問する。cb(terrain, x, y, distFromStart) が true を返したら打ち切り */
  walkLine(x0, y0, x1, y1, cb, step = 2.5) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / step));
    let lastC = -1;
    let lastR = -1;
    for (let i = 0; i <= n; i += 1) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const c = Math.floor(x / this.tile);
      const r = Math.floor(y / this.tile);
      if (c === lastC && r === lastR) continue;
      lastC = c;
      lastR = r;
      if (cb(TERRAIN[this.tileAt(c, r)], x, y, len * t)) return true;
    }
    return false;
  }

  /** 建物・岩が視線を遮るか */
  hasLos(x0, y0, x1, y1) {
    return !this.walkLine(x0, y0, x1, y1, (t) => t.blocksLos);
  }

  isPassableM(x, y) {
    return this.terrainAtM(x, y).passable;
  }

  /** 直線で通れるか（経路の平滑化用） */
  straightPassable(x0, y0, x1, y1) {
    return !this.walkLine(x0, y0, x1, y1, (t) => !t.passable, 3);
  }

  nearestPassable(x, y) {
    if (this.isPassableM(x, y)) return [x, y];
    for (let rad = this.tile; rad < 200; rad += this.tile) {
      for (let a = 0; a < 16; a += 1) {
        const px = x + Math.cos((a / 16) * Math.PI * 2) * rad;
        const py = y + Math.sin((a / 16) * Math.PI * 2) * rad;
        if (px > 0 && py > 0 && px < this.widthM && py < this.heightM && this.isPassableM(px, py)) return [px, py];
      }
    }
    return [x, y];
  }

  /** A* 経路探索（8方向）。地形の速度を移動コストに使う。戻り値はメートル座標の配列 */
  findPath(sx, sy, gx, gy) {
    [gx, gy] = this.nearestPassable(clamp(gx, 1, this.widthM - 1), clamp(gy, 1, this.heightM - 1));
    if (this.straightPassable(sx, sy, gx, gy) && Math.hypot(gx - sx, gy - sy) < 60) return [[gx, gy]];
    const cols = this.cols;
    const start = Math.floor(sy / this.tile) * cols + Math.floor(sx / this.tile);
    const goal = Math.floor(gy / this.tile) * cols + Math.floor(gx / this.tile);
    const g = new Float32Array(cols * this.rows).fill(Infinity);
    const came = new Int32Array(cols * this.rows).fill(-1);
    const closed = new Uint8Array(cols * this.rows);
    const open = new MinHeap();
    const gc = goal % cols;
    const gr = Math.floor(goal / cols);
    const h = (i) => {
      const dc = Math.abs((i % cols) - gc);
      const dr = Math.abs(Math.floor(i / cols) - gr);
      return (Math.max(dc, dr) + 0.414 * Math.min(dc, dr)) / 1.2;
    };
    g[start] = 0;
    open.push(start, h(start));
    let iter = 0;
    while (open.size && iter < 40000) {
      iter += 1;
      const cur = open.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % cols;
      const cr = Math.floor(cur / cols);
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (!dc && !dr) continue;
          const nc = cc + dc;
          const nr = cr + dr;
          if (!this.inBounds(nc, nr)) continue;
          const terr = TERRAIN[this.tileAt(nc, nr)];
          if (!terr.passable) continue;
          // 斜め移動で角をすり抜けない
          if (dc && dr && (!TERRAIN[this.tileAt(cc + dc, cr)].passable || !TERRAIN[this.tileAt(cc, cr + dr)].passable)) continue;
          const ni = nr * cols + nc;
          const step = (dc && dr ? 1.414 : 1) / terr.speed;
          const ng = g[cur] + step;
          if (ng < g[ni]) {
            g[ni] = ng;
            came[ni] = cur;
            open.push(ni, ng + h(ni));
          }
        }
      }
    }
    if (came[goal] === -1 && goal !== start) return [[gx, gy]];
    const cells = [];
    for (let i = goal; i !== -1 && i !== start; i = came[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => [((i % cols) + 0.5) * this.tile, (Math.floor(i / cols) + 0.5) * this.tile]);
    if (pts.length) pts[pts.length - 1] = [gx, gy];
    else pts.push([gx, gy]);
    return this.smooth(sx, sy, pts);
  }

  /** 見通せる点まで経由点を省く（ただし遅い地形をまたぐ場合は省かない） */
  smooth(sx, sy, pts) {
    const out = [];
    let ax = sx;
    let ay = sy;
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i) {
        const [bx, by] = pts[j];
        if (this.straightPassable(ax, ay, bx, by) && !this.walkLine(ax, ay, bx, by, (t) => t.speed < 0.9, 4)) break;
        j -= 1;
      }
      out.push(pts[j]);
      [ax, ay] = pts[j];
      i = j + 1;
    }
    return out;
  }
}

class MinHeap {
  constructor() {
    this.items = [];
    this.prio = [];
  }

  get size() {
    return this.items.length;
  }

  push(item, p) {
    const a = this.items;
    const pr = this.prio;
    a.push(item);
    pr.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pr[parent] <= pr[i]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      [pr[parent], pr[i]] = [pr[i], pr[parent]];
      i = parent;
    }
  }

  pop() {
    const a = this.items;
    const pr = this.prio;
    const top = a[0];
    const lastI = a.pop();
    const lastP = pr.pop();
    if (a.length) {
      a[0] = lastI;
      pr[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && pr[l] < pr[m]) m = l;
        if (r < a.length && pr[r] < pr[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [pr[m], pr[i]] = [pr[i], pr[m]];
        i = m;
      }
    }
    return top;
  }
}
