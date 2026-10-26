// 乗員とスキルから車輌の実効性能を計算する（仕様書 7章）。
import { DEG, clamp } from "./util.js";

export const ROLES = ["commander", "gunner", "loader", "driver", "radio"];
export const ROLE_NAMES = { commander: "車長", gunner: "砲手", loader: "装填手", driver: "操縦手", radio: "通信手" };

// 性能値ごとの担当役職と「高いほど良いか」
export const STAT_DEFS = {
  view_range: { name: "視認範囲", role: "commander", better: "high" },
  aim_time: { name: "照準時間", role: "gunner", better: "low" },
  dispersion: { name: "拡散", role: "gunner", better: "low" },
  turret_traverse: { name: "砲塔旋回", role: "gunner", better: "high" },
  reload: { name: "装填時間", role: "loader", better: "low" },
  speed: { name: "速度", role: "driver", better: "high" },
  hull_traverse: { name: "車体旋回", role: "driver", better: "high" },
  radio_range: { name: "通信範囲", role: "radio", better: "high" },
  camo: { name: "隠蔽率", role: null, better: "high" },
  weakspot_chance: { name: "弱点ヒット率", role: null, better: "high" },
  damage: { name: "ダメージ", role: null, better: "high" },
  stun_resist: { name: "気絶耐性", role: null, better: "high" },
  stun_recovery: { name: "気絶回復の速さ", role: null, better: "high" },
  repair_speed: { name: "修理速度", role: null, better: "high" },
  commander_stun_chance: { name: "車長の気絶率", role: null, better: "low" },
  order_delay: { name: "命令の伝達遅延", role: null, better: "low" },
};

// 値を持たない特殊効果
export const FLAG_DEFS = {
  sixth_sense: "第六感：被発見を3秒後に察知",
  enemy_armor_info: "発見した敵の装甲値を表示",
  no_order_delay: "命令の伝達遅延なし",
};

export const SKILL_LAYERS = {
  personal: "個人スキル（常時）",
  role: "役職スキル（その役職のとき）",
  commander: "車長補正（車長のとき・自車）",
  squad_leader: "分隊長補正（分隊長車の車長のとき・分隊）",
  leader: "隊長補正（隊長のとき・通信範囲の全車）",
  active: "アクティブ（使用型）",
};

export const STAT_CAP = 40; // 1カテゴリの補正上限 ±40%

export function parseSlot(slot) {
  return String(slot).split("+").map((s) => s.trim()).filter(Boolean);
}

/**
 * 乗員の役職ごとの熟練度を計算する。
 * unit.crew[i] は tank.crew_slots[i] に乗るキャラ（character オブジェクトか null）
 */
export function crewProficiency(tank, crew, stunned = {}) {
  const roleProf = {};
  const roleChar = {};
  const primary = [];
  tank.crew_slots.forEach((slot, i) => {
    const roles = parseSlot(slot);
    const ch = crew[i] || null;
    roles.forEach((r, k) => {
      let p = ch ? (ch.proficiency?.[r] ?? 50) : 40;
      if (k > 0) p *= 0.8; // 兼任
      if (ch && stunned[ch.id]) p *= 0.5;
      roleProf[r] = Math.max(roleProf[r] ?? 0, p);
      if (k === 0 && ch) roleChar[r] = ch;
    });
    if (ch) primary.push({ char: ch, role: roles[0], slot: i });
  });
  // 車長ボーナス：車長熟練度の10%を他の役職に加える
  const cmdBonus = (roleProf.commander ?? 0) * 0.1;
  for (const r of ROLES) {
    if (roleProf[r] === undefined) roleProf[r] = 30; // 担当者がいない
    else if (r !== "commander") roleProf[r] += cmdBonus;
  }
  return { roleProf, roleChar, primary };
}

/** その車輌の乗員が持つスキルを層ごとに集める */
export function collectSkills(unit, skillsById) {
  const out = { self: [], squad: [], network: [], actives: [] };
  const { primary } = unit.crewInfo;
  for (const { char, role } of primary) {
    if (unit.stunned[char.id]) continue;
    for (const sid of char.skills || []) {
      const sk = skillsById[sid];
      if (!sk) continue;
      const isCommander = role === "commander";
      switch (sk.layer) {
        case "personal":
          out.self.push(sk);
          break;
        case "role":
          if (!sk.role || sk.role === role) out.self.push(sk);
          break;
        case "commander":
          if (isCommander) out.self.push(sk);
          break;
        case "squad_leader":
          if (isCommander && unit.isSquadLead) out.squad.push(sk);
          break;
        case "leader":
          if (isCommander && unit.isLeader) out.network.push(sk);
          break;
        case "active": {
          const req = sk.requires || "commander";
          const ok = isCommander && (req === "commander" || (req === "leader" && unit.isLeader) || (req === "squad_leader" && (unit.isSquadLead || unit.isLeader)));
          if (ok) out.actives.push({ skill: sk, char });
          break;
        }
        default:
          break;
      }
    }
  }
  return out;
}

/** スキルの効果を合算する（同名スキルは1回だけ、カテゴリごとに±40%で打ち切り） */
export function sumEffects(skills) {
  const seen = new Set();
  const pct = {};
  const flags = new Set();
  const sets = {};
  for (const sk of skills) {
    if (!sk || seen.has(sk.id)) continue;
    seen.add(sk.id);
    for (const e of sk.effects || []) {
      if (e.op === "flag") flags.add(e.stat);
      else if (e.op === "set") sets[e.stat] = e.value;
      else pct[e.stat] = (pct[e.stat] || 0) + Number(e.value || 0);
    }
  }
  for (const k of Object.keys(pct)) pct[k] = clamp(pct[k], -STAT_CAP, STAT_CAP);
  return { pct, flags, sets };
}

function profFactor(p) {
  return 0.5 + 0.5 * (p / 100);
}

/** 車輌の実効性能を計算する。auras は他車から届く補正スキル */
export function computeStats(unit, auras = []) {
  const tank = unit.tank;
  const { roleProf } = unit.crewInfo;
  const all = [...unit.skillSets.self, ...auras, ...unit.activeEffects.map((a) => a.skill)];
  const { pct, flags, sets } = sumEffects(all);
  const val = (stat, base) => {
    const def = STAT_DEFS[stat];
    let v = base;
    if (def?.role) {
      const f = profFactor(roleProf[def.role]);
      v = def.better === "high" ? v * f : v / f;
    }
    return v * (1 + (pct[stat] || 0) / 100);
  };
  const g = tank.gun;
  const m = tank.mobility;
  const s = {
    view_range: val("view_range", tank.view_range_m),
    radio_range: val("radio_range", tank.radio_range_m),
    reload: val("reload", g.reload_s),
    aim_time: val("aim_time", g.aim_s),
    dispersion: val("dispersion", g.dispersion_m),
    turret_traverse: val("turret_traverse", m.turret_traverse_dps) * DEG,
    hull_traverse: val("hull_traverse", m.hull_traverse_dps) * DEG,
    speed_fwd: (val("speed", m.fwd_kmh) / 3.6),
    speed_rev: (val("speed", m.rev_kmh) / 3.6),
    camo_still: tank.camo.still * (1 + (pct.camo || 0) / 100),
    camo_moving: tank.camo.moving * (1 + (pct.camo || 0) / 100),
    fire_penalty: tank.camo.fire_penalty,
    weakspot_chance: 0.05 + (pct.weakspot_chance || 0) / 100,
    damage_mul: 1 + (pct.damage || 0) / 100,
    stun_resist: (pct.stun_resist || 0) / 100,
    stun_recovery: 1 + (pct.stun_recovery || 0) / 100,
    repair_speed: 1 + (pct.repair_speed || 0) / 100,
    commander_stun_mul: 1 + (pct.commander_stun_chance || 0) / 100,
    order_delay: sets.order_delay ?? 1.5 * (1 + (pct.order_delay || 0) / 100),
    flags,
  };
  if (flags.has("no_order_delay")) s.order_delay = 0;
  return s;
}
