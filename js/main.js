// エントリーポイント：データ読み込み → タイトル → 試合
import { loadGameData, clearOverride } from "./data.js";
import { Game, DIFFICULTIES, PAUSE_MODES, PLAYER } from "./game.js";
import { Renderer } from "./render.js";
import { UI } from "./ui.js";
import { ROLE_NAMES, parseSlot } from "./stats.js";

const SETTINGS_KEY = "senshado-rts.settings";
const $ = (s) => document.querySelector(s);

function loadSettings() {
  try {
    return { scenario: null, difficulty: "normal", pauseMode: "auto", unitScale: 2.2, cutinSlow: false, voice: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { difficulty: "normal", pauseMode: "auto", unitScale: 2.2 };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 何もしない */
  }
}

async function boot() {
  let loaded;
  try {
    loaded = await loadGameData();
  } catch (err) {
    $("#start .dialog").innerHTML = `<h1>データを読み込めませんでした</h1><p>${err.message}</p><p>index.html を直接開くとブラウザの制限で読み込めません。README の手順でローカルサーバーから開いてください（例：<code>npx http-server</code> や <code>python -m http.server</code>）。</p>`;
    return;
  }
  const { data, overridden } = loaded;
  const settings = loadSettings();
  if (overridden) {
    $("#data-source").innerHTML = 'エディタで保存したデータを使用中。 <button id="btn-reset-data">元のデータに戻す</button>';
    $("#btn-reset-data").onclick = () => {
      if (confirm("エディタでブラウザに保存したデータを破棄して、data/ フォルダのデータに戻しますか？")) {
        clearOverride();
        location.reload();
      }
    };
    $("#data-badge").classList.remove("hidden");
  }

  const scenSel = $("#opt-scenario");
  for (const s of Object.values(data.scenarios)) scenSel.add(new Option(s.name, s.id));
  if (settings.scenario && data.scenarios[settings.scenario]) scenSel.value = settings.scenario;
  const diffSel = $("#opt-difficulty");
  for (const [k, v] of Object.entries(DIFFICULTIES)) diffSel.add(new Option(`${v.name}（一時停止：${PAUSE_MODES[v.pause]}）`, k));
  diffSel.value = settings.difficulty;
  const pauseSel = $("#opt-pause");
  for (const [k, v] of Object.entries(PAUSE_MODES)) pauseSel.add(new Option(v, k));
  pauseSel.value = settings.pauseMode;
  $("#opt-scale").value = settings.unitScale;
  $("#opt-scale-val").textContent = `×${settings.unitScale}`;
  $("#opt-scale").oninput = (e) => ($("#opt-scale-val").textContent = `×${e.target.value}`);
  $("#opt-cutin-slow").checked = settings.cutinSlow;
  $("#opt-voice").checked = settings.voice;

  const showScenario = () => {
    const sc = data.scenarios[scenSel.value];
    $("#scenario-desc").textContent = `${sc.mode === "flag" ? "フラッグ戦" : "殲滅戦"}／制限時間${Math.round((sc.time_limit_s || 1200) / 60)}分。${sc.description || ""}`;
    $("#orbat").innerHTML = ["A", "B"]
      .map((t) => {
        const team = sc.teams[t];
        const rows = (team.units || [])
          .map((u) => {
            const tank = data.tanks[u.tank];
            const crew = (tank?.crew_slots || [])
              .map((slot, i) => `${parseSlot(slot).map((r) => ROLE_NAMES[r]).join("・")}:${data.characters[u.crew?.[i]]?.name || "―"}`)
              .join("　");
            const tags = `${u.leader ? "★" : ""}${u.flag ? "⚑" : ""}`;
            return `<tr><td>${u.squad ?? 1}</td><td>${tags}${u.label || ""}</td><td>${tank?.name || u.tank}</td><td class="crew-col">${crew}</td></tr>`;
          })
          .join("");
        return `<h3 style="color:${team.color}">${team.name}${t === PLAYER ? "（プレイヤー）" : ""}</h3><table class="orbat"><tr><th>分隊</th><th>車輌</th><th>車種</th><th>乗員</th></tr>${rows}</table>`;
      })
      .join("");
  };
  scenSel.onchange = showScenario;
  showScenario();

  const start = () => {
    const s = {
      scenario: scenSel.value,
      difficulty: diffSel.value,
      pauseMode: pauseSel.value,
      unitScale: Number($("#opt-scale").value),
      cutinSlow: $("#opt-cutin-slow").checked,
      voice: $("#opt-voice").checked,
    };
    saveSettings(s);
    $("#start").classList.add("hidden");
    run(data, s);
  };
  $("#btn-start").onclick = start;
  if (sessionStorage.getItem("senshado-rts.autostart")) {
    sessionStorage.removeItem("senshado-rts.autostart");
    start();
  }
}

function run(data, settings) {
  const game = new Game(data, settings.scenario, settings);
  const renderer = new Renderer($("#view"), $("#minimap"), game, settings);
  const ui = new UI(game, renderer, settings);
  window.__game = game; // デバッグ用
  // 自軍の初期位置にカメラを合わせる
  renderer.resize();
  ui.centerOn(game.units.filter((u) => u.team === PLAYER));
  let last = performance.now();
  let resultShown = false;
  const loop = (t) => {
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    const slow = ui.slowUntil > t / 1000 ? 0.4 : 1;
    game.update(dt * slow);
    ui.frame(dt);
    renderer.draw(ui);
    if (game.result && !resultShown) {
      resultShown = true;
      showResult(game);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function showResult(game) {
  const r = game.result;
  $("#result-title").textContent = r.winner === PLAYER ? "勝利！" : "敗北……";
  $("#result-reason").textContent = `${r.reason}　試合時間 ${Math.floor(r.time / 60)}分${Math.floor(r.time % 60)}秒`;
  const count = (fn) => game.log.filter(fn).length;
  $("#result-stats").innerHTML = `<p>跳弾 ${count((l) => l.text.includes("跳弾"))}回・貫通 ${count((l) => l.text.includes("貫通 -"))}回・非貫通 ${count((l) => l.text.includes("非貫通"))}回</p>`;
  $("#result").classList.remove("hidden");
  $("#btn-retry").onclick = () => {
    sessionStorage.setItem("senshado-rts.autostart", "1");
    location.reload();
  };
  $("#btn-title").onclick = () => location.reload();
}

boot();
