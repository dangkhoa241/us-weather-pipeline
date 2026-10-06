// Path guard for the local static servers in scripts/ (checkDemoBuild, shotReplay): true only for the folder itself or
// a path inside it. Compares against the folder plus a trailing separator, so a sibling such as "dist-old" next to
// "dist" is refused (a plain startsWith(dir) would accept it).
import { normalize, sep } from "node:path";

export function insideDir(dir, file) {
  const root = normalize(dir).replace(/[\\/]+$/, "");   // drop trailing "/" or "\" (normalize gives "\" on Windows)
  const target = normalize(file);
  return target === root || target.startsWith(root + sep);
}
