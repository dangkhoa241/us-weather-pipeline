// Map readability rules for city dots (UsMap). Coordinates are SVG viewBox units of the drawn (zoomed) map; dots and
// labels keep a constant size in those units at every zoom (UsMap scales them by 1 / zoom).

export type MapPoint = { id: string; name: string; x: number; y: number };
export type LabelSide = "left" | "right";

/** Radius of a dot's click area (the outer halo, 8.5 units). */
export const DOT_HIT_RADIUS = 8.5;
/** Label geometry, as drawn by UsMap: 13-unit text, starting 12 units beside the dot, baseline 4 units below it. */
export const LABEL = { fontSize: 13, gap: 12, baseline: 4, charWidth: 0.6 } as const;

/** Ids of dots whose click areas overlap another dot's: at US zoom a click there zooms to the state instead. */
export function crowdedDots(points: MapPoint[], hitRadius = DOT_HIT_RADIUS): Set<string> {
  const crowded = new Set<string>();
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < 2 * hitRadius) {
        crowded.add(points[i].id);
        crowded.add(points[j].id);
      }
    }
  }
  return crowded;
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/** The box a label covers on one side of its dot (estimated text width; the real text is close to it). */
export function labelBox(p: MapPoint, side: LabelSide): Box {
  const width = p.name.length * LABEL.fontSize * LABEL.charWidth;
  const y0 = p.y + LABEL.baseline - LABEL.fontSize;
  const y1 = p.y + LABEL.baseline + 3;   // descenders
  return side === "right"
    ? { x0: p.x + LABEL.gap, y0, x1: p.x + LABEL.gap + width, y1 }
    : { x0: p.x - LABEL.gap - width, y0, x1: p.x - LABEL.gap, y1 };
}

const boxesOverlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const boxHitsDot = (b: Box, p: MapPoint, r: number) => {
  const nx = Math.max(b.x0, Math.min(p.x, b.x1));
  const ny = Math.max(b.y0, Math.min(p.y, b.y1));
  return Math.hypot(p.x - nx, p.y - ny) < r;
};

/**
 * Which side of its dot each label goes: right by default, left when the right side would cover another dot or an
 * already placed label and the left side would not. Labels are placed east to west, so a city's label avoids the
 * labels of the cities east of it. `obstacles`: every dot drawn (also other states' dots in view); default `points`.
 */
export function labelSides(points: MapPoint[], obstacles: MapPoint[] = points, dotRadius = DOT_HIT_RADIUS): Map<string, LabelSide> {
  const sides = new Map<string, LabelSide>();
  const placed: Box[] = [];
  for (const p of [...points].sort((a, b) => b.x - a.x)) {
    const others = obstacles.filter((o) => o.id !== p.id);
    const clear = (side: LabelSide) => {
      const box = labelBox(p, side);
      return !others.some((o) => boxHitsDot(box, o, dotRadius)) && !placed.some((b) => boxesOverlap(box, b));
    };
    const side: LabelSide = clear("right") || !clear("left") ? "right" : "left";
    sides.set(p.id, side);
    placed.push(labelBox(p, side));
  }
  return sides;
}
