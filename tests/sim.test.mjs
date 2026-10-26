// 描画なしで試合を回し、例外なく進行して交戦が起きることを確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexData, DATA_FILES } from "../js/data.js";
import { Game, PLAYER, ENEMY } from "../js/game.js";
import { validate } from "../js/validate.js";

function load() {
  const raw = Object.fromEntries(DATA_FILES.map((n) => [n, JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url)))]));
  return indexData(raw);
}

test("データの整合性：シナリオの車輌・乗員・スキルが存在する", () => {
  const d = load();
  for (const sc of Object.values(d.scenarios)) {
    assert.ok(d.maps[sc.map], `map ${sc.map}`);
    for (const team of Object.values(sc.teams)) {
      for (const u of team.units) {
        const tank = d.tanks[u.tank];
        assert.ok(tank, `tank ${u.tank}`);
        assert.equal(u.crew.length, tank.crew_slots.length, `${u.label} の乗員数`);
        for (const c of u.crew) assert.ok(d.characters[c], `char ${c}`);
      }
    }
  }
  for (const c of Object.values(d.characters)) for (const s of c.skills) assert.ok(d.skills[s], `skill ${s} (${c.id})`);
});

test("validate：同梱データにエラーがない", () => {
  const raw = Object.fromEntries(DATA_FILES.map((n) => [n, JSON.parse(readFileSync(new URL(`../data/${n}.json`, import.meta.url)))]));
  const { errors } = validate(raw);
  assert.deepEqual(errors, []);
});

test("試合を4分回す：交戦が起き、例外が出ない", () => {
  const d = load();
  const g = new Game(d, "practice_stgloriana", { seed: 42, difficulty: "normal" });
  // プレイヤー側にも分隊任務を出す
  const [ex, ey] = g.enemySpawnCenter(PLAYER);
  g.cmdSquadMission([1], { type: "assault", x: ex - 200, y: ey });
  g.cmdSquadMission([2], { type: "recon", x: 600, y: 250 });
  for (let i = 0; i < 50 * 240 && !g.result; i += 1) g.step(1 / 50);
  const shots = g.log.filter((l) => l.text.includes("→")).length;
  const alive = (t) => g.units.filter((u) => u.team === t && u.alive).length;
  console.log(`time=${g.time.toFixed(0)}s shots=${shots} aliveA=${alive(PLAYER)} aliveB=${alive(ENEMY)} result=${JSON.stringify(g.result)}`);
  console.log(g.log.slice(-12).map((l) => `${l.t.toFixed(1)} ${l.text}`).join("\n"));
  assert.ok(shots > 0, "一度も被弾が起きていない");
});
