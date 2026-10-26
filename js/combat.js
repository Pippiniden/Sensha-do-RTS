// 射撃判定の計算（仕様書 5章）。ゲーム状態に依存しない純粋関数だけを置く。
import { DEG } from "./util.js";

export const COMBAT = {
  penRandom: 0.15, // 貫通力の乱数幅（WoTは±25%）
  damageRandom: 0.1, // ダメージの乱数幅
  weakSpotChance: 0.05, // 弱点ヒットの基本確率
  weakSpotFactor: 0.7, // 弱点ヒット時の装甲厚倍率
  turretHitShare: 0.4, // 前面・側面への被弾のうち砲塔に当たる割合
  heNonPenArmorFactor: 1.1, // HE非貫通時：ダメージ/2 − 装甲×係数
  moduleCritChance: 0.3,
  crewStunChance: 0.15,
};

// 弾種ごとの性質。ricochet は跳弾角(°)。null は跳弾しない
export const SHELLS = {
  AP: { ricochet: 70, ricochetInclusive: true, normalization: 5, falloff500: 0.1, speed: 750, spacedApplies: false },
  APCR: { ricochet: 70, ricochetInclusive: true, normalization: 2, falloff500: 0.2, speed: 1000, spacedApplies: false },
  HEAT: { ricochet: 85, ricochetInclusive: false, normalization: 0, falloff500: 0, speed: 650, spacedApplies: true },
  HE: { ricochet: null, ricochetInclusive: false, normalization: 0, falloff500: 0, speed: 600, spacedApplies: true },
};

/** 跳弾するか。口径が装甲の3倍を超えると跳弾しない */
export function isRicochet(shellType, caliber, thickness, angleDeg) {
  const s = SHELLS[shellType];
  if (!s || s.ricochet === null) return false;
  if ((shellType === "AP" || shellType === "APCR") && caliber > thickness * 3) return false;
  return s.ricochetInclusive ? angleDeg >= s.ricochet : angleDeg > s.ricochet;
}

/** 正規化後の入射角。口径が装甲の2倍以上なら正規化量が増える */
export function normalizedAngle(shellType, caliber, thickness, angleDeg) {
  const base = SHELLS[shellType]?.normalization || 0;
  if (!base) return angleDeg;
  const n = caliber >= thickness * 2 ? base * 1.4 * (caliber / Math.max(1, thickness)) : base;
  return Math.max(0, angleDeg - n);
}

/** 実効装甲。増加装甲は HEAT・HE にだけ加算 */
export function effectiveArmor(shellType, thickness, normAngleDeg, spaced = 0) {
  const cos = Math.max(0.05, Math.cos(normAngleDeg * DEG));
  const add = SHELLS[shellType]?.spacedApplies ? spaced : 0;
  return thickness / cos + add;
}

/** 距離による貫通力減衰（100m以下は減衰なし、500mで falloff500 だけ減る線形） */
export function penetrationAt(pen100, shellType, distance) {
  const f = SHELLS[shellType]?.falloff500 || 0;
  const t = Math.max(0, Math.min(1.5, (distance - 100) / 400));
  return pen100 * (1 - f * t);
}

/**
 * 1発の被弾を解決する。
 * @returns {{result:'ricochet'|'pen'|'nonpen', angle, normAngle, effArmor, pen, damage, weakSpot}}
 */
export function resolveImpact({ shell, caliber, thickness, spaced = 0, angleDeg, distance, rng, weakSpotChance = COMBAT.weakSpotChance }) {
  const type = shell.type;
  let t = thickness;
  const weakSpot = rng() < weakSpotChance;
  if (weakSpot) t *= COMBAT.weakSpotFactor;
  const out = { angle: angleDeg, normAngle: angleDeg, effArmor: t, pen: 0, damage: 0, weakSpot };
  if (isRicochet(type, caliber, t, angleDeg)) {
    return { ...out, result: "ricochet" };
  }
  const na = normalizedAngle(type, caliber, t, angleDeg);
  const eff = effectiveArmor(type, t, na, spaced);
  const pen = penetrationAt(shell.pen_mm, type, distance) * (1 + (rng() * 2 - 1) * COMBAT.penRandom);
  const base = shell.damage * (1 + (rng() * 2 - 1) * COMBAT.damageRandom);
  if (pen >= eff) {
    return { ...out, normAngle: na, effArmor: eff, pen, damage: Math.round(base), result: "pen" };
  }
  let damage = 0;
  if (type === "HE") damage = Math.max(0, Math.round(base * 0.5 - eff * COMBAT.heNonPenArmorFactor));
  return { ...out, normAngle: na, effArmor: eff, pen, damage, result: "nonpen" };
}

/**
 * 線分と車体矩形（OBB）の交差。車体ローカルは +x が前方。
 * @returns {null | {t:number, face:'front'|'side'|'rear', nx:number, ny:number}} t は線分上の割合
 */
export function segmentVsHull(x0, y0, x1, y1, cx, cy, heading, halfL, halfW) {
  const cos = Math.cos(-heading);
  const sin = Math.sin(-heading);
  const lx0 = (x0 - cx) * cos - (y0 - cy) * sin;
  const ly0 = (x0 - cx) * sin + (y0 - cy) * cos;
  const lx1 = (x1 - cx) * cos - (y1 - cy) * sin;
  const ly1 = (x1 - cx) * sin + (y1 - cy) * cos;
  const dx = lx1 - lx0;
  const dy = ly1 - ly0;
  let tmin = 0;
  let tmax = 1;
  let axis = -1;
  let sign = 0;
  const slab = (p, d, h, ax) => {
    if (Math.abs(d) < 1e-9) return p >= -h && p <= h;
    let t1 = (-h - p) / d;
    let t2 = (h - p) / d;
    let s = -1; // 入射面：-h 側
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = ax;
      sign = s;
    }
    tmax = Math.min(tmax, t2);
    return tmin <= tmax;
  };
  if (!slab(lx0, dx, halfL, 0)) return null;
  if (!slab(ly0, dy, halfW, 1)) return null;
  if (axis === -1) return null; // 始点が内側
  let face;
  let lnx = 0;
  let lny = 0;
  if (axis === 0) {
    face = sign > 0 ? "front" : "rear";
    lnx = sign;
  } else {
    face = "side";
    lny = sign;
  }
  // 法線をワールド座標へ
  const wc = Math.cos(heading);
  const ws = Math.sin(heading);
  return { t: tmin, face, nx: lnx * wc - lny * ws, ny: lnx * ws + lny * wc };
}

/** 弾の進行方向と法線から入射角(°)を求める */
export function incidenceAngle(dirX, dirY, nx, ny) {
  const len = Math.hypot(dirX, dirY) || 1;
  const c = (-dirX * nx - dirY * ny) / len;
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** 砲塔被弾：弾の飛来方向と砲塔の向きから面と入射角を出す（砲塔は正方形として近似） */
export function turretFace(dirX, dirY, turretHeading) {
  const from = Math.atan2(-dirY, -dirX); // 弾が飛んでくる方向
  let rel = Math.abs(((from - turretHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / DEG; // 0..180
  if (rel <= 45) return { face: "front", angle: rel };
  if (rel >= 135) return { face: "rear", angle: 180 - rel };
  rel = Math.abs(90 - rel);
  return { face: "side", angle: rel };
}
