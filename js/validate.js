// データの整合性チェック（エディタとテストで共用）。raw は配列のままのデータ
import { ROLES, parseSlot, SKILL_LAYERS, STAT_DEFS, FLAG_DEFS } from "./stats.js";
import { SHELLS } from "./combat.js";

export function validate(raw) {
  const errors = [];
  const warns = [];
  const ids = (arr, kind) => {
    const seen = new Set();
    for (const x of arr || []) {
      if (!x.id) errors.push(`${kind}：IDが空のデータがあります（${x.name || "名前なし"}）`);
      else if (seen.has(x.id)) errors.push(`${kind}：ID「${x.id}」が重複しています`);
      seen.add(x.id);
    }
    return seen;
  };
  const tankIds = ids(raw.tanks, "戦車");
  const charIds = ids(raw.characters, "キャラ");
  const skillIds = ids(raw.skills, "スキル");
  const mapIds = ids(raw.maps, "マップ");
  ids(raw.scenarios, "シナリオ");

  const tanks = Object.fromEntries((raw.tanks || []).map((t) => [t.id, t]));
  for (const t of raw.tanks || []) {
    const n = `戦車「${t.name || t.id}」`;
    if (!t.crew_slots?.length) errors.push(`${n}：乗員の席がありません`);
    for (const slot of t.crew_slots || []) {
      for (const r of parseSlot(slot)) if (!ROLES.includes(r)) errors.push(`${n}：役職「${r}」は使えません`);
    }
    if (!(t.crew_slots || []).some((s) => parseSlot(s).includes("commander"))) warns.push(`${n}：車長の席がありません（車長補正・スキルが働きません）`);
    if (!t.gun?.shells?.length) errors.push(`${n}：弾種がありません`);
    for (const s of t.gun?.shells || []) if (!SHELLS[s.type]) errors.push(`${n}：弾種「${s.type}」は使えません`);
    if (!(t.hp > 0)) errors.push(`${n}：HPが0以下です`);
    if (!(t.size_m?.length > 0 && t.size_m?.width > 0)) errors.push(`${n}：車体サイズが不正です`);
    for (const k of ["still", "moving", "fire_penalty"]) {
      const v = t.camo?.[k];
      if (!(v >= 0 && v <= 1)) errors.push(`${n}：隠蔽率（${k}）は0〜1で入力してください`);
    }
  }
  for (const s of raw.skills || []) {
    const n = `スキル「${s.name || s.id}」`;
    if (!SKILL_LAYERS[s.layer]) errors.push(`${n}：層「${s.layer}」は使えません`);
    for (const e of s.effects || []) {
      if (!STAT_DEFS[e.stat] && !FLAG_DEFS[e.stat]) errors.push(`${n}：効果「${e.stat}」は使えません`);
    }
    if (s.layer === "role" && s.role && !ROLES.includes(s.role)) errors.push(`${n}：役職「${s.role}」は使えません`);
  }
  for (const c of raw.characters || []) {
    const n = `キャラ「${c.name || c.id}」`;
    for (const sid of c.skills || []) if (!skillIds.has(sid)) errors.push(`${n}：スキル「${sid}」がありません`);
  }
  for (const key of Object.keys(raw.lines || {})) {
    if (key !== "_default" && !charIds.has(key)) warns.push(`セリフ：キャラ「${key}」が見つかりません`);
  }
  for (const sc of raw.scenarios || []) {
    const n = `シナリオ「${sc.name || sc.id}」`;
    if (!mapIds.has(sc.map)) errors.push(`${n}：マップ「${sc.map}」がありません`);
    for (const [team, td] of Object.entries(sc.teams || {})) {
      const tn = `${n}／${td.name || team}`;
      if (!td.units?.length) errors.push(`${tn}：車輌がいません`);
      const flags = (td.units || []).filter((u) => u.flag).length;
      if (sc.mode === "flag" && flags !== 1) errors.push(`${tn}：フラッグ戦ではフラッグ車を1輌だけ指定してください（現在${flags}輌）`);
      const leaders = (td.units || []).filter((u) => u.leader).length;
      if (leaders > 1) errors.push(`${tn}：隊長車が${leaders}輌あります`);
      if (!leaders) warns.push(`${tn}：隊長車が未指定です（先頭の車輌が隊長になります）`);
      for (const u of td.units || []) {
        const un = `${tn}／${u.label || u.tank}`;
        const t = tanks[u.tank];
        if (!tankIds.has(u.tank)) {
          errors.push(`${un}：戦車「${u.tank}」がありません`);
          continue;
        }
        if ((u.crew || []).length !== t.crew_slots.length) warns.push(`${un}：乗員数（${(u.crew || []).length}）と席の数（${t.crew_slots.length}）が違います`);
        (u.crew || []).forEach((cid, i) => {
          if (cid && !charIds.has(cid)) errors.push(`${un}：キャラ「${cid}」がありません`);
          if (!cid && i < t.crew_slots.length) warns.push(`${un}：${i + 1}番目の席が空席です`);
        });
      }
    }
  }
  return { errors, warns };
}
