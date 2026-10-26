// ゲームデータの読み込み。
// data/*.json を基本とし、エディタで「ブラウザに保存」したデータがあれば localStorage の内容で上書きする。

export const DATA_FILES = ["tanks", "characters", "skills", "lines", "maps", "scenarios"];
export const OVERRIDE_KEY = "senshado-rts.data-override";

export async function loadBaseData(basePath = "data") {
  const entries = await Promise.all(
    DATA_FILES.map(async (name) => {
      const res = await fetch(`${basePath}/${name}.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${name}.json を読み込めませんでした (${res.status})`);
      return [name, await res.json()];
    }),
  );
  return Object.fromEntries(entries);
}

export function readOverride() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeOverride(bundle) {
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(bundle));
}

export function clearOverride() {
  try {
    localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* 何もしない */
  }
}

/** ゲームで使うデータ。overridden はエディタのデータを使っているかどうか */
export async function loadGameData(basePath = "data") {
  const base = await loadBaseData(basePath);
  const override = readOverride();
  const data = { ...base };
  let overridden = false;
  if (override) {
    for (const name of DATA_FILES) {
      if (override[name]) {
        data[name] = override[name];
        overridden = true;
      }
    }
  }
  return { data: indexData(data), overridden };
}

/** 配列データを id で引けるようにする */
export function indexData(data) {
  const byId = (arr) => Object.fromEntries((arr || []).map((x) => [x.id, x]));
  return {
    raw: data,
    tanks: byId(data.tanks),
    characters: byId(data.characters),
    skills: byId(data.skills),
    lines: data.lines || {},
    maps: byId(data.maps),
    scenarios: byId(data.scenarios),
  };
}
