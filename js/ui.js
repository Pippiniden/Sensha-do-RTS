// 入力とHUD（部隊リスト・選択パネル・カットイン・ログ）
import { angleTo, DEG } from "./util.js";
import { PLAYER } from "./game.js";
import { MISSIONS } from "./squad.js";
import { MODULES } from "./unit.js";
import { ROLE_NAMES, parseSlot } from "./stats.js";
import { portraitEl, updatePortrait, pickLine, EVENT_EXPR } from "./portrait.js";

const CUTIN_TYPES = new Set(["active", "flag_spotted", "kill", "destroyed"]);
const FIRE_MODES = { free: "自由射撃", ambush: "待ち伏せ", hold: "射撃禁止" };

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class UI {
  constructor(game, renderer, settings) {
    this.game = game;
    this.r = renderer;
    this.settings = settings;
    this.selected = [];
    this.drag = null;
    this.missionMode = null;
    this.keys = new Set();
    this.cutin = null;
    this.charCooldown = {};
    this.speech = new Map(); // unitId -> {text, until}
    this.lastSquadKey = { n: 0, t: 0 };
    this.listSig = "";
    this.panelSig = "";
    this.slowUntil = 0;
    this.logCount = 0;
    this.bind();
  }

  // ---------- 入力 ----------
  bind() {
    const cv = this.r.canvas;
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("mousedown", (e) => {
      const p = this.pos(e);
      this.drag = { button: e.button, sx: p[0], sy: p[1], cx: p[0], cy: p[1], moved: false, cam: { ...this.r.cam } };
    });
    window.addEventListener("mousemove", (e) => {
      const p = this.pos(e);
      this.mouse = p;
      if (!this.drag) return this.hover(p);
      const d = this.drag;
      d.cx = p[0];
      d.cy = p[1];
      if (Math.hypot(d.cx - d.sx, d.cy - d.sy) > 6) d.moved = true;
      if (d.button === 1) {
        this.r.cam.x = d.cam.x - (d.cx - d.sx) / this.r.cam.zoom;
        this.r.cam.y = d.cam.y - (d.cy - d.sy) / this.r.cam.zoom;
        this.r.clampCam();
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (d.button === 0) this.leftRelease(d, e);
      else if (d.button === 2) this.rightRelease(d, e);
    });
    cv.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = this.pos(e);
        const before = this.r.toWorld(p[0], p[1]);
        this.r.cam.zoom *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.r.clampCam();
        const after = this.r.toWorld(p[0], p[1]);
        this.r.cam.x += before[0] - after[0];
        this.r.cam.y += before[1] - after[1];
        this.r.clampCam();
      },
      { passive: false },
    );
    this.r.minimap.addEventListener("mousedown", (e) => {
      const rect = this.r.minimap.getBoundingClientRect();
      this.r.cam.x = ((e.clientX - rect.left) / rect.width) * this.game.map.widthM;
      this.r.cam.y = ((e.clientY - rect.top) / rect.height) * this.game.map.heightM;
      this.r.clampCam();
    });
    window.addEventListener("keydown", (e) => this.keyDown(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    $("#btn-pause").onclick = () => this.togglePause();
    document.querySelectorAll("[data-speed]").forEach((b) => {
      b.onclick = () => this.setSpeed(Number(b.dataset.speed));
    });
    $("#btn-help").onclick = () => $("#help").classList.toggle("hidden");
    $("#help").onclick = () => $("#help").classList.add("hidden");
  }

  pos(e) {
    const rect = this.r.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  ownAt(sx, sy) {
    return this.r.unitAt(sx, sy, (u) => u.team === PLAYER && u.alive);
  }

  enemyAt(sx, sy) {
    return this.r.unitAt(sx, sy, (u) => u.team !== PLAYER && u.alive && ["visible", "linger"].includes(this.game.enemyDisplay(u)));
  }

  leftRelease(d, e) {
    if (this.missionMode) return;
    if (d.moved) {
      const [x0, y0] = this.r.toWorld(Math.min(d.sx, d.cx), Math.min(d.sy, d.cy));
      const [x1, y1] = this.r.toWorld(Math.max(d.sx, d.cx), Math.max(d.sy, d.cy));
      const inBox = this.game.units.filter((u) => u.team === PLAYER && u.alive && u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1);
      this.select(e.shiftKey ? [...new Set([...this.selected, ...inBox])] : inBox);
      return;
    }
    const u = this.ownAt(d.sx, d.sy);
    if (u) {
      if (e.shiftKey) this.select(this.selected.includes(u) ? this.selected.filter((x) => x !== u) : [...this.selected, u]);
      else this.select([u]);
    } else if (!e.shiftKey) this.select([]);
  }

  rightRelease(d, e) {
    const [wx, wy] = this.r.toWorld(d.sx, d.sy);
    const [ex, ey] = this.r.toWorld(d.cx, d.cy);
    const facing = d.moved ? angleTo(wx, wy, ex, ey) : null;
    if (this.missionMode) {
      const mm = this.missionMode;
      this.missionMode = null;
      if (mm.type === "follow") {
        const target = this.ownAt(d.sx, d.sy);
        const ts = target && this.game.squadOf(target);
        if (!ts || mm.squadIds.includes(ts.id)) return this.toast("追従先の分隊の車輌を右クリックしてください");
        this.game.cmdSquadMission(mm.squadIds, { type: "follow", followSquadId: ts.id });
        return;
      }
      this.game.cmdSquadMission(mm.squadIds, { type: mm.type, x: wx, y: wy, facing });
      return;
    }
    const sel = this.selected.filter((u) => u.alive);
    if (!sel.length) return;
    if (!d.moved) {
      const enemy = this.enemyAt(d.sx, d.sy);
      if (enemy) {
        this.game.cmdFocus(sel, enemy);
        this.game.popup(enemy.x, enemy.y, "集中射撃", "#ffd27a");
        return;
      }
    }
    this.game.cmdMove(sel, wx, wy, facing, e.ctrlKey || e.metaKey);
  }

  keyDown(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    const sel = this.selected.filter((u) => u.alive);
    if (k === " ") {
      e.preventDefault();
      this.togglePause();
    } else if (k === "escape") {
      if (this.missionMode) this.missionMode = null;
      else this.select([]);
      $("#help").classList.add("hidden");
    } else if (/^[1-9]$/.test(k)) {
      const n = Number(k);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (sel.length) {
          this.game.cmdAssignSquad(sel, n);
          this.toast(`${sel.length}輌を第${n}分隊に編入`);
        }
      } else {
        const sq = this.game.squads.find((s) => s.team === PLAYER && s.id === n);
        if (sq) {
          this.select(sq.alive);
          const now = performance.now();
          if (this.lastSquadKey.n === n && now - this.lastSquadKey.t < 350) this.centerOn(sq.alive);
          this.lastSquadKey = { n, t: now };
        }
      }
    } else if (k === "s") this.game.cmdStop(sel);
    else if (k === "h") {
      const order = ["free", "ambush", "hold"];
      const cur = sel[0]?.fireMode || "free";
      const next = order[(order.indexOf(cur) + 1) % order.length];
      this.game.cmdFireMode(sel, next);
      this.toast(`射撃：${FIRE_MODES[next]}`);
    } else if (k === "q") this.game.cmdRotate(sel, -15 * DEG);
    else if (k === "e") this.game.cmdRotate(sel, 15 * DEG);
    else if (k === "z") this.game.cmdReturnToSquad(sel);
    else if (k === "+" || k === "=") this.setSpeed(Math.min(2, this.game.speed * 2));
    else if (k === "-") this.setSpeed(Math.max(0.5, this.game.speed / 2));
    else if (k === "?" || k === "f1") {
      e.preventDefault();
      $("#help").classList.toggle("hidden");
    } else {
      const m = Object.entries(MISSIONS).find(([, v]) => v.key === k);
      if (m) this.startMission(m[0]);
    }
  }

  startMission(type) {
    const squadIds = [...new Set(this.selected.filter((u) => u.alive).map((u) => u.squadId))];
    if (!squadIds.length) return this.toast("分隊の車輌を選択してから任務を出してください");
    if (type === "manual") {
      this.game.cmdSquadMission(squadIds, { type: "manual" });
      return;
    }
    this.missionMode = { type, name: MISSIONS[type].name, squadIds };
  }

  select(units) {
    this.selected = units;
    this.panelSig = "";
  }

  centerOn(units) {
    if (!units.length) return;
    this.r.cam.x = units.reduce((s, u) => s + u.x, 0) / units.length;
    this.r.cam.y = units.reduce((s, u) => s + u.y, 0) / units.length;
    this.r.clampCam();
  }

  togglePause() {
    const res = this.game.togglePause();
    if (!res.ok) this.toast(res.reason);
  }

  setSpeed(s) {
    this.game.speed = s;
  }

  hover(p) {
    const tip = $("#tooltip");
    const enemy = this.enemyAt(p[0], p[1]);
    const own = !enemy && this.ownAt(p[0], p[1]);
    const u = enemy || own;
    if (!u) {
      tip.classList.add("hidden");
      return;
    }
    const info = this.game.units.some((x) => x.team === PLAYER && x.alive && x.stats.flags.has("enemy_armor_info"));
    const a = u.tank.armor_mm;
    let html = `<b>${u.label}</b>（${u.tank.name}）`;
    if (own || info) {
      html += `<br>車体 ${a.hull.front}/${a.hull.side}/${a.hull.rear}mm`;
      if (u.hasTurret) html += `　砲塔 ${a.turret.front}/${a.turret.side}/${a.turret.rear}mm`;
      if (enemy) html += `<br><span class="dim">戦車マニアの情報</span>`;
    } else html += `<br><span class="dim">装甲不明（右クリックで集中射撃）</span>`;
    tip.innerHTML = html;
    tip.style.left = `${p[0] + 16}px`;
    tip.style.top = `${p[1] + 60}px`;
    tip.classList.remove("hidden");
  }

  toast(text) {
    const t = $("#toast");
    t.textContent = text;
    t.classList.remove("hidden");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
  }

  // ---------- 毎フレーム ----------
  frame(dtReal) {
    const pan = 500 / this.r.cam.zoom;
    const k = this.keys;
    // カメラ移動は矢印キー（文字キーは命令に使う）
    if (k.has("arrowup")) this.r.cam.y -= pan * dtReal;
    if (k.has("arrowdown")) this.r.cam.y += pan * dtReal;
    if (k.has("arrowleft")) this.r.cam.x -= pan * dtReal;
    if (k.has("arrowright")) this.r.cam.x += pan * dtReal;
    this.r.clampCam();
    this.selected = this.selected.filter((u) => u.alive);
    this.handleEvents();
    this.updateTopbar();
    this.updateList();
    this.updatePanel();
    this.updateLog();
    this.updateCutin();
  }

  handleEvents() {
    const g = this.game;
    const data = g.data;
    for (const ev of g.events.splice(0)) {
      const u = ev.unit;
      if (!u || u.team !== PLAYER) continue;
      let char = ev.char;
      if (!char && ev.role) char = u.crewInfo.roleChar[ev.role];
      if (!char) char = u.commander;
      if (!char) continue;
      const line = pickLine(data.lines, char.id, ev.type);
      if (!line) continue;
      const now = performance.now() / 1000;
      if (CUTIN_TYPES.has(ev.type)) {
        if ((this.charCooldown[char.id] || 0) > now && ev.type !== "active") continue;
        if (this.cutin && this.cutin.until > now && this.cutin.priority > ev.priority) continue;
        this.charCooldown[char.id] = now + 10;
        this.showCutin(char, EVENT_EXPR[ev.type], line, ev.priority, u);
      } else {
        this.speech.set(u.id, { text: line.text, until: now + 2.8, char });
        this.playVoice(line);
      }
    }
  }

  playVoice(line) {
    if (!this.settings.voice || !line?.voice) return;
    try {
      new Audio(line.voice).play().catch(() => {});
    } catch {
      /* 何もしない */
    }
  }

  showCutin(char, expr, line, priority, unit) {
    const now = performance.now() / 1000;
    this.cutin = { until: now + 1.6, priority };
    const box = $("#cutin");
    box.innerHTML = "";
    box.appendChild(portraitEl(char, expr, 64));
    const t = el("div", "cutin-text");
    t.appendChild(el("div", "cutin-name", `${char.name}（${unit.label}）`));
    t.appendChild(el("div", "cutin-line", `「${line.text}」`));
    box.appendChild(t);
    box.classList.remove("show");
    void box.offsetWidth;
    box.classList.add("show");
    if (this.settings.cutinSlow) this.slowUntil = now + 0.3;
    this.playVoice(line);
  }

  updateCutin() {
    const now = performance.now() / 1000;
    if (this.cutin && this.cutin.until < now) {
      $("#cutin").classList.remove("show");
      this.cutin = null;
    }
  }

  updateTopbar() {
    const g = this.game;
    const t = Math.floor(g.time);
    const limit = g.scenario.time_limit_s || 1200;
    const left = Math.max(0, limit - t);
    $("#clock").textContent = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}（残り ${Math.floor(left / 60)}分）`;
    let ps = g.paused ? "一時停止中" : "";
    if (g.pauseMode === "limited") ps += `　一時停止 残り${g.pausesLeft}回`;
    if (g.pauseMode === "none") ps += "　一時停止なし";
    $("#pause-state").textContent = ps;
    $("#btn-pause").textContent = g.paused ? "▶ 再開" : "⏸ 一時停止";
    document.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === g.speed));
    document.body.classList.toggle("paused", g.paused);
  }

  // ---------- 部隊リスト ----------
  updateList() {
    const g = this.game;
    const squads = g.squads.filter((s) => s.team === PLAYER);
    const sig = squads.map((s) => `${s.id}:${s.members.map((u) => u.id).join(",")}`).join("|");
    const root = $("#unit-list");
    if (sig !== this.listSig) {
      this.listSig = sig;
      root.innerHTML = "";
      this.rows = new Map();
      this.squadHeads = new Map();
      for (const sq of squads) {
        const box = el("div", "squad");
        const head = el("div", "squad-head");
        head.onclick = () => this.select(sq.alive);
        head.ondblclick = () => this.centerOn(sq.alive);
        box.appendChild(head);
        this.squadHeads.set(sq.id, head);
        for (const u of sq.members) {
          const row = el("div", "unit-row");
          const por = portraitEl(u.commander, "normal", 34);
          row.appendChild(por);
          const mid = el("div", "unit-mid");
          mid.appendChild(el("div", "unit-name", u.label));
          const bar = el("div", "hpbar");
          bar.appendChild(el("div", "hpfill"));
          mid.appendChild(bar);
          mid.appendChild(el("div", "unit-icons"));
          row.appendChild(mid);
          row.appendChild(el("div", "speech hidden"));
          row.onclick = (e) => {
            if (!u.alive) return;
            if (e.shiftKey) this.select([...new Set([...this.selected, u])]);
            else this.select([u]);
          };
          row.ondblclick = () => this.centerOn([u]);
          box.appendChild(row);
          this.rows.set(u.id, { row, por, u });
        }
        root.appendChild(box);
      }
    }
    for (const sq of squads) {
      const head = this.squadHeads.get(sq.id);
      const m = MISSIONS[sq.mission.type];
      head.innerHTML = `<span class="sq-no">${sq.id}</span> ${sq.name} <span class="mission m-${sq.mission.type}">${m.name}</span>${sq.contact && sq.mission.type !== "manual" ? '<span class="contact">接敵</span>' : ""}`;
    }
    const now = performance.now() / 1000;
    for (const { row, por, u } of this.rows.values()) {
      row.classList.toggle("sel", this.selected.includes(u));
      row.classList.toggle("dead", !u.alive);
      row.querySelector(".hpfill").style.width = `${(100 * Math.max(0, u.hp)) / u.maxHp}%`;
      updatePortrait(por, u.commander, this.exprFor(u));
      const icons = [];
      if (u.isLeader) icons.push("★隊長");
      if (u.isFlag) icons.push("⚑");
      if (u.manual && this.game.squadOf(u)?.mission.type !== "manual") icons.push("個別");
      icons.push(FIRE_MODES[u.fireMode]);
      if (!u.alive) icons.push("白旗");
      if (u.modules.tracks === "destroyed") icons.push("履帯");
      if (Object.keys(u.stunned).length) icons.push("気絶");
      if (u.sixthSenseShown && u.spottedSince !== null && u.alive) icons.push("👁被発見");
      const leader = this.game.leader(PLAYER);
      if (u.alive && leader && u.component !== leader.component) icons.push("通信圏外");
      row.querySelector(".unit-icons").textContent = icons.join(" ");
      const sp = this.speech.get(u.id);
      const spEl = row.querySelector(".speech");
      if (sp && sp.until > now) {
        spEl.textContent = sp.text;
        spEl.classList.remove("hidden");
      } else spEl.classList.add("hidden");
    }
  }

  exprFor(u) {
    if (!u.alive) return "stunned";
    const c = u.commander;
    if (c && u.stunned[c.id]) return "stunned";
    if (this.game.time - u.lastHitTime < 1.5) return "surprised";
    if (u.hp / u.maxHp < 0.3) return "serious";
    return "normal";
  }

  // ---------- 選択パネル ----------
  updatePanel() {
    const sel = this.selected;
    const p = $("#panel");
    const u = sel[0];
    const sig = sel.map((x) => x.id).join(",");
    if (sig !== this.panelSig) {
      this.panelSig = sig;
      this.buildPanel(p, sel);
    }
    if (!u) return;
    // 動的部分
    updatePortrait(p.querySelector(".big-portrait"), u.commander, this.exprFor(u));
    p.querySelector(".hp-text").textContent = `HP ${Math.max(0, Math.round(u.hp))} / ${u.maxHp}`;
    const reload = u.reloadLeft > 0 ? `装填中 ${u.reloadLeft.toFixed(1)}秒` : "装填完了";
    p.querySelector(".gun-text").textContent = `${u.shell.type} 貫通${u.shell.pen_mm}mm ダメージ${u.shell.damage}　${reload}　照準 ×${u.disp.toFixed(2)}`;
    p.querySelectorAll(".crew-cell").forEach((c) => {
      const ch = u.crew[Number(c.dataset.slot)];
      c.classList.toggle("stunned", !!(ch && u.stunned[ch.id]));
    });
    p.querySelector(".modules").innerHTML = Object.entries(MODULES)
      .filter(([m]) => m !== "turret_ring" || u.hasTurret)
      .map(([m, name]) => `<span class="mod mod-${u.modules[m]}">${name}</span>`)
      .join("");
    p.querySelectorAll("[data-shell]").forEach((b) => {
      const i = Number(b.dataset.shell);
      b.classList.toggle("on", i < 0 ? u.shellAuto !== false : u.shellAuto === false && u.shellIndex === i);
    });
    p.querySelectorAll("[data-fire]").forEach((b) => b.classList.toggle("on", u.fireMode === b.dataset.fire));
    p.querySelector("[data-angle]").classList.toggle("on", u.autoAngle);
    p.querySelectorAll("[data-skill]").forEach((b) => {
      const owner = sel.find((x) => x.id === b.dataset.unit);
      const sk = this.game.data.skills[b.dataset.skill];
      const cd = Math.max(0, (owner?.cooldowns[sk.id] || 0) - this.game.time);
      b.disabled = !owner || !this.game.canUseActive(owner, sk);
      b.querySelector(".cd").textContent = cd > 0 ? ` ${Math.ceil(cd)}s` : "";
    });
    const info = u.lastHitInfo;
    p.querySelector(".hit-info").textContent = info
      ? `最後の被弾：${info.part === "turret" ? "砲塔" : "車体"}${{ front: "前面", side: "側面", rear: "後面" }[info.face]} ${info.thickness}mm・入射角${info.angle.toFixed(0)}° → ${{ ricochet: "跳弾", pen: "貫通", nonpen: "非貫通" }[info.result]}${info.result !== "ricochet" ? `（実効${info.eff.toFixed(0)}mm／貫通力${info.pen.toFixed(0)}mm）` : ""}`
      : "最後の被弾：なし";
  }

  buildPanel(p, sel) {
    p.innerHTML = "";
    const u = sel[0];
    if (!u) {
      p.appendChild(
        el(
          "div",
          "panel-empty",
          "車輌をクリック／ドラッグで選択。右クリックで移動、右ドラッグで移動＋到着後の向き。数字キーで分隊を選択し、R偵察・T攻撃・G防御・B後退・F追従で大まかな指示。？でヘルプ",
        ),
      );
      return;
    }
    const left = el("div", "panel-left");
    const big = portraitEl(u.commander, "normal", 92);
    big.classList.add("big-portrait");
    left.appendChild(big);
    left.appendChild(el("div", "cmd-name", u.commander ? u.commander.name : "車長なし"));
    p.appendChild(left);

    const mid = el("div", "panel-mid");
    mid.appendChild(el("div", "panel-title", `${u.label}　${u.tank.name}${sel.length > 1 ? `　ほか${sel.length - 1}輌` : ""}`));
    mid.appendChild(el("div", "hp-text"));
    const crew = el("div", "crew");
    u.tank.crew_slots.forEach((slot, i) => {
      const ch = u.crew[i];
      const cell = el("div", "crew-cell");
      cell.dataset.slot = i;
      cell.appendChild(portraitEl(ch, "normal", 30));
      cell.appendChild(el("div", "crew-role", parseSlot(slot).map((r) => ROLE_NAMES[r]).join("・")));
      cell.title = ch ? `${ch.name}\n${(ch.skills || []).map((s) => this.game.data.skills[s]?.name).filter(Boolean).join(" / ")}` : "空席";
      crew.appendChild(cell);
    });
    mid.appendChild(crew);
    mid.appendChild(el("div", "modules"));
    mid.appendChild(el("div", "gun-text"));
    mid.appendChild(el("div", "hit-info"));
    p.appendChild(mid);

    const right = el("div", "panel-right");
    const row = (label, buttons) => {
      const r = el("div", "btn-row");
      r.appendChild(el("span", "row-label", label));
      buttons.forEach((b) => r.appendChild(b));
      right.appendChild(r);
    };
    const btn = (text, fn, attrs = {}) => {
      const b = el("button", "", text);
      Object.entries(attrs).forEach(([k, v]) => (b.dataset[k] = v));
      b.onclick = fn;
      return b;
    };
    const all = () => this.selected.filter((x) => x.alive);
    row("弾種", [btn("自動", () => this.game.cmdShell(all(), -1), { shell: -1 }), ...u.tank.gun.shells.map((s, i) => btn(s.type, () => this.game.cmdShell(all(), i), { shell: i }))]);
    row("射撃", Object.entries(FIRE_MODES).map(([k, v]) => btn(v, () => this.game.cmdFireMode(all(), k), { fire: k })));
    row("個別", [
      btn("停止 S", () => this.game.cmdStop(all())),
      btn("左へ振る Q", () => this.game.cmdRotate(all(), -15 * DEG)),
      btn("右へ振る E", () => this.game.cmdRotate(all(), 15 * DEG)),
      btn("角度自動", () => all().forEach((x) => (x.autoAngle = !x.autoAngle)), { angle: 1 }),
      btn("分隊に戻す Z", () => this.game.cmdReturnToSquad(all())),
    ]);
    row(
      "分隊任務",
      Object.entries(MISSIONS).map(([k, m]) => {
        const b = btn(`${m.name} ${m.key.toUpperCase()}`, () => this.startMission(k));
        b.title = m.desc;
        b.classList.add(`m-${k}`);
        return b;
      }),
    );
    const actives = sel.flatMap((x) => x.skillSets.actives.map((a) => ({ ...a, unit: x })));
    if (actives.length) {
      row(
        "スキル",
        actives.map((a) => {
          const b = btn("", () => {
            if (!this.game.cmdActive(a.unit, a.skill)) this.toast("まだ使えません");
          }, { skill: a.skill.id, unit: a.unit.id });
          b.innerHTML = `${a.skill.name}<span class="cd"></span>`;
          b.title = `${a.char.name}：${a.skill.description}`;
          b.classList.add("skill-btn");
          return b;
        }),
      );
    }
    p.appendChild(right);
  }

  updateLog() {
    const g = this.game;
    if (g.log.length === this.logCount) return;
    this.logCount = g.log.length;
    const box = $("#log");
    box.innerHTML = g.log
      .slice(-7)
      .map((l) => `<div class="log-${l.kind}">${Math.floor(l.t / 60)}:${String(Math.floor(l.t % 60)).padStart(2, "0")} ${l.text}</div>`)
      .join("");
  }
}
