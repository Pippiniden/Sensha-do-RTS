// キャラ・戦車エディタ
// 保存先は3通り：ブラウザに保存（ゲームがすぐ読む）／JSONを書き出し／data フォルダに直接保存（Chrome・Edge）
import { loadBaseData, readOverride, writeOverride, clearOverride, DATA_FILES } from "./data.js";
import { ROLES, ROLE_NAMES, STAT_DEFS, FLAG_DEFS, SKILL_LAYERS, parseSlot } from "./stats.js";
import { SHELLS, normalizedAngle, effectiveArmor, isRicochet, segmentVsHull } from "./combat.js";
import { drawTankShape } from "./render.js";
import { portraitEl, EXPRESSIONS, EVENT_NAMES } from "./portrait.js";
import { MISSIONS } from "./squad.js";
import { validate } from "./validate.js";
import { assetOverrides } from "./assets.js";
import { deepClone } from "./util.js";

const TABS = {
  tanks: "戦車",
  characters: "キャラ",
  skills: "スキル",
  lines: "セリフ",
  scenarios: "編成・シナリオ",
  json: "JSON直接編集",
};
const FILE_NAMES = { tanks: "戦車", characters: "キャラ", skills: "スキル", lines: "セリフ", maps: "マップ", scenarios: "シナリオ" };

const state = {
  data: null,
  tab: "tanks",
  sel: {},
  dirty: false,
  dataDir: null,
  rootDir: null,
  pendingImages: new Map(), // path -> File
  previewAngle: 25,
  previewShell: null,
  jsonFile: "tanks",
  filter: "",
};

const $ = (s) => document.querySelector(s);
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e[k] = v;
    else if (k === "style") e.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
  return e;
}

// ---------- データの読み込み・保存 ----------
async function init() {
  const base = await loadBaseData();
  const override = readOverride();
  state.data = deepClone(base);
  if (override) {
    for (const n of DATA_FILES) if (override[n]) state.data[n] = override[n];
    setStatus("ブラウザに保存したデータを読み込みました（ゲームもこのデータで動きます）");
  } else setStatus("data フォルダのデータを読み込みました");
  for (const n of ["tanks", "characters", "skills", "scenarios"]) state.sel[n] = state.data[n][0]?.id;
  state.sel.lines = "_default";
  bindToolbar();
  render();
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function markDirty() {
  state.dirty = true;
  $("#dirty").classList.remove("hidden");
}

function setStatus(text, kind = "") {
  const s = $("#status");
  s.textContent = text;
  s.className = kind;
}

function bindToolbar() {
  $("#btn-save-browser").onclick = () => {
    const v = validate(state.data);
    if (v.errors.length && !confirm(`エラーが${v.errors.length}件あります。このまま保存しますか？\n\n${v.errors.slice(0, 5).join("\n")}`)) return;
    try {
      writeOverride(state.data);
      state.dirty = false;
      $("#dirty").classList.add("hidden");
      setStatus("ブラウザに保存しました。ゲームを開き直すと反映されます", "ok");
    } catch (err) {
      setStatus(`保存できませんでした：${err.message}`, "err");
    }
  };
  $("#btn-save-folder").onclick = saveToFolder;
  if (!window.showDirectoryPicker) {
    $("#btn-save-folder").disabled = true;
    $("#btn-save-folder").title = "このブラウザでは使えません（Chrome・Edge で使えます）";
  }
  $("#btn-export-all").onclick = () => download("senshado-data.json", state.data);
  $("#btn-export-one").onclick = () => {
    const name = state.tab === "json" ? state.jsonFile : state.tab;
    download(`${name}.json`, state.data[name]);
  };
  $("#btn-import").onclick = () => $("#file-import").click();
  $("#file-import").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      const base = f.name.replace(/\.json$/, "");
      if (DATA_FILES.includes(base)) {
        state.data[base] = obj;
      } else if (DATA_FILES.some((n) => obj[n])) {
        for (const n of DATA_FILES) {
          if (obj[n]) state.data[n] = obj[n];
        }
      } else {
        throw new Error("tanks.json などのデータファイルか、書き出したまとめファイルを選んでください");
      }
      markDirty();
      render();
      setStatus(`${f.name} を読み込みました`, "ok");
    } catch (err) {
      setStatus(`読み込めませんでした：${err.message}`, "err");
    }
  };
  $("#btn-reload").onclick = async () => {
    if (!confirm("data フォルダの内容を読み直します。ブラウザに保存したデータも破棄されます。よろしいですか？")) return;
    clearOverride();
    state.data = deepClone(await loadBaseData());
    state.dirty = false;
    $("#dirty").classList.add("hidden");
    render();
    setStatus("data フォルダの内容に戻しました", "ok");
  };
  $("#btn-check").onclick = () => $("#check-panel").classList.toggle("hidden");
}

function download(name, obj) {
  const blob = new Blob([`${JSON.stringify(obj, null, 2)}\n`], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function pickFolder() {
  const h = await window.showDirectoryPicker({ mode: "readwrite" });
  try {
    state.dataDir = await h.getDirectoryHandle("data");
    state.rootDir = h;
  } catch {
    await h.getFileHandle("tanks.json"); // data フォルダそのものを選んだ場合
    state.dataDir = h;
    state.rootDir = null;
  }
}

async function writeFile(dir, name, content) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

async function saveToFolder() {
  try {
    if (!state.dataDir) await pickFolder();
    for (const n of DATA_FILES) await writeFile(state.dataDir, `${n}.json`, `${JSON.stringify(state.data[n], null, 2)}\n`);
    let imgNote = "";
    if (state.pendingImages.size) {
      if (state.rootDir) {
        for (const [path, file] of state.pendingImages) {
          const parts = path.split("/");
          let dir = state.rootDir;
          for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
          await writeFile(dir, parts.at(-1), file);
        }
        imgNote = `、画像${state.pendingImages.size}枚`;
        state.pendingImages.clear();
      } else imgNote = "（画像はプロジェクトのフォルダを選び直すと保存できます）";
    }
    clearOverride(); // data フォルダが最新になったので、ブラウザ保存分は不要
    state.dirty = false;
    $("#dirty").classList.add("hidden");
    setStatus(`data フォルダに保存しました${imgNote}`, "ok");
  } catch (err) {
    if (err.name === "AbortError") return;
    state.dataDir = null;
    setStatus(`保存できませんでした：${err.message}（プロジェクトのフォルダか data フォルダを選んでください）`, "err");
  }
}

// ---------- フォーム部品 ----------
function field(label, input, hint) {
  return el("label", { class: "field" }, el("span", { class: "flabel" }, label), input, hint ? el("span", { class: "hint" }, hint) : null);
}

function numInput(obj, key, { step = 1, min, max, onChange } = {}) {
  const i = el("input", { type: "number", step, min, max, value: obj[key] ?? "" });
  i.oninput = () => {
    const v = parseFloat(i.value);
    obj[key] = Number.isFinite(v) ? v : 0;
    markDirty();
    onChange?.();
  };
  return i;
}

function textInput(obj, key, { onChange, onCommit, placeholder } = {}) {
  const i = el("input", { type: "text", value: obj[key] ?? "", placeholder });
  i.oninput = () => {
    obj[key] = i.value;
    markDirty();
    onChange?.();
  };
  if (onCommit) i.onchange = () => onCommit(i.value);
  return i;
}

function selectInput(obj, key, options, { onChange } = {}) {
  const s = el("select");
  for (const [v, label] of options) s.add(new Option(label, v));
  s.value = obj[key] ?? "";
  s.onchange = () => {
    obj[key] = s.value === "" ? null : s.value;
    markDirty();
    onChange?.();
  };
  return s;
}

function checkInput(obj, key, { onChange } = {}) {
  const c = el("input", { type: "checkbox" });
  c.checked = !!obj[key];
  c.onchange = () => {
    obj[key] = c.checked;
    markDirty();
    onChange?.();
  };
  return c;
}

function section(title, ...children) {
  return el("fieldset", {}, el("legend", {}, title), ...children);
}

function idInput(kind, item) {
  return textInput(item, "id", {
    onCommit: (v) => {
      const old = state.sel[kind];
      const nv = v.trim().replace(/\s+/g, "_");
      if (!nv) return;
      if (state.data[kind].some((x) => x !== item && x.id === nv)) {
        alert(`ID「${nv}」は既に使われています`);
        item.id = old;
        render();
        return;
      }
      item.id = nv;
      renameRefs(kind, old, nv);
      state.sel[kind] = nv;
      render();
    },
  });
}

/** IDを変えたら参照も直す */
function renameRefs(kind, oldId, newId) {
  if (oldId === newId) return;
  const d = state.data;
  if (kind === "tanks") for (const sc of d.scenarios) for (const t of Object.values(sc.teams)) for (const u of t.units) if (u.tank === oldId) u.tank = newId;
  if (kind === "characters") {
    for (const sc of d.scenarios) for (const t of Object.values(sc.teams)) for (const u of t.units) u.crew = (u.crew || []).map((c) => (c === oldId ? newId : c));
    if (d.lines[oldId]) {
      d.lines[newId] = d.lines[oldId];
      delete d.lines[oldId];
    }
  }
  if (kind === "skills") for (const c of d.characters) c.skills = (c.skills || []).map((s) => (s === oldId ? newId : s));
}

/** 画像を選ぶ：assets/<dir>/ のパスを入れ、プレビュー用に一時URLを登録 */
function imagePicker(obj, key, dir, onChange) {
  const wrap = el("div", { class: "img-pick" });
  const t = textInput(obj, key, { placeholder: "未指定（プレースホルダー表示）", onChange });
  const file = el("input", { type: "file", accept: "image/*", class: "hidden" });
  file.onchange = () => {
    const f = file.files[0];
    if (!f) return;
    const path = `assets/${dir}/${f.name.replace(/[^\w.\-]/g, "_")}`;
    assetOverrides.set(path, URL.createObjectURL(f));
    state.pendingImages.set(path, f);
    obj[key] = path;
    t.value = path;
    markDirty();
    onChange?.();
    setStatus(`${path} を設定しました。「data フォルダに保存」でプロジェクトにコピーされます（または手動で置いてください）`);
  };
  const clear = el("button", { onclick: () => { obj[key] = null; t.value = ""; markDirty(); onChange?.(); } }, "×");
  wrap.append(t, el("button", { onclick: () => file.click() }, "画像を選ぶ"), clear, file);
  return wrap;
}

// ---------- 画面全体 ----------
function render() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  for (const [k, name] of Object.entries(TABS)) {
    tabs.append(el("button", { class: state.tab === k ? "on" : "", onclick: () => { state.tab = k; render(); } }, name));
  }
  renderList();
  renderForm();
  renderCheck();
}

function renderCheck() {
  const v = validate(state.data);
  const btn = $("#btn-check");
  btn.textContent = v.errors.length ? `エラー ${v.errors.length}件` : v.warns.length ? `注意 ${v.warns.length}件` : "問題なし";
  btn.className = v.errors.length ? "err" : v.warns.length ? "warn" : "ok";
  $("#check-panel").innerHTML = "";
  $("#check-panel").append(
    ...v.errors.map((e) => el("div", { class: "err" }, `✕ ${e}`)),
    ...v.warns.map((e) => el("div", { class: "warn" }, `△ ${e}`)),
    !v.errors.length && !v.warns.length ? el("div", { class: "ok" }, "データに問題は見つかりませんでした") : null,
  );
}

const TEMPLATES = {
  tanks: () => ({
    id: "new_tank",
    name: "新しい戦車",
    school: "",
    note: "数値は仮値",
    size_m: { length: 6, width: 3 },
    hp: 500,
    armor_mm: { hull: { front: 50, side: 30, rear: 20 }, turret: { front: 50, side: 30, rear: 30 }, spaced_side: 0 },
    turret: true,
    mobility: { fwd_kmh: 40, rev_kmh: 12, hull_traverse_dps: 40, turret_traverse_dps: 30 },
    gun: { caliber_mm: 75, reload_s: 5, aim_s: 2, dispersion_m: 0.4, range_m: 600, shells: [{ type: "AP", pen_mm: 100, damage: 110 }] },
    view_range_m: 350,
    radio_range_m: 400,
    camo: { still: 0.15, moving: 0.1, fire_penalty: 0.1 },
    crew_slots: ["commander", "gunner", "loader", "driver", "radio"],
    sprite: { hull: null, turret: null, turret_pivot: [0.5, 0.5], rotation_offset_deg: 0, wreck: null },
  }),
  characters: () => ({
    id: "new_char",
    name: "新しいキャラ",
    short: "新",
    color: "#888888",
    school: "",
    proficiency: { commander: 60, gunner: 60, loader: 60, driver: 60, radio: 60 },
    skills: [],
    portraits: { normal: null, smile: null, surprised: null, serious: null, stunned: null },
  }),
  skills: () => ({ id: "new_skill", name: "新しいスキル", layer: "personal", description: "", effects: [{ stat: "view_range", op: "add_pct", value: 5 }] }),
  scenarios: () => {
    const first = state.data.scenarios[0];
    const sc = deepClone(first);
    sc.id = "new_scenario";
    sc.name = "新しいシナリオ";
    return sc;
  },
};

function uniqueId(kind, base) {
  let id = base;
  let n = 2;
  while (state.data[kind].some((x) => x.id === id)) id = `${base}_${n++}`;
  return id;
}

function renderList() {
  const list = $("#list");
  list.innerHTML = "";
  const kind = state.tab;
  if (kind === "json") {
    for (const n of DATA_FILES) {
      list.append(el("div", { class: `item ${state.jsonFile === n ? "sel" : ""}`, onclick: () => { state.jsonFile = n; render(); } }, `${n}.json`, el("small", {}, FILE_NAMES[n])));
    }
    return;
  }
  if (kind === "lines") {
    const items = [["_default", "既定のセリフ（全員共通）"], ...state.data.characters.map((c) => [c.id, c.name])];
    for (const [id, name] of items) {
      const n = Object.values(state.data.lines[id] || {}).reduce((s, a) => s + a.length, 0);
      list.append(el("div", { class: `item ${state.sel.lines === id ? "sel" : ""}`, onclick: () => { state.sel.lines = id; render(); } }, name, el("small", {}, n ? `${n}件` : "なし")));
    }
    return;
  }
  const search = el("input", { type: "search", placeholder: "検索", value: state.filter });
  search.oninput = () => {
    state.filter = search.value;
    renderList();
    $("#list input").focus();
  };
  const tools = el(
    "div",
    { class: "list-tools" },
    el("button", { onclick: () => addItem(kind) }, "＋ 追加"),
    el("button", { onclick: () => duplicateItem(kind) }, "複製"),
    el("button", { class: "danger", onclick: () => deleteItem(kind) }, "削除"),
  );
  list.append(tools, search);
  const f = state.filter.trim();
  for (const it of state.data[kind]) {
    const label = it.name || it.id;
    if (f && !label.includes(f) && !it.id.includes(f)) continue;
    const sub = kind === "tanks" ? it.school : kind === "characters" ? it.school : kind === "skills" ? SKILL_LAYERS[it.layer]?.split("（")[0] : it.mode === "flag" ? "フラッグ戦" : "殲滅戦";
    const row = el("div", { class: `item ${state.sel[kind] === it.id ? "sel" : ""}`, onclick: () => { state.sel[kind] = it.id; render(); } });
    if (kind === "characters") row.append(portraitEl(it, "normal", 24));
    row.append(el("span", {}, label), el("small", {}, sub || ""));
    list.append(row);
  }
}

function addItem(kind) {
  const it = TEMPLATES[kind]();
  it.id = uniqueId(kind, it.id);
  state.data[kind].push(it);
  state.sel[kind] = it.id;
  markDirty();
  render();
}

function duplicateItem(kind) {
  const cur = state.data[kind].find((x) => x.id === state.sel[kind]);
  if (!cur) return;
  const it = deepClone(cur);
  it.id = uniqueId(kind, `${cur.id}_copy`);
  it.name = `${cur.name}（コピー）`;
  state.data[kind].splice(state.data[kind].indexOf(cur) + 1, 0, it);
  state.sel[kind] = it.id;
  markDirty();
  render();
}

function deleteItem(kind) {
  const cur = state.data[kind].find((x) => x.id === state.sel[kind]);
  if (!cur || !confirm(`「${cur.name}」を削除しますか？`)) return;
  state.data[kind] = state.data[kind].filter((x) => x !== cur);
  state.sel[kind] = state.data[kind][0]?.id;
  markDirty();
  render();
}

function renderForm() {
  const form = $("#form");
  form.innerHTML = "";
  const kind = state.tab;
  if (kind === "json") return form.append(jsonForm());
  if (kind === "lines") return form.append(linesForm(state.sel.lines));
  const item = state.data[kind].find((x) => x.id === state.sel[kind]);
  if (!item) return form.append(el("p", { class: "dim" }, "左の「＋ 追加」で作成できます"));
  if (kind === "tanks") form.append(tankForm(item));
  if (kind === "characters") form.append(charForm(item));
  if (kind === "skills") form.append(skillForm(item));
  if (kind === "scenarios") form.append(scenarioForm(item));
}

// ---------- 戦車 ----------
function tankForm(t) {
  const root = el("div", { class: "form-grid" });
  const left = el("div");
  const right = el("div", { class: "preview-col" });
  const preview = el("canvas", { width: 360, height: 300, class: "preview" });
  const calc = el("div", { class: "calc" });
  const redraw = () => drawTankPreview(t, preview, calc);
  const nameCommit = () => renderList();
  left.append(
    section(
      "基本",
      field("ID", idInput("tanks", t), "英数字。シナリオからこのIDで参照します"),
      field("名前", textInput(t, "name", { onCommit: nameCommit })),
      field("学校", textInput(t, "school", { onCommit: nameCommit })),
      field("メモ", textInput(t, "note")),
      field("HP", numInput(t, "hp", { step: 10 })),
      field("車体の長さ (m)", numInput(t.size_m, "length", { step: 0.1, onChange: redraw })),
      field("車体の幅 (m)", numInput(t.size_m, "width", { step: 0.1, onChange: redraw }), "当たり判定の矩形。画像を差し替えても変わりません"),
    ),
  );
  const armor = el("table", { class: "armor" }, el("tr", {}, el("th"), el("th", {}, "前面"), el("th", {}, "側面"), el("th", {}, "後面")));
  for (const [part, pname] of [["hull", "車体"], ["turret", "砲塔"]]) {
    armor.append(el("tr", {}, el("th", {}, pname), ...["front", "side", "rear"].map((f) => el("td", {}, numInput(t.armor_mm[part], f, { onChange: redraw })))));
  }
  const arcField = field("射界 (±°)", numInput(t.gun, "arc_deg", { onChange: redraw }), "砲塔なしの車輌の砲の左右の可動範囲");
  arcField.classList.toggle("hidden", t.turret !== false);
  const syncTurret = () => {
    if (t.turret === false && t.gun.arc_deg == null) t.gun.arc_deg = 10;
    if (t.turret !== false) delete t.gun.arc_deg;
    arcField.classList.toggle("hidden", t.turret !== false);
    redraw();
  };
  const turretChk = el("input", { type: "checkbox" });
  turretChk.checked = t.turret !== false;
  turretChk.onchange = () => {
    t.turret = turretChk.checked;
    markDirty();
    syncTurret();
  };
  left.append(
    section("装甲 (mm)", armor, field("側面の増加装甲 (mm)", numInput(t.armor_mm, "spaced_side", { onChange: redraw }), "シュルツェンなど。HEAT・HEに対してだけ加算"), field("砲塔あり", turretChk), arcField),
    section(
      "機動",
      field("前進速度 (km/h)", numInput(t.mobility, "fwd_kmh")),
      field("後退速度 (km/h)", numInput(t.mobility, "rev_kmh")),
      field("車体旋回 (°/秒)", numInput(t.mobility, "hull_traverse_dps")),
      field("砲塔旋回 (°/秒)", numInput(t.mobility, "turret_traverse_dps")),
    ),
  );
  const shells = el("div");
  const renderShells = () => {
    shells.innerHTML = "";
    t.gun.shells.forEach((s, i) => {
      shells.append(
        el(
          "div",
          { class: "row" },
          selectInput(s, "type", Object.keys(SHELLS).map((k) => [k, k]), { onChange: redraw }),
          el("span", {}, "貫通"),
          numInput(s, "pen_mm", { onChange: redraw }),
          el("span", {}, "mm ダメージ"),
          numInput(s, "damage"),
          el("button", { class: "danger", onclick: () => { t.gun.shells.splice(i, 1); markDirty(); renderShells(); redraw(); } }, "削除"),
        ),
      );
    });
    shells.append(el("button", { onclick: () => { t.gun.shells.push({ type: "AP", pen_mm: 100, damage: 100 }); markDirty(); renderShells(); } }, "＋ 弾種を追加"));
  };
  renderShells();
  left.append(
    section(
      "主砲",
      field("口径 (mm)", numInput(t.gun, "caliber_mm", { onChange: redraw }), "跳弾の3倍・正規化の2倍ルールに使います"),
      field("装填時間 (秒)", numInput(t.gun, "reload_s", { step: 0.1 })),
      field("照準時間 (秒)", numInput(t.gun, "aim_s", { step: 0.1 })),
      field("拡散 (m/100m)", numInput(t.gun, "dispersion_m", { step: 0.01 })),
      field("射程 (m)", numInput(t.gun, "range_m", { step: 10 })),
      el("div", { class: "flabel" }, "弾種（並び順が弾種ボタンの順）"),
      shells,
    ),
    section(
      "索敵・隠蔽",
      field("視認範囲 (m)", numInput(t, "view_range_m", { step: 5 })),
      field("通信範囲 (m)", numInput(t, "radio_range_m", { step: 10 })),
      field("隠蔽率（停止）", numInput(t.camo, "still", { step: 0.01, min: 0, max: 1 }), "0〜1。高いほど見つかりにくい"),
      field("隠蔽率（移動）", numInput(t.camo, "moving", { step: 0.01, min: 0, max: 1 })),
      field("射撃時の隠蔽低下", numInput(t.camo, "fire_penalty", { step: 0.01, min: 0, max: 1 })),
    ),
  );
  left.append(section("乗員の席", crewSlotsEditor(t)));
  t.sprite = t.sprite || { hull: null, turret: null, turret_pivot: [0.5, 0.5], rotation_offset_deg: 0, wreck: null };
  const pivot = { x: t.sprite.turret_pivot?.[0] ?? 0.5, y: t.sprite.turret_pivot?.[1] ?? 0.5 };
  const syncPivot = () => {
    t.sprite.turret_pivot = [pivot.x, pivot.y];
    redraw();
  };
  left.append(
    section(
      "画像（未指定なら▲で表示）",
      el("p", { class: "hint" }, "画像は車体の前方が上を向くように描いてください。選んだ画像は assets/tanks/ に置く前提のパスになります"),
      field("車体", imagePicker(t.sprite, "hull", "tanks", redraw)),
      field("砲塔", imagePicker(t.sprite, "turret", "tanks", redraw)),
      field("撃破後", imagePicker(t.sprite, "wreck", "tanks", redraw)),
      field("砲塔の回転中心 X", numInput(pivot, "x", { step: 0.01, onChange: syncPivot }), "画像の幅に対する割合（0〜1）"),
      field("砲塔の回転中心 Y", numInput(pivot, "y", { step: 0.01, onChange: syncPivot })),
      field("回転の補正 (°)", numInput(t.sprite, "rotation_offset_deg", { onChange: redraw }), "画像が上向きでない場合に指定"),
    ),
  );
  // プレビュー
  const angle = el("input", { type: "range", min: 0, max: 90, value: state.previewAngle });
  const angleVal = el("span", {}, `${state.previewAngle}°`);
  angle.oninput = () => {
    state.previewAngle = Number(angle.value);
    angleVal.textContent = `${angle.value}°`;
    redraw();
  };
  const shellSel = el("select");
  for (const tk of state.data.tanks) for (const s of tk.gun.shells) shellSel.add(new Option(`${tk.name} ${s.type}（貫通${s.pen_mm}mm・${tk.gun.caliber_mm}mm砲）`, `${tk.id}|${s.type}`));
  if (state.previewShell) shellSel.value = state.previewShell;
  state.previewShell = shellSel.value;
  shellSel.onchange = () => {
    state.previewShell = shellSel.value;
    redraw();
  };
  right.append(
    el("h3", {}, "プレビューと角度の試算"),
    preview,
    field("車体の振り角", el("span", { class: "row" }, angle, angleVal), "敵は画面の上（真正面）にいるものとします"),
    field("撃ってくる弾", shellSel),
    calc,
  );
  root.append(left, right);
  setTimeout(redraw, 0);
  return root;
}

function crewSlotsEditor(t) {
  const box = el("div");
  const draw = () => {
    box.innerHTML = "";
    t.crew_slots.forEach((slot, i) => {
      const roles = parseSlot(slot);
      const primary = el("select");
      for (const r of ROLES) primary.add(new Option(ROLE_NAMES[r], r));
      primary.value = roles[0];
      const extras = ROLES.map((r) => {
        const c = el("input", { type: "checkbox" });
        c.checked = roles.slice(1).includes(r);
        c.dataset.role = r;
        return el("label", { class: "inline" }, c, ROLE_NAMES[r]);
      });
      const update = () => {
        const extra = extras.map((l) => l.querySelector("input")).filter((c) => c.checked && c.dataset.role !== primary.value).map((c) => c.dataset.role);
        t.crew_slots[i] = [primary.value, ...extra].join("+");
        markDirty();
      };
      primary.onchange = update;
      extras.forEach((l) => (l.querySelector("input").onchange = update));
      box.append(
        el(
          "div",
          { class: "row slot" },
          el("b", {}, `${i + 1}`),
          primary,
          el("span", { class: "hint" }, "兼任："),
          ...extras,
          el("button", { class: "danger", onclick: () => { t.crew_slots.splice(i, 1); markDirty(); draw(); } }, "削除"),
        ),
      );
    });
    box.append(el("button", { onclick: () => { t.crew_slots.push("loader"); markDirty(); draw(); } }, "＋ 席を追加"));
    box.append(el("p", { class: "hint" }, "兼任した役職は熟練度80%で計算され、スキルは主役職のものだけ有効。編成で乗員を割り当てる順番はこの席の順です"));
  };
  draw();
  return box;
}

function drawTankPreview(t, canvas, calc) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#c9c2a0";
  ctx.fillRect(0, 0, W, H);
  const scale = Math.min(170 / t.size_m.length, 100 / t.size_m.width);
  const heading = -Math.PI / 2 + (state.previewAngle * Math.PI) / 180;
  const cx = W / 2;
  const cy = H / 2 + 20;
  // 飛んでくる方向
  ctx.strokeStyle = "rgba(180,40,30,0.7)";
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, 8);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#7a2a20";
  ctx.font = "12px sans-serif";
  ctx.fillText("敵の射線", cx + 6, 20);
  drawTankShape(ctx, { x: cx, y: cy, heading, turret: -Math.PI / 2, tank: t, scale, color: "#3d7bd9" });
  // 当たり判定と装甲値
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(heading);
  const L = t.size_m.length * scale;
  const Wd = t.size_m.width * scale;
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(-L / 2, -Wd / 2, L, Wd);
  ctx.setLineDash([]);
  ctx.restore();
  const label = (lx, ly, text) => {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const x = cx + lx * c - ly * s;
    const y = cy + lx * s + ly * c;
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fff";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "#222";
    ctx.fillText(text, x, y);
  };
  const a = t.armor_mm.hull;
  label(L / 2 + 18, 4, `${a.front}`);
  label(0, Wd / 2 + 16, `${a.side}${t.armor_mm.spaced_side ? `+${t.armor_mm.spaced_side}` : ""}`);
  label(0, -Wd / 2 - 8, `${a.side}`);
  label(-L / 2 - 18, 4, `${a.rear}`);
  // 試算
  const [tid, type] = (state.previewShell || "").split("|");
  const atk = state.data.tanks.find((x) => x.id === tid);
  const shell = atk?.gun.shells.find((s) => s.type === type);
  calc.innerHTML = "";
  if (!shell) return;
  const cal = atk.gun.caliber_mm;
  const row = (name, thick, ang, spaced) => {
    const rico = isRicochet(type, cal, thick, ang);
    const na = normalizedAngle(type, cal, thick, ang);
    const eff = effectiveArmor(type, thick, na, spaced);
    const verdict = rico ? "跳弾" : shell.pen_mm >= eff ? "貫通" : "非貫通";
    return el("tr", { class: `v-${verdict}` }, el("td", {}, name), el("td", {}, `${thick}mm`), el("td", {}, `${ang.toFixed(0)}°`), el("td", {}, rico ? "―" : `${eff.toFixed(0)}mm`), el("td", {}, verdict));
  };
  const ang = state.previewAngle;
  const center = segmentVsHull(0, -500, 0, 0, 0, 0, heading, t.size_m.length / 2, t.size_m.width / 2);
  calc.append(
    el(
      "table",
      { class: "calc-table" },
      el("tr", {}, el("th", {}, "面"), el("th", {}, "装甲"), el("th", {}, "入射角"), el("th", {}, "実効装甲"), el("th", {}, `判定（貫通${shell.pen_mm}mm・100m）`)),
      row("車体前面", a.front, ang, 0),
      row("車体側面", a.side, 90 - ang, SHELLS[type].spacedApplies ? t.armor_mm.spaced_side || 0 : 0),
    ),
    el("p", { class: "hint" }, `車体の中心を狙った弾は「${{ front: "前面", side: "側面", rear: "後面" }[center?.face] || "―"}」に当たります。対角線の角度（${((Math.atan2(t.size_m.width, t.size_m.length) * 180) / Math.PI).toFixed(0)}°）より深く振ると側面が見えます。乱数（貫通±15%）は含みません`),
  );
}

// ---------- キャラ ----------
function charForm(c) {
  const root = el("div", { class: "form-grid" });
  const left = el("div");
  const right = el("div", { class: "preview-col" });
  const previews = el("div", { class: "portraits" });
  const redraw = () => {
    previews.innerHTML = "";
    for (const [k, name] of Object.entries(EXPRESSIONS)) previews.append(el("div", { class: "pv" }, portraitEl(c, k, 72), el("small", {}, name)));
    renderList();
  };
  left.append(
    section(
      "基本",
      field("ID", idInput("characters", c), "英数字。編成・セリフからこのIDで参照します"),
      field("名前", textInput(c, "name", { onCommit: redraw })),
      field("略字", textInput(c, "short", { onChange: redraw }), "顔グラがない時に円の中に出す1〜2文字"),
      field("イメージカラー", (() => {
        const i = el("input", { type: "color", value: c.color || "#888888" });
        i.oninput = () => {
          c.color = i.value;
          markDirty();
          redraw();
        };
        return i;
      })()),
      field("学校", textInput(c, "school")),
    ),
  );
  c.proficiency = c.proficiency || {};
  left.append(
    section(
      "熟練度（0〜100）",
      el("p", { class: "hint" }, "その役職に就いた時の性能。100で基準値、50で大きく劣化。車長はさらに自分の熟練度の10%を他の乗員に加えます"),
      ...ROLES.map((r) => field(ROLE_NAMES[r], numInput(c.proficiency, r, { min: 0, max: 100 }))),
    ),
  );
  c.skills = c.skills || [];
  const skills = el("div", { class: "skill-list" });
  for (const [layer, lname] of Object.entries(SKILL_LAYERS)) {
    const group = state.data.skills.filter((s) => s.layer === layer);
    if (!group.length) continue;
    skills.append(el("div", { class: "flabel" }, lname));
    for (const s of group) {
      const chk = el("input", { type: "checkbox" });
      chk.checked = c.skills.includes(s.id);
      chk.onchange = () => {
        c.skills = chk.checked ? [...c.skills, s.id] : c.skills.filter((x) => x !== s.id);
        markDirty();
      };
      skills.append(el("label", { class: "skill-opt" }, chk, el("b", {}, s.name), el("span", { class: "hint" }, `${s.role ? `［${ROLE_NAMES[s.role]}］` : ""}${s.description}`)));
    }
  }
  left.append(section("スキル", el("p", { class: "hint" }, "スキルの中身は「スキル」タブで作ります。層によって発動する条件が違います"), skills));
  c.portraits = c.portraits || {};
  left.append(
    section(
      "顔グラ（未指定なら色の円＋略字）",
      ...Object.entries(EXPRESSIONS).map(([k, name]) => field(name, imagePicker(c.portraits, k, "portraits", redraw))),
      el("p", { class: "hint" }, "通常以外が未指定のときは通常の画像を使います"),
    ),
  );
  const rides = [];
  for (const sc of state.data.scenarios) for (const t of Object.values(sc.teams)) for (const u of t.units) if ((u.crew || []).includes(c.id)) rides.push(`${sc.name}：${u.label || u.tank}`);
  right.append(el("h3", {}, "顔グラ"), previews, el("h3", {}, "乗っている車輌"), el("ul", {}, ...(rides.length ? rides : ["なし"]).map((r) => el("li", {}, r))));
  root.append(left, right);
  redraw();
  return root;
}

// ---------- スキル ----------
function skillForm(s) {
  const root = el("div", { class: "form-grid" });
  const left = el("div");
  const right = el("div", { class: "preview-col" });
  const activeBox = el("div");
  const roleField = field("役職", selectInput(s, "role", [["", "（どの役職でも）"], ...ROLES.map((r) => [r, ROLE_NAMES[r]])]), "役職スキルのとき、この役職に就いていると発動");
  const activeSection = section("アクティブスキルの設定", activeBox);
  const syncLayer = () => {
    activeSection.classList.toggle("hidden", s.layer !== "active");
    roleField.classList.toggle("hidden", s.layer !== "role");
    if (s.layer === "active") {
      s.requires = s.requires || "commander";
      s.scope = s.scope || "self";
      s.duration_s = s.duration_s ?? 10;
      s.cooldown_s = s.cooldown_s ?? 60;
    }
    renderList();
  };
  activeBox.append(
    field("使える条件", selectInput(s, "requires", [["commander", "車長のとき"], ["squad_leader", "分隊長車の車長のとき"], ["leader", "隊長のとき"]])),
    field("効果範囲", selectInput(s, "scope", [["self", "自車"], ["squad", "分隊（同じ通信網）"], ["network", "通信網の全車"]])),
    field("効果時間 (秒)", numInput(s, "duration_s")),
    field("クールダウン (秒)", numInput(s, "cooldown_s")),
  );
  left.append(
    section(
      "基本",
      field("ID", idInput("skills", s)),
      field("名前", textInput(s, "name", { onCommit: () => renderList() })),
      field("層", selectInput(s, "layer", Object.entries(SKILL_LAYERS), { onChange: syncLayer })),
      roleField,
      field("説明", textInput(s, "description")),
    ),
    activeSection,
  );
  const effects = el("div");
  const statOptions = [...Object.entries(STAT_DEFS).map(([k, v]) => [k, `${v.name}（${v.better === "high" ? "+で強化" : "−で強化"}）`]), ...Object.entries(FLAG_DEFS).map(([k, v]) => [k, `特殊：${v}`])];
  const drawEffects = () => {
    effects.innerHTML = "";
    s.effects = s.effects || [];
    s.effects.forEach((e, i) => {
      const isFlag = !!FLAG_DEFS[e.stat];
      const val = numInput(e, "value");
      const statSel = selectInput(e, "stat", statOptions, {
        onChange: () => {
          e.op = FLAG_DEFS[e.stat] ? "flag" : "add_pct";
          if (e.op === "flag") e.value = 1;
          drawEffects();
        },
      });
      effects.append(
        el("div", { class: "row" }, statSel, isFlag ? el("span", { class: "hint" }, "（値なし）") : el("span", { class: "row" }, val, el("span", {}, "%")), el("button", { class: "danger", onclick: () => { s.effects.splice(i, 1); markDirty(); drawEffects(); } }, "削除")),
      );
    });
    effects.append(el("button", { onclick: () => { s.effects.push({ stat: "reload", op: "add_pct", value: -5 }); markDirty(); drawEffects(); } }, "＋ 効果を追加"));
  };
  drawEffects();
  left.append(section("効果", el("p", { class: "hint" }, "割合で加算。同じ種類の補正は合計して±40%で打ち止め。装填時間・照準時間・拡散はマイナスで強化です"), effects));
  const owners = state.data.characters.filter((c) => (c.skills || []).includes(s.id));
  right.append(el("h3", {}, "このスキルを持つキャラ"), el("div", { class: "owners" }, ...(owners.length ? owners.map((c) => el("div", { class: "row" }, portraitEl(c, "normal", 28), c.name)) : [el("span", { class: "dim" }, "なし")])));
  root.append(left, right);
  syncLayer();
  return root;
}

// ---------- セリフ ----------
function linesForm(id) {
  const lines = state.data.lines;
  lines[id] = lines[id] || {};
  const ch = state.data.characters.find((c) => c.id === id);
  const root = el("div");
  root.append(
    el("h2", {}, ch ? ch.name : "既定のセリフ"),
    el("p", { class: "hint" }, ch ? "空のイベントは「既定のセリフ」から選ばれます。複数あるとランダムに1つ。原作の台詞はそのまま使わず、オリジナルで書いてください" : "キャラ固有のセリフがないときに使われます"),
    el("p", { class: "hint" }, "音声ファイル（任意）を指定すると、ゲーム設定でボイスを有効にしたときに再生されます。"),
  );
  for (const [ev, name] of Object.entries(EVENT_NAMES)) {
    const box = el("div");
    const draw = () => {
      box.innerHTML = "";
      const arr = (lines[id][ev] = lines[id][ev] || []);
      arr.forEach((entry, i) => {
        const obj = typeof entry === "string" ? { text: entry, voice: null } : entry;
        const sync = () => {
          arr[i] = obj.voice ? { text: obj.text, voice: obj.voice } : obj.text;
          markDirty();
        };
        const t = el("input", { type: "text", value: obj.text, class: "line-text" });
        t.oninput = () => {
          obj.text = t.value;
          sync();
        };
        const v = el("input", { type: "text", value: obj.voice || "", placeholder: "音声ファイル（任意）", class: "voice" });
        v.oninput = () => {
          obj.voice = v.value || null;
          sync();
        };
        box.append(el("div", { class: "row" }, t, v, el("button", { class: "danger", onclick: () => { arr.splice(i, 1); markDirty(); draw(); } }, "削除")));
      });
      box.append(el("button", { onclick: () => { arr.push(""); markDirty(); draw(); } }, "＋ セリフを追加"));
      if (!arr.length) delete lines[id][ev];
    };
    draw();
    root.append(section(name, box));
  }
  return root;
}

// ---------- 編成・シナリオ ----------
function scenarioForm(sc) {
  const root = el("div");
  const d = state.data;
  root.append(
    section(
      "基本",
      field("ID", idInput("scenarios", sc)),
      field("名前", textInput(sc, "name", { onCommit: () => renderList() })),
      field("マップ", selectInput(sc, "map", d.maps.map((m) => [m.id, m.name]))),
      field("勝利条件", selectInput(sc, "mode", [["flag", "フラッグ戦"], ["annihilation", "殲滅戦"]], { onChange: () => renderList() })),
      field("制限時間 (秒)", numInput(sc, "time_limit_s", { step: 60 })),
      field("説明", textInput(sc, "description")),
    ),
  );
  for (const [team, label] of [["A", "プレイヤー側"], ["B", "敵側（AI）"]]) root.append(teamEditor(sc, team, label));
  return root;
}

function teamEditor(sc, team, label) {
  const d = state.data;
  const td = sc.teams[team];
  td.squads = td.squads || [{ id: 1, name: "第1分隊" }];
  const box = el("div");
  const draw = () => {
    box.innerHTML = "";
    const color = el("input", { type: "color", value: td.color || "#888888" });
    color.oninput = () => {
      td.color = color.value;
      markDirty();
    };
    box.append(
      el("div", { class: "row" }, field("学校名", textInput(td, "name")), field("色", color)),
      el(
        "div",
        { class: "row" },
        el("span", { class: "flabel" }, "初期配置（m）"),
        ...["x", "y", "w", "h"].map((k) => el("label", { class: "inline" }, k, numInput(td.spawn, k, { step: 10 }))),
        el("label", { class: "inline" }, "向き°", numInput(td.spawn, "facing_deg", { step: 15 })),
      ),
    );
    if (team === "B") {
      td.ai = td.ai || { aggression: 0.5 };
      box.append(field("AIの積極性（0〜1）", numInput(td.ai, "aggression", { step: 0.05, min: 0, max: 1 }), "低いと最初は防御で待ち、HPが減ると後退します"));
    }
    // 分隊
    const sq = el("div");
    td.squads.forEach((s, i) => {
      const extra =
        team === "A"
          ? (() => {
              const holder = { type: s.mission?.type || "" };
              return el("label", { class: "inline" }, "開始時の任務", selectInput(holder, "type", [["", "手動（なし）"], ...Object.entries(MISSIONS).filter(([k]) => ["defend", "recon"].includes(k)).map(([k, m]) => [k, `${m.name}（その場）`])], {
                onChange: () => {
                  s.mission = holder.type ? { type: holder.type } : undefined;
                  if (!s.mission) delete s.mission;
                },
              }));
            })()
          : el("label", { class: "inline" }, "AIの役割", selectInput(s, "ai_role", [["assault", "突撃"], ["recon", "偵察"], ["flag", "フラッグ護衛（防御）"]]));
      sq.append(
        el(
          "div",
          { class: "row" },
          el("b", {}, `分隊 ${s.id}`),
          textInput(s, "name"),
          extra,
          el("button", { class: "danger", onclick: () => { td.squads.splice(i, 1); markDirty(); draw(); } }, "削除"),
        ),
      );
    });
    sq.append(el("button", { onclick: () => { const id = Math.max(0, ...td.squads.map((x) => x.id)) + 1; td.squads.push({ id, name: `第${id}分隊` }); markDirty(); draw(); } }, "＋ 分隊を追加"));
    box.append(el("div", { class: "flabel" }, "分隊"), sq);
    // 車輌
    const table = el("div", { class: "units" });
    td.units.forEach((u, i) => {
      const tank = d.tanks.find((t) => t.id === u.tank);
      u.crew = u.crew || [];
      const crewSel = (tank?.crew_slots || []).map((slot, k) => {
        const holder = { v: u.crew[k] || "" };
        return el(
          "label",
          { class: "crew-pick" },
          el("small", {}, parseSlot(slot).map((r) => ROLE_NAMES[r]).join("・")),
          selectInput(holder, "v", [["", "（空席）"], ...d.characters.map((c) => [c.id, c.name])], {
            onChange: () => {
              u.crew[k] = holder.v || null;
            },
          }),
        );
      });
      const leader = el("input", { type: "radio", name: `leader-${team}` });
      leader.checked = !!u.leader;
      leader.onchange = () => {
        td.units.forEach((x) => delete x.leader);
        u.leader = true;
        markDirty();
        renderCheck();
      };
      const flag = el("input", { type: "radio", name: `flag-${team}` });
      flag.checked = !!u.flag;
      flag.onchange = () => {
        td.units.forEach((x) => delete x.flag);
        u.flag = true;
        markDirty();
        renderCheck();
      };
      const holderSquad = { v: String(u.squad ?? 1) };
      table.append(
        el(
          "div",
          { class: "unit-card" },
          el(
            "div",
            { class: "row" },
            el("b", {}, `${i + 1}`),
            el("label", { class: "inline" }, "呼び名", textInput(u, "label")),
            el("label", { class: "inline" }, "車種", selectInput(u, "tank", d.tanks.map((t) => [t.id, t.name]), {
              onChange: () => {
                const nt = d.tanks.find((t) => t.id === u.tank);
                u.crew = (nt?.crew_slots || []).map((_, k) => u.crew[k] || null);
                draw();
              },
            })),
            el("label", { class: "inline" }, "分隊", selectInput(holderSquad, "v", td.squads.map((s) => [String(s.id), `${s.id} ${s.name}`]), { onChange: () => (u.squad = Number(holderSquad.v)) })),
            el("label", { class: "inline" }, leader, "隊長車"),
            el("label", { class: "inline" }, flag, "フラッグ車"),
            el("button", { onclick: () => { td.units.splice(i + 1, 0, deepClone({ ...u, leader: undefined, flag: undefined, label: `${u.label || ""}2` })); markDirty(); draw(); } }, "複製"),
            el("button", { class: "danger", onclick: () => { td.units.splice(i, 1); markDirty(); draw(); } }, "削除"),
          ),
          el("div", { class: "row crew-row" }, ...crewSel),
        ),
      );
    });
    table.append(
      el("button", {
        onclick: () => {
          const t = d.tanks[0];
          td.units.push({ tank: t.id, label: t.name, crew: t.crew_slots.map(() => null), squad: td.squads[0]?.id ?? 1 });
          markDirty();
          draw();
        },
      }, "＋ 車輌を追加"),
    );
    box.append(el("div", { class: "flabel" }, "車輌と乗員（席の順に割り当て）"), table);
    renderCheck();
  };
  draw();
  return section(`${label}：${td.name || team}`, box);
}

// ---------- JSON ----------
function jsonForm() {
  const name = state.jsonFile;
  const ta = el("textarea", { class: "json", spellcheck: "false" });
  ta.value = JSON.stringify(state.data[name], null, 2);
  const msg = el("span");
  const apply = el("button", {
    class: "primary",
    onclick: () => {
      try {
        state.data[name] = JSON.parse(ta.value);
        markDirty();
        render();
        setStatus(`${name}.json を反映しました`, "ok");
      } catch (err) {
        msg.textContent = `JSONの書式エラー：${err.message}`;
        msg.className = "err";
      }
    },
  }, "反映");
  return el("div", {}, el("h2", {}, `${name}.json（${FILE_NAMES[name]}）`), el("p", { class: "hint" }, "フォームで扱っていない項目（マップなど）はここで直接編集できます。「反映」を押すまで変わりません"), ta, el("div", { class: "row" }, apply, msg));
}

init().catch((err) => {
  document.body.innerHTML = `<div class="dialog"><h1>データを読み込めませんでした</h1><p>${err.message}</p><p>editor.html を直接開くとブラウザの制限で読み込めません。README の手順でローカルサーバーから開いてください。</p></div>`;
});
