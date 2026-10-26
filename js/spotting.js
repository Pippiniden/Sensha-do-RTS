// 索敵・隠蔽・通信共有（仕様書 6章）
import { dist } from "./util.js";

export const SPOT = {
  proximity: 50, // 近接自動発見
  bushClear: 15, // 茂み15mルール
  bushCap: 0.5,
  firePenaltyTime: 3, // 射撃後に隠蔽が下がる時間
  lingerTime: 5, // 発見が途切れても表示を続ける時間
  ghostTime: 30, // 最終確認位置を残す時間
  sixthSenseDelay: 3,
};

/** 距離ごとの判定間隔（仕様書 6.3） */
function checkInterval(d) {
  if (d <= 50) return 0.2;
  if (d <= 200) return 0.5;
  return 1.0;
}

/** 目標の最終隠蔽率 */
export function concealment(map, observer, target, now) {
  const s = target.stats;
  const fired = now - target.lastFired < SPOT.firePenaltyTime;
  let c = target.isMoving(now) ? s.camo_moving : s.camo_still;
  // 視線上の茂み（観測者から15m以内は数えない。射撃直後は目標から15m以内も数えない）
  let bush = 0;
  const total = dist(target.x, target.y, observer.x, observer.y);
  map.walkLine(target.x, target.y, observer.x, observer.y, (terr, x, y, dFromTarget) => {
    if (terr.camo > 0) {
      const dFromObs = total - dFromTarget;
      if (dFromObs < SPOT.bushClear) return false;
      if (fired && dFromTarget < SPOT.bushClear) return false;
      bush += terr.camo;
    }
    return bush >= SPOT.bushCap;
  });
  c += Math.min(SPOT.bushCap, bush);
  if (fired) c -= s.fire_penalty;
  return Math.max(0, Math.min(0.95, c));
}

/** 観測者が目標を発見できる距離 D = min(Dmax, 50 + (V − 50)(1 − C)) */
export function spotDistance(viewRange, camo, maxSpot) {
  return Math.min(maxSpot, SPOT.proximity + (viewRange - SPOT.proximity) * (1 - camo));
}

export class Spotting {
  constructor(game) {
    this.game = game;
    this.nextCheck = new Map(); // "obsId|tgtId" -> 時刻
    this.state = new Map(); // "obsId|tgtId" -> bool
  }

  /** 毎フレーム呼ぶ。必要な組だけ判定する */
  update(now) {
    const { units, map } = this.game;
    const maxSpot = map.def.max_spot_m || 400;
    const alive = units.filter((u) => u.alive);
    for (const obs of alive) {
      for (const tgt of alive) {
        if (obs.team === tgt.team) continue;
        const key = `${obs.id}|${tgt.id}`;
        const due = this.nextCheck.get(key) ?? 0;
        if (now < due) continue;
        const d = dist(obs.x, obs.y, tgt.x, tgt.y);
        this.nextCheck.set(key, now + checkInterval(d));
        let seen = false;
        if (d <= SPOT.proximity) seen = true;
        else if (d <= maxSpot + 1) {
          const c = concealment(map, obs, tgt, now);
          if (d <= spotDistance(obs.stats.view_range, c, maxSpot) && map.hasLos(obs.x, obs.y, tgt.x, tgt.y)) seen = true;
        }
        this.state.set(key, seen);
      }
    }
    // 各車が自分で見ている敵
    for (const u of units) {
      u.knownBySelf = new Set();
    }
    for (const obs of alive) {
      for (const tgt of alive) {
        if (obs.team !== tgt.team && this.state.get(`${obs.id}|${tgt.id}`)) obs.knownBySelf.add(tgt.id);
      }
    }
    // 被発見状態（第六感用）
    for (const tgt of alive) {
      const seen = alive.some((o) => o.team !== tgt.team && o.knownBySelf.has(tgt.id));
      if (seen) {
        if (tgt.spottedSince === null) {
          tgt.spottedSince = now;
          tgt.sixthSenseShown = false;
        }
      } else {
        tgt.spottedSince = null;
      }
    }
  }
}

/** 通信網：通信範囲が届く味方同士を連結（どちらかの通信範囲内なら繋がる） */
export function computeNetworks(units) {
  const alive = units.filter((u) => u.alive);
  const parent = new Map(alive.map((u) => [u.id, u.id]));
  const find = (a) => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)));
      a = parent.get(a);
    }
    return a;
  };
  for (let i = 0; i < alive.length; i += 1) {
    for (let j = i + 1; j < alive.length; j += 1) {
      const a = alive[i];
      const b = alive[j];
      if (a.team !== b.team) continue;
      const r = Math.max(a.stats.radio_range, b.stats.radio_range);
      if (dist(a.x, a.y, b.x, b.y) <= r) parent.set(find(a.id), find(b.id));
    }
  }
  const components = new Map();
  for (const u of alive) {
    const root = find(u.id);
    u.component = root;
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(u);
  }
  return components;
}
