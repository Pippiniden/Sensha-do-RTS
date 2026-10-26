// ゲーム本体：状態の保持と1ステップの更新
import { DEG, angleDiff, angleTo, dist, makeRng, wrapAngle } from "./util.js";
import { GameMap } from "./map.js";
import { Unit, MODULES } from "./unit.js";
import { Spotting, computeNetworks, SPOT } from "./spotting.js";
import { Squad, squadTick, angledFacing, formationSlot } from "./squad.js";
import { EnemyCommander } from "./ai.js";
import { SHELLS, COMBAT, resolveImpact, segmentVsHull, incidenceAngle, turretFace } from "./combat.js";

export const PLAYER = "A";
export const ENEMY = "B";

export const DIFFICULTIES = {
  easy: { name: "イージー", pause: "free", enemyAccuracy: 1.3, aggression: 0.3 },
  normal: { name: "ノーマル", pause: "free", enemyAccuracy: 1.0, aggression: 0.5 },
  hard: { name: "ハード", pause: "limited", enemyAccuracy: 0.9, aggression: 0.7 },
  veryhard: { name: "ベリーハード", pause: "none", enemyAccuracy: 0.8, aggression: 0.85 },
};

export const PAUSE_MODES = {
  auto: "難易度に合わせる",
  free: "自由に一時停止",
  limited: "1試合3回まで",
  none: "一時停止なし",
};

export class Game {
  constructor(data, scenarioId, settings = {}) {
    this.data = data;
    this.scenario = data.scenarios[scenarioId];
    if (!this.scenario) throw new Error(`シナリオ ${scenarioId} がありません`);
    this.settings = { difficulty: "normal", pauseMode: "auto", ...settings };
    this.diff = DIFFICULTIES[this.settings.difficulty] || DIFFICULTIES.normal;
    const pm = this.settings.pauseMode === "auto" ? this.diff.pause : this.settings.pauseMode;
    this.pauseMode = pm;
    this.pausesLeft = pm === "limited" ? 3 : Infinity;
    this.map = new GameMap(data.maps[this.scenario.map]);
    this.rng = makeRng(this.settings.seed ?? (Date.now() & 0xffff));
    this.time = 0;
    this.paused = false;
    this.speed = 1;
    this.units = [];
    this.squads = [];
    this.projectiles = [];
    this.fx = [];
    this.log = [];
    this.events = [];
    this.pending = [];
    this.result = null;
    this.timers = { slow: 0, squad: 0, target: 0 };
    this.componentKnown = new Map();
    this.lastSeen = { [PLAYER]: new Map(), [ENEMY]: new Map() };
    this.playerSeen = new Map(); // 隊長の通信網が把握した敵の最終確認
    this.playerKnown = new Set();
    this.commandFreezeUntil = 0;
    this.flagAnnounced = false;
    this.spawn();
    this.spotting = new Spotting(this);
    this.ai = new EnemyCommander(this, ENEMY, { aggression: this.diff.aggression, ...(this.scenario.teams[ENEMY].ai || {}) });
    this.slowUpdate();
  }

  // ---------- 初期配置 ----------
  spawn() {
    for (const team of [PLAYER, ENEMY]) {
      const tdef = this.scenario.teams[team];
      const sp = tdef.spawn;
      const facing = (sp.facing_deg ?? 0) * DEG;
      for (const sdef of tdef.squads || [{ id: 1 }]) {
        const sq = new Squad(sdef.id, team, sdef.name);
        sq.aiRole = sdef.ai_role;
        this.squads.push(sq);
      }
      const units = tdef.units || [];
      const bySquad = {};
      for (const ud of units) (bySquad[ud.squad ?? 1] ||= []).push(ud);
      const squadIds = Object.keys(bySquad);
      squadIds.forEach((sid, si) => {
        const list = bySquad[sid];
        list.forEach((ud, i) => {
          const tank = this.data.tanks[ud.tank];
          if (!tank) return;
          // 分隊ごとに横並び、分隊内は縦に並べる（spawn矩形内）
          const fx = (si + 0.5) / squadIds.length;
          const fy = (i + 0.5) / list.length;
          let x = sp.x + sp.w * (sp.w > sp.h ? fx : fy);
          let y = sp.y + sp.h * (sp.w > sp.h ? fy : fx);
          [x, y] = this.map.nearestPassable(x, y);
          const crew = (tank.crew_slots || []).map((_, k) => this.data.characters[ud.crew?.[k]] || null);
          const u = new Unit({
            team,
            tank,
            crew,
            x,
            y,
            heading: facing,
            skillsById: this.data.skills,
            flags: { leader: ud.leader, flag: ud.flag, squad: Number(sid) },
          });
          u.label = ud.label || tank.name;
          this.units.push(u);
          let sq = this.squads.find((s) => s.team === team && s.id === Number(sid));
          if (!sq) {
            sq = new Squad(Number(sid), team);
            this.squads.push(sq);
          }
          sq.members.push(u);
        });
      });
      if (!this.units.some((u) => u.team === team && u.isLeader)) {
        const first = this.units.find((u) => u.team === team);
        if (first) first.isLeader = true;
      }
    }
    for (const sq of this.squads) {
      const lead = sq.lead;
      if (lead) lead.isSquadLead = true;
      const sdef = (this.scenario.teams[sq.team].squads || []).find((s) => s.id === sq.id);
      if (sdef?.mission) {
        const c = sq.center();
        sq.setMission({ ...sdef.mission, x: sdef.mission.x ?? c[0], y: sdef.mission.y ?? c[1] });
      }
    }
  }

  spawnCenter(team) {
    const sp = this.scenario.teams[team].spawn;
    return [sp.x + sp.w / 2, sp.y + sp.h / 2];
  }

  enemySpawnCenter(team) {
    return this.spawnCenter(team === PLAYER ? ENEMY : PLAYER);
  }

  teamUnits(team) {
    return this.units.filter((u) => u.team === team);
  }

  leader(team) {
    return this.units.find((u) => u.team === team && u.alive && u.isLeader) || null;
  }

  squadOf(u) {
    return this.squads.find((s) => s.team === u.team && s.members.includes(u));
  }

  // ---------- 情報 ----------
  knownSet(u) {
    return this.componentKnown.get(u.component) || new Set();
  }

  knownEnemiesForTeamUnits(units) {
    const ids = new Set();
    for (const u of units) for (const id of this.knownSet(u)) ids.add(id);
    return this.units.filter((e) => e.alive && ids.has(e.id));
  }

  teamLastSeen(team) {
    const out = [];
    for (const v of this.lastSeen[team].values()) if (this.time - v.t < 60 && v.unit.alive) out.push(v);
    return out;
  }

  /** プレイヤー画面での敵の表示状態：visible / linger / ghost / null */
  enemyDisplay(e) {
    if (this.result) return e.alive ? "visible" : "wreck";
    if (!e.alive) return this.playerSeen.has(e.id) ? "wreck" : null;
    if (this.playerKnown.has(e.id)) return "visible";
    const s = this.playerSeen.get(e.id);
    if (!s) return null;
    if (this.time - s.t < SPOT.lingerTime) return "linger";
    if (this.time - s.t < SPOT.ghostTime) return "ghost";
    return null;
  }

  // ---------- 更新 ----------
  update(dtReal) {
    if (this.paused || this.result) return;
    let dt = Math.min(0.1, dtReal) * this.speed;
    while (dt > 0) {
      const step = Math.min(dt, 1 / 50);
      this.step(step);
      dt -= step;
      if (this.result) break;
    }
  }

  step(dt) {
    this.time += dt;
    const now = this.time;
    // 遅れて届く命令
    if (this.pending.length) {
      const due = this.pending.filter((p) => p.at <= now);
      this.pending = this.pending.filter((p) => p.at > now);
      due.forEach((p) => p.fn());
    }
    this.timers.slow -= dt;
    if (this.timers.slow <= 0) {
      this.timers.slow = 0.5;
      this.slowUpdate();
    }
    this.spotting.update(now);
    this.updateKnowledge();
    this.timers.squad -= dt;
    if (this.timers.squad <= 0) {
      this.timers.squad = 0.5;
      for (const sq of this.squads) {
        const before = sq.contact;
        squadTick(this, sq, now);
        if (sq.team === PLAYER && sq.contact && !before && sq.mission.type !== "manual") {
          this.emit({ type: "contact", unit: sq.lead, priority: 1 });
        }
      }
      this.ai.update(now);
    }
    this.timers.target -= dt;
    if (this.timers.target <= 0) {
      this.timers.target = 0.4;
      for (const u of this.units) if (u.alive) this.chooseTarget(u);
    }
    for (const u of this.units) {
      if (!u.alive) continue;
      this.hullBehaviour(u);
      u.update(dt, now, this.map);
      this.tryFire(u, now);
      for (const ev of u.events.splice(0)) {
        if (ev.type === "repaired" && u.team === PLAYER) this.addLog(`${u.label}：${MODULES[ev.module]}の応急修理完了`);
      }
    }
    this.updateProjectiles(dt);
    this.collide();
    this.fx = this.fx.filter((f) => now - f.t0 < f.dur);
    this.checkVictory();
  }

  /** 0.5秒ごと：通信網・補正スキル */
  slowUpdate() {
    const comps = computeNetworks(this.units);
    // 補正の配布：隊長補正は隊長車の通信網全体、分隊長補正は同じ網の分隊員へ
    const auras = new Map(this.units.map((u) => [u.id, []]));
    for (const u of this.units) {
      if (!u.alive) continue;
      u.skillSets = u.skillSets || { network: [], squad: [] };
    }
    for (const u of this.units) {
      if (!u.alive) continue;
      const sets = u.skillSets;
      if (sets.network.length) for (const m of comps.get(u.component) || []) auras.get(m.id).push(...sets.network);
      if (sets.squad.length) {
        const sq = this.squadOf(u);
        for (const m of sq?.alive || []) if (m.component === u.component) auras.get(m.id).push(...sets.squad);
      }
    }
    for (const u of this.units) if (u.alive) u.recomputeStats(auras.get(u.id));
  }

  updateKnowledge() {
    this.componentKnown = new Map();
    for (const u of this.units) {
      if (!u.alive) continue;
      if (!this.componentKnown.has(u.component)) this.componentKnown.set(u.component, new Set());
      const set = this.componentKnown.get(u.component);
      for (const id of u.knownBySelf) set.add(id);
    }
    const now = this.time;
    for (const team of [PLAYER, ENEMY]) {
      const ids = new Set();
      for (const u of this.units) if (u.alive && u.team === team) for (const id of u.knownBySelf) ids.add(id);
      for (const e of this.units) if (ids.has(e.id)) this.lastSeen[team].set(e.id, { x: e.x, y: e.y, t: now, unit: e });
    }
    const leader = this.leader(PLAYER);
    this.playerKnown = leader ? this.knownSet(leader) : new Set();
    for (const id of this.playerKnown) {
      const e = this.units.find((x) => x.id === id);
      if (!e) continue;
      this.playerSeen.set(id, { x: e.x, y: e.y, heading: e.heading, turret: e.turret, t: now });
      if (e.isFlag && !this.flagAnnounced) {
        this.flagAnnounced = true;
        const spotter = this.units.find((u) => u.team === PLAYER && u.alive && u.knownBySelf.has(id)) || leader;
        this.emit({ type: "flag_spotted", unit: spotter, priority: 4 });
        this.addLog("敵フラッグ車を発見！", "warn");
      }
    }
    // 第六感
    for (const u of this.units) {
      if (!u.alive || u.team !== PLAYER || u.spottedSince === null || u.sixthSenseShown) continue;
      if (now - u.spottedSince >= SPOT.sixthSenseDelay && u.stats.flags.has("sixth_sense")) {
        u.sixthSenseShown = true;
        this.emit({ type: "sixth_sense", unit: u, priority: 2 });
      }
    }
  }

  chooseTarget(u) {
    const known = this.knownSet(u);
    const cands = [];
    for (const e of this.units) {
      if (!e.alive || e.team === u.team || !known.has(e.id)) continue;
      const d = dist(u.x, u.y, e.x, e.y);
      if (d > u.gunRange) continue;
      if (!this.map.hasLos(u.x, u.y, e.x, e.y)) continue;
      cands.push([e, d]);
    }
    if (u.focus && (!u.focus.alive || !cands.some(([e]) => e === u.focus))) {
      if (!u.focus.alive) {
        u.focus = null;
        u.playerFocus = false;
      }
    }
    const focus = u.focus && cands.find(([e]) => e === u.focus);
    if (focus) {
      u.target = focus[0];
      return;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const [e, d] of cands) {
      const aimAtMe = Math.abs(angleDiff(e.turret, angleTo(e.x, e.y, u.x, u.y))) < 15 * DEG ? 1.5 : 0;
      const penEst = Math.min(1.5, u.shell.pen_mm / Math.max(1, e.tank.armor_mm.hull.front));
      const score = aimAtMe + penEst + (1 - e.hp / e.maxHp) - d / 400 + (e === u.target ? 0.3 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    u.target = best;
    if (best && u.shellAuto !== false) this.autoShell(u, best);
  }

  /** 弾種の自動選択：その向きの装甲を抜ける最初の弾種、なければ最も貫通力の高い弾種 */
  autoShell(u, e) {
    const shells = u.tank.gun.shells;
    const h = segmentVsHull(u.x, u.y, e.x + (e.x - u.x) * 0.1, e.y + (e.y - u.y) * 0.1, e.x, e.y, e.heading, e.halfL, e.halfW);
    let eff = e.tank.armor_mm.hull.front;
    if (h) {
      const dx = e.x - u.x;
      const dy = e.y - u.y;
      const ang = incidenceAngle(dx, dy, h.nx, h.ny);
      eff = e.tank.armor_mm.hull[h.face] / Math.max(0.2, Math.cos(Math.min(70, ang) * DEG));
    }
    const d = dist(u.x, u.y, e.x, e.y);
    let pick = -1;
    let bestPen = -1;
    let bestI = 0;
    shells.forEach((s, i) => {
      if (s.type === "HE") return;
      const pen = s.pen_mm * (1 - (SHELLS[s.type].falloff500 || 0) * Math.max(0, (d - 100) / 400));
      if (pick < 0 && pen * 0.95 >= eff) pick = i;
      if (pen > bestPen) {
        bestPen = pen;
        bestI = i;
      }
    });
    u.shellIndex = pick >= 0 ? pick : bestI;
  }

  /** 停止中の車体の向き：目標があれば斜めに構え、砲塔なし車は目標へ車体を向ける */
  hullBehaviour(u) {
    if (u.path.length || u.facingLock || !u.target || !u.canMove()) return;
    const bearing = angleTo(u.x, u.y, u.target.x, u.target.y);
    if (!u.hasTurret) {
      const arc = (u.tank.gun.arc_deg ?? 10) * DEG;
      if (Math.abs(angleDiff(u.heading, bearing)) > arc * 0.8) u.facing = bearing;
    } else if (u.autoAngle) {
      const want = angledFacing(u, bearing);
      if (Math.abs(angleDiff(u.heading, want)) > 8 * DEG) u.facing = want;
    }
  }

  tryFire(u, now) {
    const t = u.target;
    if (!t || !t.alive || u.reloadLeft > 0 || u.modules.gun === "destroyed") return;
    const d = dist(u.x, u.y, t.x, t.y);
    if (u.fireMode === "hold") return;
    if (u.fireMode === "ambush") {
      const provoked = now - u.lastHitTime < 10 || d <= u.ambushRange || (u.focus === t && u.playerFocus);
      if (!provoked) return;
    }
    if (!u.turretAligned()) return;
    const moving = u.isMoving(now);
    const ready = moving ? u.disp <= 2.2 : u.disp <= 1.15 || u.aimStart > u.stats.aim_time * 2.5;
    if (!ready) return;
    this.fire(u, t, d);
  }

  fire(u, t, d) {
    const selfSpotted = u.knownBySelf.has(t.id);
    let r = u.aimRadius(d, selfSpotted);
    if (u.team === ENEMY) r *= this.diff.enemyAccuracy;
    let ox = this.rng.gauss() * r * 0.5;
    let oy = this.rng.gauss() * r * 0.5;
    const ol = Math.hypot(ox, oy);
    if (ol > r) {
      ox *= r / ol;
      oy *= r / ol;
    }
    const mx = u.x + Math.cos(u.turret) * u.halfL * 0.9;
    const my = u.y + Math.sin(u.turret) * u.halfL * 0.9;
    const ax = t.x + ox;
    const ay = t.y + oy;
    const len = Math.hypot(ax - mx, ay - my) || 1;
    const shell = u.shell;
    this.projectiles.push({
      x: mx,
      y: my,
      dx: (ax - mx) / len,
      dy: (ay - my) / len,
      speed: SHELLS[shell.type].speed,
      travelled: 0,
      max: len + 80,
      shooter: u,
      shell,
      caliber: u.tank.gun.caliber_mm,
      lastCover: -999,
    });
    u.reloadLeft = u.reloadTime();
    u.disp += 1;
    u.aimStart = 0;
    u.lastFired = this.time;
    this.fx.push({ kind: "flash", x: mx, y: my, a: u.turret, t0: this.time, dur: 0.15 });
  }

  updateProjectiles(dt) {
    const keep = [];
    for (const p of this.projectiles) {
      const step = p.speed * dt;
      const x1 = p.x + p.dx * step;
      const y1 = p.y + p.dy * step;
      // 地形：建物・岩で止まる。遮蔽地形を通過した位置を記録
      let blockD = Infinity;
      this.map.walkLine(p.x, p.y, x1, y1, (terr, x, y, dd) => {
        if (terr.cover) p.lastCover = p.travelled + dd;
        if (terr.blocksLos) {
          blockD = dd;
          return true;
        }
        return false;
      }, 1.5);
      let hitU = null;
      let hit = null;
      for (const u of this.units) {
        if (u === p.shooter) continue;
        const h = segmentVsHull(p.x, p.y, x1, y1, u.x, u.y, u.heading, u.halfL, u.halfW);
        if (h && (!hit || h.t < hit.t)) {
          hit = h;
          hitU = u;
        }
      }
      const hitD = hit ? hit.t * step : Infinity;
      if (hitU && hitD <= blockD) {
        this.resolveHit(p, hitU, hit, p.travelled + hitD);
        continue;
      }
      if (blockD < Infinity) {
        this.fx.push({ kind: "dust", x: p.x + p.dx * blockD, y: p.y + p.dy * blockD, t0: this.time, dur: 0.6 });
        continue;
      }
      p.travelled += step;
      this.fx.push({ kind: "tracer", x0: p.x, y0: p.y, x1, y1, t0: this.time, dur: 0.08 });
      p.x = x1;
      p.y = y1;
      if (p.travelled > p.max) {
        this.fx.push({ kind: "dust", x: p.x, y: p.y, t0: this.time, dur: 0.5 });
        continue;
      }
      keep.push(p);
    }
    this.projectiles = keep;
  }

  resolveHit(p, unit, hit, travelled) {
    const ix = p.x + p.dx * (travelled - p.travelled);
    const iy = p.y + p.dy * (travelled - p.travelled);
    if (!unit.alive) {
      this.fx.push({ kind: "dust", x: ix, y: iy, t0: this.time, dur: 0.5 });
      return;
    }
    const shooter = p.shooter;
    const hullDown = travelled - p.lastCover < 25 && hit.face !== "rear";
    let part = "hull";
    let face = hit.face;
    let angle = incidenceAngle(p.dx, p.dy, hit.nx, hit.ny);
    if (hit.face !== "rear" && unit.hasTurret && (hullDown || this.rng() < COMBAT.turretHitShare)) {
      part = "turret";
      const tf = turretFace(p.dx, p.dy, unit.turret);
      face = tf.face;
      angle = tf.angle;
    } else if (hullDown && !unit.hasTurret && this.rng() < 0.5) {
      this.popup(ix, iy, "遮蔽物に命中", "#d8c79a");
      return;
    }
    const armor = unit.tank.armor_mm;
    const thickness = (armor[part] || armor.hull)[face];
    const spaced = part === "hull" && face === "side" ? armor.spaced_side || 0 : 0;
    const res = resolveImpact({
      shell: p.shell,
      caliber: p.caliber,
      thickness,
      spaced,
      angleDeg: angle,
      distance: travelled,
      rng: this.rng,
      weakSpotChance: shooter.stats.weakspot_chance,
    });
    const damage = Math.round(res.damage * shooter.stats.damage_mul);
    unit.lastHitTime = this.time;
    unit.lastHitFrom = shooter;
    unit.lastHitInfo = { part, face, angle: res.angle, eff: res.effArmor, pen: res.pen, result: res.result, thickness };
    shooter.lastShotInfo = unit.lastHitInfo;
    const partName = `${part === "turret" ? "砲塔" : "車体"}${{ front: "前面", side: "側面", rear: "後面" }[face]}`;
    if (res.result === "ricochet") {
      this.popup(ix, iy, "跳弾", "#9fd3ff");
      this.fx.push({ kind: "spark", x: ix, y: iy, t0: this.time, dur: 0.4 });
      if (unit.team === PLAYER) this.emit({ type: "ricochet_made", unit, priority: 1 });
      else if (shooter.team === PLAYER) this.emit({ type: "ricochet_taken", unit: shooter, role: "gunner", priority: 0 });
      this.addLog(`${shooter.label}→${unit.label}：跳弾（${partName} ${res.angle.toFixed(0)}°）`);
    } else if (res.result === "nonpen" && damage <= 0) {
      this.popup(ix, iy, "非貫通", "#e0e0e0");
      this.addLog(`${shooter.label}→${unit.label}：非貫通（${partName} 実効${res.effArmor.toFixed(0)}mm／貫通${res.pen.toFixed(0)}mm）`);
    } else {
      const pen = res.result === "pen";
      this.popup(ix, iy, `${pen ? "貫通" : ""}${res.weakSpot && pen ? "（弱点）" : ""} -${damage}`, pen ? "#ffcf6b" : "#f0a070");
      this.addLog(`${shooter.label}→${unit.label}：${pen ? "貫通" : "HE"} -${damage}（${partName} 実効${res.effArmor.toFixed(0)}mm）`, unit.team === PLAYER ? "bad" : "good");
      unit.hp -= damage;
      if (pen) this.critical(unit, ix, iy);
      if (unit.hp <= 0) this.destroy(unit, shooter);
    }
  }

  critical(u, x, y) {
    if (this.rng() < COMBAT.moduleCritChance) {
      const mods = Object.keys(u.modules).filter((m) => (m !== "turret_ring" || u.hasTurret) && u.modules[m] !== "destroyed");
      if (mods.length) {
        const m = this.rng.pick(mods);
        const next = m === "tracks" || u.modules[m] === "damaged" ? "destroyed" : "damaged";
        u.modules[m] = next;
        if (next === "destroyed") {
          u.repairAt[m] = this.time + (m === "tracks" ? 8 : 12) / u.stats.repair_speed;
          if (m === "tracks" || m === "engine") u.path = [];
          if (m === "ammo") u.hp -= Math.round(Math.max(0, u.hp) * 0.5);
        }
        this.popup(x, y - 6, `${MODULES[m]}${next === "destroyed" ? "破壊" : "損傷"}`, "#ff8f8f");
      }
    }
    if (this.rng() < COMBAT.crewStunChance * (1 - u.stats.stun_resist)) {
      const pool = [];
      u.crewInfo.primary.forEach(({ char, role }) => {
        if (u.stunned[char.id]) return;
        pool.push({ char, w: role === "commander" ? u.stats.commander_stun_mul : 1 });
      });
      const total = pool.reduce((s, p) => s + p.w, 0);
      let r = this.rng() * total;
      for (const p of pool) {
        r -= p.w;
        if (r <= 0) {
          u.stunned[p.char.id] = this.time + 15 / u.stats.stun_recovery;
          u.refreshCrew();
          this.popup(x, y + 8, `${p.char.name} 気絶`, "#ffb0d0");
          if (u.team === PLAYER) this.addLog(`${u.label}：${p.char.name}が気絶`, "bad");
          break;
        }
      }
    }
  }

  destroy(u, killer) {
    u.alive = false;
    u.hp = 0;
    u.path = [];
    u.target = null;
    this.fx.push({ kind: "boom", x: u.x, y: u.y, t0: this.time, dur: 1.2 });
    this.addLog(`${u.label}（${u.team === PLAYER ? "味方" : "敵"}）白旗！`, u.team === PLAYER ? "bad" : "good");
    if (killer?.team === PLAYER) this.emit({ type: "kill", unit: killer, role: "gunner", priority: 3 });
    if (u.team === PLAYER) this.emit({ type: "destroyed", unit: u, priority: 3 });
    if (u.isLeader) {
      u.isLeader = false;
      const cands = this.units.filter((x) => x.team === u.team && x.alive);
      const next = cands.find((x) => x.isSquadLead) || cands[0];
      if (next) {
        next.isLeader = true;
        if (u.team === PLAYER) {
          this.commandFreezeUntil = this.time + 3;
          this.addLog(`指揮を${next.label}に移譲（3秒間は命令できません）`, "warn");
        }
      }
    }
    this.slowUpdate();
  }

  collide() {
    const us = this.units;
    for (let i = 0; i < us.length; i += 1) {
      for (let j = i + 1; j < us.length; j += 1) {
        const a = us[i];
        const b = us[j];
        if (!a.alive && !b.alive) continue;
        const ra = Math.max(a.halfL, a.halfW) * 0.85;
        const rb = Math.max(b.halfL, b.halfW) * 0.85;
        const d = dist(a.x, a.y, b.x, b.y);
        if (d >= ra + rb || d === 0) continue;
        const push = (ra + rb - d) / 2;
        const nx = (b.x - a.x) / d;
        const ny = (b.y - a.y) / d;
        const wa = a.alive ? (b.alive ? 1 : 2) : 0;
        const wb = b.alive ? (a.alive ? 1 : 2) : 0;
        const ax = a.x - nx * push * wa;
        const ay = a.y - ny * push * wa;
        const bx = b.x + nx * push * wb;
        const by = b.y + ny * push * wb;
        if (wa && this.map.isPassableM(ax, ay)) [a.x, a.y] = [ax, ay];
        if (wb && this.map.isPassableM(bx, by)) [b.x, b.y] = [bx, by];
      }
    }
  }

  checkVictory() {
    if (this.result) return;
    const mode = this.scenario.mode || "flag";
    const aliveOf = (t) => this.units.filter((u) => u.team === t && u.alive);
    let winner = null;
    let reason = "";
    if (mode === "flag") {
      for (const t of [PLAYER, ENEMY]) {
        const flag = this.units.find((u) => u.team === t && u.isFlag);
        if (flag && !flag.alive) {
          winner = t === PLAYER ? ENEMY : PLAYER;
          reason = `${t === PLAYER ? "味方" : "敵"}フラッグ車 走行不能`;
        }
      }
    }
    if (!winner) {
      if (!aliveOf(PLAYER).length) {
        winner = ENEMY;
        reason = "味方全車 走行不能";
      } else if (!aliveOf(ENEMY).length) {
        winner = PLAYER;
        reason = "敵全車 走行不能";
      }
    }
    const limit = this.scenario.time_limit_s || 1200;
    if (!winner && this.time >= limit) {
      const hp = (t) => aliveOf(t).reduce((s, u) => s + u.hp, 0);
      winner = hp(PLAYER) >= hp(ENEMY) ? PLAYER : ENEMY;
      reason = "時間切れ（残りHPの合計で判定）";
    }
    if (winner) {
      this.result = { winner, reason, time: this.time };
      this.addLog(`試合終了：${winner === PLAYER ? "勝利" : "敗北"}（${reason}）`, winner === PLAYER ? "good" : "bad");
    }
  }

  // ---------- 演出・ログ ----------
  popup(x, y, text, color) {
    this.fx.push({ kind: "popup", x, y, text, color, t0: this.time, dur: 1.6 });
  }

  addLog(text, kind = "") {
    this.log.push({ t: this.time, text, kind });
    if (this.log.length > 200) this.log.shift();
  }

  emit(ev) {
    if (!ev.unit) return;
    this.events.push({ ...ev, t: this.time });
  }

  // ---------- 一時停止 ----------
  togglePause() {
    if (this.paused) {
      this.paused = false;
      return { ok: true };
    }
    if (this.pauseMode === "none") return { ok: false, reason: "この設定では一時停止できません" };
    if (this.pauseMode === "limited") {
      if (this.pausesLeft <= 0) return { ok: false, reason: "一時停止の回数を使い切りました" };
      this.pausesLeft -= 1;
    }
    this.paused = true;
    return { ok: true };
  }

  // ---------- プレイヤー命令（指揮の伝達遅延あり） ----------
  dispatch(units, fn) {
    const leader = this.leader(PLAYER);
    const delay = leader ? leader.stats.order_delay : 1.5;
    const freeze = Math.max(0, this.commandFreezeUntil - this.time);
    for (const u of units) {
      if (!u.alive) continue;
      const late = !leader || u.component !== leader.component ? delay : 0;
      const wait = Math.max(late, freeze);
      if (wait > 0) {
        this.pending.push({ at: this.time + wait, fn: () => u.alive && fn(u) });
        u.orderPendingUntil = this.time + wait;
      } else fn(u);
    }
    const first = units.find((u) => u.alive);
    if (first) this.emit({ type: "order_ack", unit: first, priority: 0 });
  }

  cmdMove(units, x, y, facing = null, reverse = false) {
    const alive = units.filter((u) => u.alive);
    if (!alive.length) return;
    const cx = alive.reduce((s, u) => s + u.x, 0) / alive.length;
    const cy = alive.reduce((s, u) => s + u.y, 0) / alive.length;
    const dir = facing ?? angleTo(cx, cy, x, y);
    // 複数車輌は移動方向に対して横隊で並べる。並び順は現在の左右位置を保つ
    const rx = -Math.sin(dir);
    const ry = Math.cos(dir);
    const sorted = [...alive].sort((a, b) => a.x * rx + a.y * ry - (b.x * rx + b.y * ry));
    const slots = new Map(sorted.map((u, i) => [u, formationSlot("line", i, sorted.length, x, y, dir, 28)]));
    this.dispatch(alive, (u) => {
      const [sx, sy] = slots.get(u);
      u.manual = true;
      u.moveTo(this.map, sx, sy, { facing, reverse });
    });
  }

  cmdFacing(units, angle) {
    this.dispatch(units, (u) => {
      u.manual = true;
      u.setFacing(wrapAngle(angle));
    });
  }

  cmdRotate(units, delta) {
    this.dispatch(units, (u) => {
      u.manual = true;
      u.setFacing(wrapAngle((u.facing ?? u.heading) + delta));
    });
  }

  cmdStop(units) {
    this.dispatch(units, (u) => {
      u.manual = true;
      u.stop();
    });
  }

  cmdFireMode(units, mode) {
    this.dispatch(units, (u) => {
      u.fireMode = mode;
      if (mode !== "free") u.ambushRange = u.gunRange * 0.6;
    });
  }

  cmdFocus(units, enemy) {
    this.dispatch(units, (u) => {
      u.focus = enemy;
      u.playerFocus = true;
    });
  }

  cmdReturnToSquad(units) {
    this.dispatch(units, (u) => {
      u.manual = false;
      u.facingLock = false;
      u.playerFocus = false;
    });
  }

  /** index = -1 で自動選択に戻す */
  cmdShell(units, index) {
    for (const u of units) {
      if (index < 0) u.shellAuto = true;
      else if (u.tank.gun.shells[index]) {
        u.shellIndex = index;
        u.shellAuto = false;
      }
    }
  }

  cmdAssignSquad(units, squadId) {
    let sq = this.squads.find((s) => s.team === PLAYER && s.id === squadId);
    if (!sq) {
      sq = new Squad(squadId, PLAYER);
      this.squads.push(sq);
      this.squads.sort((a, b) => (a.team === b.team ? a.id - b.id : a.team < b.team ? -1 : 1));
    }
    for (const u of units) {
      const old = this.squadOf(u);
      if (old) old.members = old.members.filter((m) => m !== u);
      sq.members.push(u);
      u.squadId = squadId;
      u.manual = sq.mission.type !== "manual" ? false : u.manual;
    }
    this.squads = this.squads.filter((s) => s.members.length || s.team !== PLAYER);
  }

  cmdSquadMission(squadIds, mission) {
    const squads = this.squads.filter((s) => s.team === PLAYER && squadIds.includes(s.id));
    const units = squads.flatMap((s) => s.alive);
    if (!units.length) return;
    // 分隊任務も無線で届く（分隊長が通信網の外なら遅れる）
    const leader = this.leader(PLAYER);
    for (const sq of squads) {
      const lead = sq.lead;
      const late = !leader || !lead || lead.component !== leader.component ? leader?.stats.order_delay ?? 1.5 : 0;
      const wait = Math.max(late, this.commandFreezeUntil - this.time);
      const apply = () => sq.setMission(mission);
      if (wait > 0) {
        this.pending.push({ at: this.time + wait, fn: apply });
        sq.alive.forEach((u) => (u.orderPendingUntil = this.time + wait));
      } else apply();
    }
    this.emit({ type: "order_ack", unit: squads[0].lead, priority: 0 });
  }

  /** アクティブスキル */
  canUseActive(u, skill) {
    if (!u.alive) return false;
    if ((u.cooldowns[skill.id] || 0) > this.time) return false;
    return u.skillSets.actives.some((a) => a.skill.id === skill.id);
  }

  cmdActive(u, skill) {
    if (!this.canUseActive(u, skill)) return false;
    const entry = u.skillSets.actives.find((a) => a.skill.id === skill.id);
    let targets = [u];
    if (skill.scope === "squad") targets = (this.squadOf(u)?.alive || [u]).filter((m) => m.component === u.component);
    else if (skill.scope === "network") targets = this.units.filter((m) => m.alive && m.team === u.team && m.component === u.component);
    const until = this.time + (skill.duration_s || 10);
    for (const m of targets) {
      m.activeEffects = m.activeEffects.filter((e) => e.skill.id !== skill.id);
      m.activeEffects.push({ skill, until });
      m.refreshCrew();
    }
    u.cooldowns[skill.id] = this.time + (skill.cooldown_s || 60);
    this.emit({ type: "active", unit: u, char: entry.char, skill, priority: 5 });
    this.addLog(`${entry.char.name}：「${skill.name}」発動（${targets.length}輌）`, "good");
    return true;
  }
}
