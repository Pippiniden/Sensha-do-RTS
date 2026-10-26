// 敵の隊長AI。敵も分隊単位で動き、隊長が分隊任務を出し直す。
import { dist } from "./util.js";

export class EnemyCommander {
  constructor(game, team, config = {}) {
    this.game = game;
    this.team = team;
    this.config = { aggression: 0.5, ...config };
    this.nextThink = 2;
    this.lastContact = -999;
  }

  update(now) {
    if (now < this.nextThink) return;
    this.nextThink = now + 3;
    const g = this.game;
    const squads = g.squads.filter((s) => s.team === this.team && s.alive.length);
    if (!squads.length) return;
    const mine = squads.flatMap((s) => s.alive);
    const known = g.knownEnemiesForTeamUnits(mine);
    const lastSeen = g.teamLastSeen(this.team);
    if (known.length) this.lastContact = now;

    for (const sq of squads) {
      const role = sq.aiRole || "assault";
      const c = sq.center();
      if (!c) continue;
      // 目標：見えている敵、なければ最後に見た位置、なければ相手の初期位置
      let tx;
      let ty;
      const pool = known.length ? known : lastSeen;
      if (pool.length) {
        let best = pool[0];
        for (const e of pool) if (dist(c[0], c[1], e.x, e.y) < dist(c[0], c[1], best.x, best.y)) best = e;
        tx = best.x;
        ty = best.y;
      } else {
        [tx, ty] = (g.scenario.objective_points?.[this.team] || [])[0] || g.enemySpawnCenter(this.team);
      }
      const hpFrac = sq.alive.reduce((s, u) => s + u.hp / u.maxHp, 0) / sq.alive.length;
      if (role === "flag") {
        if (sq.mission.type !== "defend") sq.setMission({ type: "defend", x: c[0], y: c[1] });
      } else if (role === "recon") {
        if (!known.length && sq.mission.type !== "recon") sq.setMission({ type: "recon", x: tx, y: ty });
        else if (known.length && sq.mission.type === "manual") sq.setMission({ type: "defend", x: c[0], y: c[1] });
      } else if (hpFrac < 0.35 && this.config.aggression < 0.8) {
        const home = g.spawnCenter(this.team);
        if (sq.mission.type !== "withdraw") sq.setMission({ type: "withdraw", x: home[0], y: home[1] });
      } else {
        // 突撃役：情報がある時だけ前進。慎重な隊長は最初は防御で待つ
        const waitFirst = this.config.aggression < 0.5 && now < 60 && !known.length;
        if (waitFirst) {
          if (sq.mission.type !== "defend") sq.setMission({ type: "defend", x: c[0], y: c[1] });
        } else if (sq.mission.type !== "assault" || dist(sq.mission.x, sq.mission.y, tx, ty) > 120) {
          sq.setMission({ type: "assault", x: tx, y: ty });
        }
      }
    }
  }
}
