import { resolveAsset } from "./assets.js";

// 顔グラ：画像があれば画像、なければキャラ色の円に頭文字（プレースホルダー）
export const EXPRESSIONS = { normal: "通常", smile: "笑顔", surprised: "驚き", serious: "真剣", stunned: "気絶" };
const MARK = { normal: "", smile: "♪", surprised: "!", serious: "—", stunned: "×" };

export function portraitEl(char, expr = "normal", size = 48) {
  const wrap = document.createElement("div");
  wrap.className = "portrait";
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  updatePortrait(wrap, char, expr);
  return wrap;
}

export function updatePortrait(wrap, char, expr = "normal") {
  const key = `${char?.id || "-"}|${expr}|${char?.portraits?.[expr] || char?.portraits?.normal || ""}|${char?.color}|${char?.short}`;
  if (wrap.dataset.key === key) return;
  wrap.dataset.key = key;
  wrap.innerHTML = "";
  const size = parseInt(wrap.style.width, 10) || 48;
  const path = char?.portraits?.[expr] || char?.portraits?.normal;
  const fallback = () => {
    wrap.innerHTML = "";
    const ph = document.createElement("div");
    ph.className = "portrait-ph";
    ph.style.background = char?.color || "#777";
    ph.style.fontSize = `${Math.round(size * 0.45)}px`;
    ph.textContent = char ? char.short || char.name.slice(0, 1) : "?";
    if (expr === "stunned") ph.classList.add("stunned");
    wrap.appendChild(ph);
    if (MARK[expr]) {
      const m = document.createElement("span");
      m.className = "portrait-mark";
      m.textContent = MARK[expr];
      wrap.appendChild(m);
    }
  };
  if (path) {
    const img = document.createElement("img");
    img.src = resolveAsset(path);
    img.alt = char.name;
    img.onerror = fallback;
    wrap.appendChild(img);
  } else fallback();
}

/** セリフ選択。キャラ固有 → 既定 の順。文字列か {text, voice} */
export function pickLine(lines, charId, event) {
  const pool = lines?.[charId]?.[event]?.length ? lines[charId][event] : lines?._default?.[event] || [];
  if (!pool.length) return null;
  const e = pool[Math.floor(Math.random() * pool.length)];
  return typeof e === "string" ? { text: e, voice: null } : e;
}

export const EVENT_EXPR = {
  active: "serious",
  flag_spotted: "serious",
  kill: "smile",
  destroyed: "stunned",
  sixth_sense: "surprised",
  ricochet_made: "smile",
  ricochet_taken: "surprised",
  contact: "serious",
  order_ack: "normal",
};

export const EVENT_NAMES = {
  active: "アクティブスキル発動",
  flag_spotted: "フラッグ車を発見",
  kill: "敵を撃破",
  destroyed: "自車が白旗",
  sixth_sense: "第六感（被発見）",
  ricochet_made: "跳弾させた",
  ricochet_taken: "跳弾された",
  contact: "分隊が敵を発見",
  order_ack: "命令の受領",
};
