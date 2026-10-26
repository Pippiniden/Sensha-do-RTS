// 分隊と「大まかな指示」（偵察・攻撃・防御・後退・追従）。
// 分隊に任務を与えると、各車の位置取り・向き・射撃許可を分隊AIが自動で決める。
import { DEG, angleTo, dist, wrapAngle } from "./util.js";

export const MISSIONS = {
  recon: { name: "偵察", key: "r", desc: "横隊で前進。敵を見つけたら停止して隠れ、近づかれるか撃たれるまで撃たない。被弾した車は下がる" },
  assault: { name: "攻撃", key: "t", desc: "楔形で前進し、射程に入った敵と交戦しながら目標地点へ。分隊で目標を揃えて集中射撃する" },
  defend: { name: "防御", key: "g", desc: "目標地点付近の茂み・遮蔽地形の陰に散開して待ち伏せ。敵が射程の8割に入るまで撃たない" },
  withdraw: { name: "後退", key: "b", desc: "敵に正面を向けたまま後進で目標地点まで下がる" },
  follow: { name: "追従", key: "f", desc: "指定した分隊の後ろに縦隊で付いていく" },
  manual: { name: "手動", key: "x", desc: "分隊AIを止め、各車への個別命令だけで動かす" },
};

export class Squad {
  constructor(id, team, name) {
    this.id = id;
    this.team = team;
    this.name = name || `第${id}分隊`;
    this.members = [];
    this.mission = { type: "manual" };
    this.contact = false;
    this.spots = null; // 防御位置
    this.lastTick = 0;
  }

  get alive() {
    return this.members.filter((u) => u.alive);
  }

  get lead() {
    const a = this.alive;
    return a.find((u) => u.isLeader) || a.find((u) => u.isSquadLead) || a[0] || null;
  }

  center() {
    const a = this.alive;
    if (!a.length) return null;
    return [a.reduce((s, u) => s + u.x, 0) / a.length, a.reduce((s, u) => s + u.y, 0) / a.length];
  }

  setMission(mission) {
    this.mission = { ...mission };
    this.spots = null;
    this.contact = false;
    for (const u of this.alive) {
      u.manual = mission.type === "manual" ? u.manual : false;
      u.focus = null;
      u.retreatUntil = 0;
    }
  }
}

/** 隊形の位置。center を中心、facing を前方として i 番目の車の位置を返す */
export function formationSlot(kind, i, n, cx, cy, facing, spacing) {
  const fx = Math.cos(facing);
  const fy = Math.sin(facing);
  const rx = -fy;
  const ry = fx;
  const k = i - (n - 1) / 2;
  let lat = 0;
  let back = 0;
  if (kind === "line") lat = k * spacing;
  else if (kind === "wedge") {
    lat = k * spacing;
    back = Math.abs(k) * spacing * 0.6;
  } else if (kind === "column") back = i * spacing;
  return [cx + rx * lat - fx * back, cy + ry * lat - fy * back];
}

/** 敵の方向（脅威軸）を推定する */
function threatBearing(game, squad, px, py) {
  if (squad.mission.facing != null) return squad.mission.facing;
  const known = game.knownEnemiesForTeamUnits(squad.alive);
  let best = null;
  let bd = Infinity;
  for (const e of known) {
    const d = dist(px, py, e.x, e.y);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  if (best) return angleTo(px, py, best.x, best.y);
  const [ex, ey] = game.enemySpawnCenter(squad.team);
  return angleTo(px, py, ex, ey);
}

/** 防御位置：茂みの15m後ろ、または遮蔽地形のすぐ後ろを探す */
function findDefensiveSpots(game, squad, px, py, facing, count) {
  const { map } = game;
  const fx = Math.cos(facing);
  const fy = Math.sin(facing);
  const cand = [];
  const R = 90;
  for (let y = py - R; y <= py + R; y += map.tile) {
    for (let x = px - R; x <= px + R; x += map.tile) {
      const tx = (Math.floor(x / map.tile) + 0.5) * map.tile;
      const ty = (Math.floor(y / map.tile) + 0.5) * map.tile;
      if (dist(tx, ty, px, py) > R) continue;
      const terr = map.terrainAtM(tx, ty);
      let pos = null;
      let score = 0;
      if (terr.camo > 0) {
        pos = [tx - fx * 18, ty - fy * 18];
        score = 2 + terr.camo * 2;
      } else if (terr.cover) {
        pos = [tx - fx * 7, ty - fy * 7];
        score = 3;
      }
      if (!pos || !map.isPassableM(pos[0], pos[1])) continue;
      const posTerr = map.terrainAtM(pos[0], pos[1]);
      if (posTerr.camo > 0 && !terr.cover) score -= 1; // 自分が茂みの中だと撃った時に効果を失う
      score -= dist(pos[0], pos[1], px, py) * 0.01;
      cand.push({ pos, score });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cand) {
    if (picked.length >= count) break;
    if (picked.every((p) => dist(p[0], p[1], c.pos[0], c.pos[1]) > 28)) picked.push(c.pos);
  }
  let i = 0;
  while (picked.length < count) {
    picked.push(formationSlot("line", i, count, px, py, facing, 35));
    i += 1;
  }
  return picked;
}

function sendTo(game, u, x, y, opts = {}) {
  if (u.manual || !u.canMove()) return;
  const [gx, gy] = game.map.nearestPassable(x, y);
  if (u.goal && dist(u.goal[0], u.goal[1], gx, gy) < 12) return;
  if (!u.goal && dist(u.x, u.y, gx, gy) < 10) {
    if (opts.facing != null && !u.target) u.facing = opts.facing;
    return;
  }
  u.moveTo(game.map, gx, gy, opts);
  u.facingLock = false;
}

/** 分隊AIの1回分（約0.5秒ごと） */
export function squadTick(game, squad, now) {
  const alive = squad.alive;
  if (!alive.length) return;
  const m = squad.mission;
  alive.forEach((u) => (u.isSquadLead = u === squad.lead));
  if (m.type === "manual") return;
  const auto = alive.filter((u) => !u.manual);
  const [cx, cy] = squad.center();
  const known = game.knownEnemiesForTeamUnits(alive);
  squad.contact = known.some((e) => dist(cx, cy, e.x, e.y) < 450);
  const bearing = threatBearing(game, squad, m.x ?? cx, m.y ?? cy);
  const n = auto.length;

  if (m.type === "recon") {
    auto.forEach((u, i) => {
      u.fireMode = "ambush";
      u.ambushRange = 150;
      if (now - u.lastHitTime < 3 && u.lastHitFrom && (u.retreatUntil || 0) < now) {
        // 撃たれたら射手から離れる方向へ下がる
        const away = angleTo(u.lastHitFrom.x, u.lastHitFrom.y, u.x, u.y);
        u.moveTo(game.map, u.x + Math.cos(away) * 70, u.y + Math.sin(away) * 70, { reverse: true });
        u.retreatUntil = now + 6;
        return;
      }
      if ((u.retreatUntil || 0) > now) return;
      if (squad.contact) {
        if (u.path.length) u.stop();
        if (!u.target) u.facing = bearing;
        return;
      }
      const [sx, sy] = formationSlot("line", i, n, m.x, m.y, bearing, 50);
      sendTo(game, u, sx, sy, { facing: bearing });
    });
  } else if (m.type === "assault") {
    // 分隊の目標を揃える：射程内で最も弱っている敵
    let focus = null;
    let bestScore = -Infinity;
    for (const e of known) {
      const d = dist(cx, cy, e.x, e.y);
      if (d > 550) continue;
      const score = (1 - e.hp / e.maxHp) * 2 - d / 300 + (e.isFlag ? 1.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        focus = e;
      }
    }
    auto.forEach((u, i) => {
      u.fireMode = "free";
      if (!u.playerFocus) u.focus = focus;
      const engaging = u.target && u.target.alive && dist(u.x, u.y, u.target.x, u.target.y) < u.gunRange * 0.7;
      if (engaging) {
        if (u.path.length) u.stop();
        return;
      }
      const [sx, sy] = formationSlot("wedge", i, n, m.x, m.y, bearing, 35);
      sendTo(game, u, sx, sy, { facing: bearing });
    });
  } else if (m.type === "defend") {
    if (!squad.spots || squad.spots.length !== n) squad.spots = findDefensiveSpots(game, squad, m.x, m.y, bearing, n);
    auto.forEach((u, i) => {
      u.fireMode = "ambush";
      u.ambushRange = u.gunRange * 0.8;
      const [sx, sy] = squad.spots[i];
      sendTo(game, u, sx, sy, { facing: bearing });
      if (!u.path.length && !u.target) u.facing = bearing;
    });
  } else if (m.type === "withdraw") {
    auto.forEach((u, i) => {
      u.fireMode = "free";
      const [sx, sy] = formationSlot("line", i, n, m.x, m.y, bearing, 40);
      sendTo(game, u, sx, sy, { reverse: true, facing: bearing });
    });
  } else if (m.type === "follow") {
    const leadSquad = game.squads.find((s) => s.id === m.followSquadId && s.team === squad.team);
    const lead = leadSquad?.lead;
    if (!lead) return;
    const [lx, ly] = leadSquad.center();
    const back = wrapAngle(lead.heading);
    auto.forEach((u, i) => {
      u.fireMode = "free";
      const [sx, sy] = formationSlot("column", i + 2, n + 2, lx, ly, back, 30);
      sendTo(game, u, sx, sy, { facing: back });
    });
  }
}

/** 停止中の車体の向き。砲塔があり前面が厚ければ、対角線の角度より少し浅く斜めに構える（昼飯） */
export function angledFacing(u, bearing) {
  if (!u.hasTurret || !u.autoAngle) return bearing;
  const a = u.tank.armor_mm.hull;
  if (a.front < a.side * 1.3) return bearing;
  const corner = Math.atan2(u.halfW, u.halfL);
  const off = Math.min(25 * DEG, corner - 3 * DEG);
  if (off <= 0) return bearing;
  const left = wrapAngle(bearing - off);
  const right = wrapAngle(bearing + off);
  const dl = Math.abs(wrapAngle(left - u.heading));
  const dr = Math.abs(wrapAngle(right - u.heading));
  return dl < dr ? left : right;
}

