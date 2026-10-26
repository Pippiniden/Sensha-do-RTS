// 描画。車輌は画像が未指定なら▲で描く（仕様書 9章）。当たり判定は画像と無関係。
import { TERRAIN } from "./map.js";
import { makeRng } from "./util.js";
import { PLAYER } from "./game.js";
import { resolveAsset } from "./assets.js";

const imageCache = new Map();

/** 画像を読み込む。失敗・未指定なら null を返し、呼び出し側は▲で描く */
export function getImage(path) {
  if (!path) return null;
  const src = resolveAsset(path);
  let e = imageCache.get(src);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, failed: false };
    img.onload = () => (e.ok = true);
    img.onerror = () => (e.failed = true);
    img.src = src;
    imageCache.set(src, e);
  }
  return e.ok ? e.img : null;
}

export function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 車輌1輌を描く（ゲームとエディタのプレビューで共用）。ctx はワールド→画面の変換済みでなくてよい */
export function drawTankShape(ctx, { x, y, heading, turret, tank, scale, color, alpha = 1, dashed = false, wreck = false }) {
  const L = tank.size_m.length * scale;
  const W = tank.size_m.width * scale;
  const sp = tank.sprite || {};
  const off = ((sp.rotation_offset_deg || 0) * Math.PI) / 180;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.save();
  ctx.rotate(heading);
  const hullImg = getImage(wreck && sp.wreck ? sp.wreck : sp.hull);
  if (hullImg) {
    // 画像は上向き（前方が上）で描く前提。+x 前方に合わせて 90° 回す
    ctx.rotate(Math.PI / 2 + off);
    ctx.drawImage(hullImg, -W / 2, -L / 2, W, L);
  } else {
    ctx.beginPath();
    ctx.moveTo(L / 2, 0);
    ctx.lineTo(-L / 2, W / 2);
    ctx.lineTo(-L / 2, -W / 2);
    ctx.closePath();
    if (dashed) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = wreck ? "#6b6b6b" : color;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
  if (!dashed && !wreck) {
    ctx.save();
    ctx.rotate(turret);
    const turImg = getImage(sp.turret);
    if (turImg) {
      const [px, py] = sp.turret_pivot || [0.5, 0.5];
      ctx.rotate(Math.PI / 2 + off);
      const tw = W * 0.8;
      const th = (turImg.height / turImg.width) * tw;
      ctx.drawImage(turImg, -tw * px, -th * py, tw, th);
    } else {
      ctx.strokeStyle = "rgba(20,20,20,0.9)";
      ctx.lineWidth = Math.max(1.5, W * 0.12);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(L * 0.62, 0);
      ctx.stroke();
      if (tank.turret !== false && tank.gun?.arc_deg == null) {
        ctx.fillStyle = "rgba(20,20,20,0.35)";
        ctx.beginPath();
        ctx.arc(0, 0, W * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

export class Renderer {
  constructor(canvas, minimap, game, settings) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.minimap = minimap;
    this.mctx = minimap.getContext("2d");
    this.game = game;
    this.settings = settings;
    const m = game.map;
    this.cam = { x: m.widthM * 0.3, y: m.heightM / 2, zoom: 1.6 };
    this.buildTerrain();
    this.fog = document.createElement("canvas");
  }

  get unitScale() {
    return this.settings.unitScale || 2.2;
  }

  buildTerrain() {
    const m = this.game.map;
    const ppm = 2;
    const c = document.createElement("canvas");
    c.width = m.widthM * ppm;
    c.height = m.heightM * ppm;
    const g = c.getContext("2d");
    const rng = makeRng(99);
    const tp = m.tile * ppm;
    for (let r = 0; r < m.rows; r += 1) {
      for (let col = 0; col < m.cols; col += 1) {
        const t = TERRAIN[m.tileAt(col, r)];
        g.fillStyle = t.color;
        g.fillRect(col * tp, r * tp, tp + 0.5, tp + 0.5);
        // ざらつき
        g.fillStyle = `rgba(0,0,0,${rng() * 0.06})`;
        g.fillRect(col * tp, r * tp, tp, tp);
        if (t.id === "bush" || t.id === "forest") {
          g.fillStyle = t.id === "forest" ? "rgba(30,55,25,0.55)" : "rgba(60,90,40,0.6)";
          for (let k = 0; k < (t.id === "forest" ? 4 : 3); k += 1) {
            g.beginPath();
            g.arc(col * tp + rng() * tp, r * tp + rng() * tp, tp * (0.18 + rng() * 0.18), 0, Math.PI * 2);
            g.fill();
          }
        }
        if (t.id === "building") {
          g.strokeStyle = "rgba(0,0,0,0.35)";
          g.strokeRect(col * tp + 0.5, r * tp + 0.5, tp - 1, tp - 1);
        }
        if (t.id === "cover") {
          g.fillStyle = "rgba(255,240,200,0.18)";
          g.fillRect(col * tp, r * tp, tp, tp * 0.3);
        }
      }
    }
    this.terrain = c;
    this.terrainPpm = ppm;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  toScreen(x, y) {
    return [(x - this.cam.x) * this.cam.zoom + this.w / 2, (y - this.cam.y) * this.cam.zoom + this.h / 2];
  }

  toWorld(sx, sy) {
    return [(sx - this.w / 2) / this.cam.zoom + this.cam.x, (sy - this.h / 2) / this.cam.zoom + this.cam.y];
  }

  clampCam() {
    const m = this.game.map;
    this.cam.zoom = Math.max(0.4, Math.min(6, this.cam.zoom));
    // 画面がマップより小さければ、マップの外が見えすぎないようにする（端は少しだけ余白）
    const hw = (this.w || 800) / 2 / this.cam.zoom;
    const hh = (this.h || 600) / 2 / this.cam.zoom;
    const pad = 40;
    const cx = (lo, hi, v) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
    this.cam.x = cx(hw - pad, m.widthM - hw + pad, this.cam.x);
    this.cam.y = cx(hh - pad, m.heightM - hh + pad, this.cam.y);
  }

  /** 画面座標で、その位置にいる車輌 */
  unitAt(sx, sy, filter = () => true) {
    const [wx, wy] = this.toWorld(sx, sy);
    let best = null;
    let bd = Infinity;
    for (const u of this.game.units) {
      if (!filter(u)) continue;
      const r = Math.max(u.halfL, 4) * this.unitScale * 0.8 + 4 / this.cam.zoom;
      const d = Math.hypot(u.x - wx, u.y - wy);
      if (d < r && d < bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  }

  draw(ui) {
    this.resize();
    const { ctx, game } = this;
    const z = this.cam.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#1b1f1a";
    ctx.fillRect(0, 0, this.w, this.h);
    // 地形
    const [ox, oy] = this.toScreen(0, 0);
    ctx.imageSmoothingEnabled = z < this.terrainPpm;
    ctx.drawImage(this.terrain, ox, oy, game.map.widthM * z, game.map.heightM * z);
    this.drawFog();
    // ワールド座標で描く
    ctx.save();
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(z, z);
    ctx.translate(-this.cam.x, -this.cam.y);
    const sel = ui.selected;
    this.drawSelectionOverlays(sel);
    this.drawUnits(sel);
    this.drawFx();
    ctx.restore();
    this.drawScreenOverlays(ui);
    this.drawMinimap();
  }

  drawFog() {
    const { game } = this;
    const f = this.fog;
    if (f.width !== this.canvas.width || f.height !== this.canvas.height) {
      f.width = this.canvas.width;
      f.height = this.canvas.height;
    }
    const g = f.getContext("2d");
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, this.w, this.h);
    g.fillStyle = game.result ? "rgba(10,14,18,0)" : "rgba(10,14,18,0.42)";
    g.fillRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = "destination-out";
    const maxSpot = game.map.def.max_spot_m || 400;
    for (const u of game.units) {
      if (!u.alive || u.team !== PLAYER) continue;
      const [sx, sy] = this.toScreen(u.x, u.y);
      const r = Math.min(u.stats.view_range, maxSpot) * this.cam.zoom;
      const grad = g.createRadialGradient(sx, sy, r * 0.85, sx, sy, r);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(sx, sy, r, 0, Math.PI * 2);
      g.fill();
    }
    this.ctx.drawImage(f, 0, 0, this.w, this.h);
  }

  teamColor(team) {
    return this.game.scenario.teams[team]?.color || (team === PLAYER ? "#3d7bd9" : "#c0392b");
  }

  drawSelectionOverlays(sel) {
    const { ctx, game } = this;
    const z = this.cam.zoom;
    const maxSpot = game.map.def.max_spot_m || 400;
    for (const u of sel) {
      if (!u.alive) continue;
      // 視認範囲
      ctx.setLineDash([6 / z, 6 / z]);
      ctx.strokeStyle = "rgba(160,220,255,0.45)";
      ctx.lineWidth = 1 / z;
      ctx.beginPath();
      ctx.arc(u.x, u.y, Math.min(u.stats.view_range, maxSpot), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // 経路と最終の向き
      if (u.path.length) {
        ctx.strokeStyle = u.reverse ? "rgba(255,200,120,0.8)" : "rgba(140,255,160,0.75)";
        ctx.lineWidth = 1.5 / z;
        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        for (const [px, py] of u.path) ctx.lineTo(px, py);
        ctx.stroke();
      }
      const end = u.goal || (u.facing !== null ? [u.x, u.y] : null);
      if (end && u.facing !== null && u.facingLock) {
        this.arrow(end[0], end[1], u.facing, 22, "rgba(140,255,160,0.95)");
      }
      // 目標と照準円
      if (u.target && u.target.alive) {
        ctx.strokeStyle = "rgba(255,120,100,0.5)";
        ctx.lineWidth = 1 / z;
        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        ctx.lineTo(u.target.x, u.target.y);
        ctx.stroke();
        const d = Math.hypot(u.target.x - u.x, u.target.y - u.y);
        const r = u.aimRadius(d, u.knownBySelf.has(u.target.id));
        ctx.strokeStyle = u.disp < 1.2 ? "rgba(120,255,140,0.9)" : "rgba(255,230,120,0.9)";
        ctx.lineWidth = 1.5 / z;
        ctx.beginPath();
        ctx.arc(u.target.x, u.target.y, Math.max(r, 1.5), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  arrow(x, y, a, len, color) {
    const { ctx } = this;
    const z = this.cam.zoom;
    const L = len / z;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2 / z;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * (L + 6 / z), y + Math.sin(a) * (L + 6 / z));
    ctx.lineTo(x + Math.cos(a + 2.5) * 6 / z + Math.cos(a) * L, y + Math.sin(a + 2.5) * 6 / z + Math.sin(a) * L);
    ctx.lineTo(x + Math.cos(a - 2.5) * 6 / z + Math.cos(a) * L, y + Math.sin(a - 2.5) * 6 / z + Math.sin(a) * L);
    ctx.fill();
  }

  drawUnits(sel) {
    const { ctx, game } = this;
    const z = this.cam.zoom;
    const s = this.unitScale;
    for (const u of game.units) {
      let disp = "visible";
      if (u.team !== PLAYER) disp = game.enemyDisplay(u);
      if (!disp) continue;
      const color = this.teamColor(u.team);
      if (disp === "ghost") {
        const g = game.playerSeen.get(u.id);
        drawTankShape(ctx, { x: g.x, y: g.y, heading: g.heading, turret: g.turret, tank: u.tank, scale: s, color, dashed: true, alpha: 0.7 });
        continue;
      }
      drawTankShape(ctx, { x: u.x, y: u.y, heading: u.heading, turret: u.turret, tank: u.tank, scale: s, color, wreck: !u.alive, alpha: disp === "linger" ? 0.55 : 1 });
      const R = u.halfL * s;
      ctx.font = `${11 / z}px sans-serif`;
      ctx.textAlign = "center";
      if (!u.alive) {
        // 白旗
        ctx.strokeStyle = "#222";
        ctx.lineWidth = 1 / z;
        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        ctx.lineTo(u.x, u.y - R - 10 / z);
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.fillRect(u.x, u.y - R - 10 / z, 9 / z, 6 / z);
        continue;
      }
      if (sel.includes(u)) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5 / z;
        ctx.beginPath();
        ctx.arc(u.x, u.y, R + 3 / z, 0, Math.PI * 2);
        ctx.stroke();
      }
      // HPバー
      const bw = 26 / z;
      const by = u.y + R + 5 / z;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(u.x - bw / 2, by, bw, 3.5 / z);
      ctx.fillStyle = u.team === PLAYER ? "#7fe08a" : "#ff8a7a";
      ctx.fillRect(u.x - bw / 2, by, (bw * Math.max(0, u.hp)) / u.maxHp, 3.5 / z);
      // アイコン列
      const icons = [];
      if (u.isLeader) icons.push("★");
      if (u.isFlag) icons.push("⚑");
      if (u.team === PLAYER) icons.push(String(u.squadId));
      if (u.modules.tracks === "destroyed") icons.push("履");
      if (Object.keys(u.stunned).length) icons.push("気");
      if (u.team === PLAYER && u.sixthSenseShown && u.spottedSince !== null) icons.push("👁");
      if (u.team === PLAYER && (u.orderPendingUntil || 0) > game.time) icons.push("…");
      if (u.team === PLAYER) {
        const leader = game.leader(PLAYER);
        if (leader && u.component !== leader.component) icons.push("✕通信");
      }
      if (icons.length) {
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = 2.5 / z;
        const text = icons.join(" ");
        ctx.strokeText(text, u.x, u.y - R - 5 / z);
        ctx.fillText(text, u.x, u.y - R - 5 / z);
      }
    }
  }

  drawFx() {
    const { ctx, game } = this;
    const z = this.cam.zoom;
    for (const f of game.fx) {
      const k = (game.time - f.t0) / f.dur;
      if (f.kind === "tracer") {
        if (!this.visibleWorld(f.x1, f.y1)) continue;
        ctx.strokeStyle = `rgba(255,230,160,${1 - k})`;
        ctx.lineWidth = 1.6 / z;
        ctx.beginPath();
        ctx.moveTo(f.x0, f.y0);
        ctx.lineTo(f.x1, f.y1);
        ctx.stroke();
      } else if (f.kind === "flash") {
        ctx.fillStyle = `rgba(255,220,120,${1 - k})`;
        ctx.beginPath();
        ctx.arc(f.x, f.y, (3 + 4 * k) / Math.min(z, 2), 0, Math.PI * 2);
        ctx.fill();
      } else if (f.kind === "spark") {
        ctx.strokeStyle = `rgba(160,220,255,${1 - k})`;
        ctx.lineWidth = 1.5 / z;
        for (let i = 0; i < 5; i += 1) {
          const a = i * 1.26 + f.t0;
          ctx.beginPath();
          ctx.moveTo(f.x, f.y);
          ctx.lineTo(f.x + Math.cos(a) * (2 + 8 * k), f.y + Math.sin(a) * (2 + 8 * k));
          ctx.stroke();
        }
      } else if (f.kind === "dust") {
        ctx.fillStyle = `rgba(200,180,140,${0.6 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 2 + 5 * k, 0, Math.PI * 2);
        ctx.fill();
      } else if (f.kind === "boom") {
        ctx.fillStyle = `rgba(255,150,60,${0.7 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 4 + 14 * k, 0, Math.PI * 2);
        ctx.fill();
      } else if (f.kind === "popup") {
        if (!this.visibleWorld(f.x, f.y)) continue;
        ctx.font = `bold ${13 / z}px sans-serif`;
        ctx.textAlign = "center";
        ctx.lineWidth = 3 / z;
        ctx.strokeStyle = `rgba(0,0,0,${1 - k})`;
        ctx.fillStyle = f.color;
        ctx.globalAlpha = 1 - k * k;
        const yy = f.y - (10 + 24 * k) / z;
        ctx.strokeText(f.text, f.x, yy);
        ctx.fillText(f.text, f.x, yy);
        ctx.globalAlpha = 1;
      }
    }
  }

  /** プレイヤーが見ている範囲か（霧の中の演出は出さない） */
  visibleWorld(x, y) {
    const maxSpot = this.game.map.def.max_spot_m || 400;
    if (this.game.result) return true;
    return this.game.units.some((u) => u.alive && u.team === PLAYER && Math.hypot(u.x - x, u.y - y) <= Math.min(u.stats.view_range, maxSpot) + 30);
  }

  drawScreenOverlays(ui) {
    const { ctx } = this;
    if (ui.drag) {
      const d = ui.drag;
      if (d.button === 0 && d.moved) {
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        const x = Math.min(d.sx, d.cx);
        const y = Math.min(d.sy, d.cy);
        ctx.fillRect(x, y, Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy));
        ctx.strokeRect(x, y, Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy));
      }
      if (d.button === 2 && d.moved) {
        ctx.strokeStyle = ui.missionMode ? "rgba(255,210,120,0.95)" : "rgba(140,255,160,0.95)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(d.sx, d.sy);
        ctx.lineTo(d.cx, d.cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(d.sx, d.sy, 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (ui.missionMode) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(this.w / 2 - 210, 70, 420, 28);
      ctx.fillStyle = "#ffd27a";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`「${ui.missionMode.name}」の目標地点を右クリック（右ドラッグで敵の方向も指定）`, this.w / 2, 89);
    }
  }

  drawMinimap() {
    const { mctx: g, game } = this;
    const mw = this.minimap.width;
    const mh = this.minimap.height;
    const sx = mw / game.map.widthM;
    const sy = mh / game.map.heightM;
    g.drawImage(this.terrain, 0, 0, mw, mh);
    g.fillStyle = "rgba(10,14,18,0.25)";
    g.fillRect(0, 0, mw, mh);
    const leader = game.leader(PLAYER);
    if (leader) {
      g.strokeStyle = "rgba(160,220,255,0.5)";
      g.beginPath();
      g.arc(leader.x * sx, leader.y * sy, leader.stats.radio_range * sx, 0, Math.PI * 2);
      g.stroke();
    }
    for (const u of game.units) {
      let x = u.x;
      let y = u.y;
      let disp = "visible";
      if (u.team !== PLAYER) {
        disp = game.enemyDisplay(u);
        if (!disp) continue;
        if (disp === "ghost") {
          const s = game.playerSeen.get(u.id);
          x = s.x;
          y = s.y;
        }
      }
      g.fillStyle = !u.alive ? "#888" : this.teamColor(u.team);
      g.globalAlpha = disp === "ghost" ? 0.45 : 1;
      g.beginPath();
      g.arc(x * sx, y * sy, u.isFlag ? 4 : 3, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
    // カメラ範囲
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(this.w, this.h);
    g.strokeStyle = "rgba(255,255,255,0.8)";
    g.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
  }
}
