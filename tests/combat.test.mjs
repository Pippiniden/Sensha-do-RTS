// node --test tests/ で実行
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRicochet, normalizedAngle, effectiveArmor, resolveImpact, segmentVsHull, incidenceAngle, turretFace, penetrationAt } from "../js/combat.js";

const near = (a, b, eps = 0.5) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("跳弾角：AP/APCRは70°以上、HEATは85°超、HEは跳弾しない", () => {
  assert.equal(isRicochet("AP", 75, 50, 69.9), false);
  assert.equal(isRicochet("AP", 75, 50, 70), true);
  assert.equal(isRicochet("APCR", 75, 50, 72), true);
  assert.equal(isRicochet("HEAT", 75, 50, 85), false);
  assert.equal(isRicochet("HEAT", 75, 50, 85.1), true);
  assert.equal(isRicochet("HE", 75, 50, 89), false);
});

test("3倍口径ルール：口径が装甲の3倍を超えると跳弾しない", () => {
  assert.equal(isRicochet("AP", 152, 51, 80), true);
  assert.equal(isRicochet("AP", 152, 50, 80), false);
  assert.equal(isRicochet("HEAT", 152, 20, 88), true);
});

test("正規化：AP 5°、APCR 2°、2倍口径で増加", () => {
  near(normalizedAngle("AP", 75, 100, 40), 35, 0.01);
  near(normalizedAngle("APCR", 75, 100, 40), 38, 0.01);
  near(normalizedAngle("HEAT", 75, 100, 40), 40, 0.01);
  // 90mm で 45mm：5*1.4*2 = 14°
  near(normalizedAngle("AP", 90, 45, 40), 26, 0.01);
});

test("仕様書の計算例：100mmを40°で受けると約122mm、50mmを50°で約71mm", () => {
  near(effectiveArmor("AP", 100, normalizedAngle("AP", 75, 100, 40)), 122.1);
  near(effectiveArmor("AP", 50, normalizedAngle("AP", 75, 50, 50)), 70.7);
});

test("増加装甲はHEATにだけ加算", () => {
  near(effectiveArmor("AP", 30, 0, 10), 30, 0.01);
  near(effectiveArmor("HEAT", 30, 0, 10), 40, 0.01);
});

test("距離減衰：APは500mで10%減、HEATは減らない", () => {
  near(penetrationAt(100, "AP", 500), 90, 0.01);
  near(penetrationAt(100, "HEAT", 500), 100, 0.01);
  near(penetrationAt(100, "AP", 50), 100, 0.01);
});

test("resolveImpact：十分な貫通力なら貫通、跳弾角なら跳弾", () => {
  const rng = () => 0.5; // 乱数中央（弱点なし）
  const shell = { type: "AP", pen_mm: 150, damage: 100 };
  assert.equal(resolveImpact({ shell, caliber: 75, thickness: 80, angleDeg: 10, distance: 100, rng }).result, "pen");
  assert.equal(resolveImpact({ shell, caliber: 75, thickness: 80, angleDeg: 75, distance: 100, rng }).result, "ricochet");
  assert.equal(resolveImpact({ shell: { ...shell, pen_mm: 60 }, caliber: 75, thickness: 80, angleDeg: 0, distance: 100, rng }).result, "nonpen");
});

test("車体矩形との交差：正面から撃つと前面、真横からは側面", () => {
  // 車体は原点、前方 +x、長さ6m 幅3m
  const front = segmentVsHull(20, 0, -20, 0, 0, 0, 0, 3, 1.5);
  assert.equal(front.face, "front");
  near(incidenceAngle(-40, 0, front.nx, front.ny), 0, 0.01);
  const side = segmentVsHull(0, 20, 0, -20, 0, 0, 0, 3, 1.5);
  assert.equal(side.face, "side");
  const rear = segmentVsHull(-20, 0.5, 20, 0.5, 0, 0, 0, 3, 1.5);
  assert.equal(rear.face, "rear");
  // 車体を40°振って正面から前面板の中央を撃つ
  const fy = 3 * Math.sin(40 * Math.PI / 180);
  const angled = segmentVsHull(30, fy, -30, fy, 0, 0, 40 * Math.PI / 180, 3, 1.5);
  assert.equal(angled.face, "front");
  near(incidenceAngle(-60, 0, angled.nx, angled.ny), 40, 0.01);
  // 細長い車体を40°振ると、中心を狙った弾は側面に当たる（角の角度 26.6° < 40°）
  const center = segmentVsHull(30, 0, -30, 0, 0, 0, 40 * Math.PI / 180, 3, 1.5);
  assert.equal(center.face, "side");
  near(incidenceAngle(-60, 0, center.nx, center.ny), 50, 0.01);
  assert.equal(segmentVsHull(20, 10, -20, 10, 0, 0, 0, 3, 1.5), null);
});

test("砲塔の被弾面", () => {
  // 砲塔が +x を向き、弾は +x 側から飛んでくる（進行方向 -x）
  assert.equal(turretFace(-1, 0, 0).face, "front");
  assert.equal(turretFace(1, 0, 0).face, "rear");
  const s = turretFace(0, -1, 0);
  assert.equal(s.face, "side");
  near(s.angle, 0, 0.01);
});
