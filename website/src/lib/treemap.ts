/** Squarified treemap (Bruls, Huizing & van Wijk) — computed at build time. */
export interface Item {
  label: string;
  gb: number;
  kind: "system" | "apps" | "user" | "junk";
  rule?: string;
}
export interface Tile extends Item {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(row: number[], side: number): number {
  const s = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

export function squarify(items: Item[], x: number, y: number, w: number, h: number): Tile[] {
  const total = items.reduce((a, b) => a + b.gb, 0);
  const scale = (w * h) / total;
  const queue = [...items].sort((a, b) => b.gb - a.gb).map((i) => ({ item: i, area: i.gb * scale }));
  const out: Tile[] = [];
  let rect = { x, y, w, h };

  while (queue.length) {
    const side = Math.min(rect.w, rect.h);
    const row: typeof queue = [];
    while (queue.length) {
      const next = queue[0];
      const areas = row.map((r) => r.area);
      if (row.length === 0 || worst([...areas, next.area], side) <= worst(areas, side)) {
        row.push(queue.shift()!);
      } else break;
    }
    const rowArea = row.reduce((a, b) => a + b.area, 0);
    if (rect.w >= rect.h) {
      const colW = rowArea / rect.h;
      let cy = rect.y;
      for (const r of row) {
        const th = r.area / colW;
        out.push({ ...r.item, x: rect.x, y: cy, w: colW, h: th });
        cy += th;
      }
      rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
    } else {
      const rowH = rowArea / rect.w;
      let cx = rect.x;
      for (const r of row) {
        const tw = r.area / rowH;
        out.push({ ...r.item, x: cx, y: rect.y, w: tw, h: rowH });
        cx += tw;
      }
      rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
    }
  }
  return out;
}
