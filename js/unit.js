// 戦車ユニット：移動・旋回・照準・状態異常
import { DEG, angleDiff, angleTo, dist, rotateToward, wrapAngle, uid } from "./util.js";
import { crewProficiency, collectSkills, computeStats } from "./stats.js";

export const MODULES = {
  tracks: "履帯",
  gun: "主砲",
  engine: "エンジン",
  ammo: "弾薬庫",
  turret_ring: "砲塔旋回装置",
};

export class Unit {
  constructor({ team, tank, crew, x, y, heading, skillsById, flags = {} }) {
    this.id = uid("t");
    this.team = team;
    this.tank = tank;
    this.crew = crew; // tank.crew_slots と同じ並び。null は空席
    this.skillsById = skillsById;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.turret = heading;
    this.hp = tank.hp;
    this.maxHp = tank.hp;
    this.alive = true;
    this.isLeader = !!flags.leader;
    this.isFlag = !!flags.flag;
    this.isSquadLead = false;
    this.squadId = flags.squad ?? 1;
    this.hasTurret = tank.turret !== false && tank.gun.arc_deg == null;
    this.halfL = tank.size_m.length / 2;
    this.halfW = tank.size_m.width / 2;

    this.modules = { tracks: "ok", gun: "ok", engine: "ok", ammo: "ok", turret_ring: "ok" };
    this.repairAt = {};
    this.stunned = {}; // charId -> 回復時刻
    this.activeEffects = []; // {skill, until}
    this.cooldowns = {}; // skillId -> 使用可能になる時刻

    // 移動
    this.path = [];
    this.goal = null;
    this.facing = null; // 停止後に向ける車体角度
    this.facingLock = false; // プレイヤーが向きを指定した
    this.reverse = false;
    this.speedNow = 0;
    this.hullRotRate = 0;
    this.turretRotRate = 0;
    this.lastMoved = -99;

    // 射撃
    this.shellIndex = 0;
    this.reloadLeft = 0;
    this.disp = 2.5;
    this.target = null; // Unit
    this.focus = null; // 集中射撃目標
    this.fireMode = "free"; // free | hold | ambush
    this.ambushRange = 300;
    this.lastFired = -99;
    this.aimStart = 0;
    this.lastHitTime = -99;
    this.lastHitFrom = null;
    this.autoAngle = true;

    // 指揮
    this.manual = false; // 個別命令中（分隊任務の自動操作を受けない）
    this.component = 0;
    this.spottedSince = null; // 敵に発見され始めた時刻
    this.sixthSenseShown = false;
    this.knownBySelf = new Set();
    this.events = [];

    this.refreshCrew(0);
  }

  get gunRange() {
    return this.tank.gun.range_m || 600;
  }

  get shell() {
    const shells = this.tank.gun.shells;
    return shells[Math.min(this.shellIndex, shells.length - 1)];
  }

  get commander() {
    return this.crewInfo.roleChar.commander || this.crew.find(Boolean) || null;
  }

  /** 乗員の構成・気絶が変わったら呼ぶ */
  refreshCrew() {
    this.crewInfo = crewProficiency(this.tank, this.crew, this.stunned);
    this.skillSets = collectSkills(this, this.skillsById);
    this.stats = computeStats(this, this.auras || []);
  }

  recomputeStats(auras) {
    this.auras = auras;
    this.skillSets = collectSkills(this, this.skillsById);
    this.stats = computeStats(this, auras);
  }

  isMoving(now) {
    return now - this.lastMoved < 0.5;
  }

  canMove() {
    return this.alive && this.modules.tracks !== "destroyed" && this.modules.engine !== "destroyed";
  }

  /** 移動命令 */
  moveTo(map, x, y, { facing = null, reverse = false } = {}) {
    this.path = map.findPath(this.x, this.y, x, y);
    this.goal = this.path.length ? this.path[this.path.length - 1] : [x, y];
    this.facing = facing;
    this.facingLock = facing !== null;
    this.reverse = reverse;
  }

  stop() {
    this.path = [];
    this.goal = null;
    this.facing = null;
    this.facingLock = false;
  }

  setFacing(angle) {
    this.path = [];
    this.goal = null;
    this.facing = angle;
    this.facingLock = true;
  }

  update(dt, now, map) {
    if (!this.alive) return;
    this.updateMovement(dt, now, map);
    this.updateTurret(dt);
    this.updateAim(dt);
    if (this.reloadLeft > 0) this.reloadLeft -= dt;
    this.updateStatus(now);
  }

  updateMovement(dt, now, map) {
    const s = this.stats;
    const terr = map.terrainAtM(this.x, this.y);
    const prevHeading = this.heading;
    let speed = 0;
    if (this.path.length && this.canMove()) {
      const [wx, wy] = this.path[0];
      const d = dist(this.x, this.y, wx, wy);
      if (d < (this.path.length > 1 ? 6 : 2.5)) {
        this.path.shift();
      } else {
        // 最終地点が近く後方なら後進する
        const toward = angleTo(this.x, this.y, wx, wy);
        const reverse = this.reverse || (this.path.length === 1 && d < 60 && Math.abs(angleDiff(this.heading, toward)) > 120 * DEG);
        const desired = reverse ? wrapAngle(toward + Math.PI) : toward;
        const turnRate = s.hull_traverse * (terr.turn || 1);
        this.heading = rotateToward(this.heading, desired, turnRate * dt);
        const off = Math.abs(angleDiff(this.heading, desired));
        if (off < 30 * DEG) {
          let v = (reverse ? s.speed_rev : s.speed_fwd) * terr.speed;
          if (this.modules.engine === "damaged") v *= 0.5;
          v *= Math.cos(off);
          // 最後の地点では減速
          if (this.path.length === 1) v = Math.min(v, Math.max(2, d * 1.5));
          const dir = reverse ? -1 : 1;
          const nx = this.x + Math.cos(this.heading) * v * dt * dir;
          const ny = this.y + Math.sin(this.heading) * v * dt * dir;
          if (map.isPassableM(nx, ny)) {
            this.x = nx;
            this.y = ny;
            speed = v;
          } else {
            // 引っかかったら経路を引き直す
            if (this.goal) this.path = map.findPath(this.x, this.y, this.goal[0], this.goal[1]);
          }
        }
      }
      if (!this.path.length) this.goal = null;
    } else if (this.facing !== null && this.canMove()) {
      this.heading = rotateToward(this.heading, this.facing, s.hull_traverse * (terr.turn || 1) * dt);
      if (Math.abs(angleDiff(this.heading, this.facing)) < 0.5 * DEG) {
        this.heading = this.facing;
        if (!this.facingLock) this.facing = null;
      }
    }
    this.speedNow = speed;
    this.hullRotRate = Math.abs(angleDiff(prevHeading, this.heading)) / Math.max(dt, 1e-6);
    if (speed > 0.3 || this.hullRotRate > 2 * DEG) this.lastMoved = now;
  }

  /** 砲の向き。砲塔のない車輌は射界内で動かし、外れる場合は向きの希望を出す */
  updateTurret(dt) {
    const prev = this.turret;
    let rate = this.stats.turret_traverse;
    if (this.modules.turret_ring === "damaged") rate *= 0.5;
    if (this.modules.turret_ring === "destroyed") rate = 0;
    let desired;
    if (this.target && this.target.alive) desired = angleTo(this.x, this.y, this.target.x, this.target.y);
    else desired = this.heading;
    if (this.hasTurret) {
      this.turret = rotateToward(this.turret, desired, rate * dt);
    } else {
      const arc = (this.tank.gun.arc_deg ?? 10) * DEG;
      const rel = Math.max(-arc, Math.min(arc, angleDiff(this.heading, desired)));
      // 車体の回転には追従し、射界内は砲旋回速度で動く
      const curRel = Math.max(-arc, Math.min(arc, angleDiff(this.heading, this.turret)));
      const newRel = curRel + Math.sign(rel - curRel) * Math.min(Math.abs(rel - curRel), rate * dt);
      this.turret = wrapAngle(this.heading + newRel);
    }
    this.turretRotRate = Math.abs(angleDiff(prev, this.turret)) / Math.max(dt, 1e-6);
  }

  /** 照準円：移動・旋回で広がり、照準時間で収縮（仕様書 5.1） */
  updateAim(dt) {
    const s = this.stats;
    const bloom =
      (this.speedNow / Math.max(1, s.speed_fwd)) * 1.5 +
      (this.hullRotRate / Math.max(0.01, s.hull_traverse)) * 1.0 +
      (this.turretRotRate / Math.max(0.01, s.turret_traverse)) * 0.5;
    if (1 + bloom > this.disp) {
      this.disp = 1 + bloom;
      this.aimStart = 0;
    }
    this.disp = 1 + (this.disp - 1) * Math.exp(-dt / Math.max(0.3, s.aim_time));
    this.aimStart += dt;
  }

  /** 現在の照準円半径(m)。距離 d における値 */
  aimRadius(d, selfSpotted = true) {
    let r = this.stats.dispersion * (d / 100) * this.disp;
    if (this.modules.gun === "damaged") r *= 1.5;
    if (!selfSpotted) r *= 1.2;
    return r;
  }

  turretAligned() {
    if (!this.target) return false;
    const desired = angleTo(this.x, this.y, this.target.x, this.target.y);
    return Math.abs(angleDiff(this.turret, desired)) < 1.5 * DEG;
  }

  reloadTime() {
    let r = this.stats.reload;
    if (this.modules.ammo === "damaged") r *= 1.5;
    if (this.modules.ammo === "destroyed") r *= 2;
    return r;
  }

  /** 気絶回復・モジュール修理・アクティブ効果の期限 */
  updateStatus(now) {
    let crewChanged = false;
    for (const [cid, until] of Object.entries(this.stunned)) {
      if (now >= until) {
        delete this.stunned[cid];
        crewChanged = true;
      }
    }
    for (const [m, at] of Object.entries(this.repairAt)) {
      if (now >= at) {
        delete this.repairAt[m];
        if (this.modules[m] === "destroyed") this.modules[m] = m === "tracks" ? "ok" : "damaged";
        this.events.push({ type: "repaired", module: m });
      }
    }
    const before = this.activeEffects.length;
    this.activeEffects = this.activeEffects.filter((e) => e.until > now);
    if (crewChanged || before !== this.activeEffects.length) this.refreshCrew();
  }
}
