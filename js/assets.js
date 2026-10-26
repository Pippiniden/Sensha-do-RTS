// 画像パスの差し替え表。エディタで選んだばかりの画像（まだ assets/ に置いていないもの）を
// プレビューするため、パス → 一時URL を登録できるようにしている。
export const assetOverrides = new Map();

export function resolveAsset(path) {
  if (!path) return path;
  return assetOverrides.get(path) || path;
}
