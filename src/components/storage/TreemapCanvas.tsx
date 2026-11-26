import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as d3 from "d3";
import { useI18nStore } from "@/i18n";

export interface StorageTreeNode {
  path: string;
  name: string;
  size_bytes: number;
  file_count: number;
  dir_count: number;
  is_dir: boolean;
  is_system_protected?: boolean;
  children: StorageTreeNode[];
}

interface TreemapCanvasProps {
  data: StorageTreeNode;
  onSelectNode: (node: StorageTreeNode) => void;
  onOpenExplorer?: (path: string) => void;
}

interface RectNode {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  data: StorageTreeNode;
  depth: number;
  color: string;
  isParentHeader?: boolean;
}

/**
 * Calm Fluent-like hues. They are never drawn as-is: each one is blended into
 * the card background (read from the CSS variables), so tiles stay muted and
 * readable in both dark and light themes. Folders take a hue by position,
 * files share one neutral hue.
 */
const PALETTE = [
  "#0078d4", // blue
  "#038387", // teal
  "#8764b8", // purple
  "#498205", // green
  "#ca5010", // copper
];
const FILE_HUE = "#69797e"; // steel grey

type RGB = [number, number, number];

const parseColor = (value: string, fallback: RGB): RGB => {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = v.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((x) => parseFloat(x));
    if ([r, g, b].every((x) => Number.isFinite(x))) return [r, g, b];
  }
  return fallback;
};

const mix = (a: RGB, b: RGB, amount: number): string => {
  const c = a.map((x, i) => Math.round(x * amount + b[i] * (1 - amount)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};

interface CanvasTheme {
  bg: RGB;
  bgCss: string;
  text: string;
  textSecondary: string;
  focus: string;
  font: string;
  isLight: boolean;
}

/** Reads the theme tokens the canvas needs from index.css. */
const readTheme = (): CanvasTheme => {
  const root = getComputedStyle(document.documentElement);
  const get = (name: string, fb: string) => root.getPropertyValue(name).trim() || fb;
  const bgCss = get("--bg-card", "#2d2d2d");
  const bg = parseColor(bgCss, [45, 45, 45]);
  const luminance = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255;
  return {
    bg,
    bgCss,
    text: get("--text-primary", "#ffffff"),
    textSecondary: get("--text-secondary", "#d1d1d1"),
    focus: get("--text-primary", "#ffffff"),
    font: getComputedStyle(document.body).fontFamily || "Segoe UI, sans-serif",
    isLight: luminance > 0.5,
  };
};

type TileKind = "header" | "tile" | "inner";

/** Fill colour for a tile: its hue blended into the background by kind. */
const tileFill = (theme: CanvasTheme, hue: string, kind: TileKind, hovered = false): string => {
  const strength = theme.isLight
    ? { header: 0.45, tile: 0.34, inner: 0.26 }[kind]
    : { header: 0.66, tile: 0.52, inner: 0.4 }[kind];
  return mix(parseColor(hue, [0, 120, 212]), theme.bg, Math.min(1, strength + (hovered ? 0.16 : 0)));
};

const hueFor = (node: { color: string; data: StorageTreeNode }) => (node.data.is_dir ? node.color : FILE_HUE);

/** Cuts text with an ellipsis so it fits maxWidth, instead of squeezing it. */
const fitText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string => {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + "…" : "";
};

export const TreemapCanvas: React.FC<TreemapCanvasProps> = ({
  data,
  onSelectNode,
  onOpenExplorer,
}) => {
  const { t } = useI18nStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<CanvasTheme>(() => readTheme());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [nodes, setNodes] = useState<RectNode[]>([]);
  const [hoveredNode, setHoveredNode] = useState<RectNode | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 800,
    height: 420,
  });

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  // Re-read the colour tokens when the app theme or the system theme changes
  useEffect(() => {
    const refresh = () => setTheme(readTheme());
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", refresh);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", refresh);
    };
  }, []);

  // ResizeObserver to maintain responsive canvas size
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        if (width > 200) {
          setDimensions({ width: Math.floor(width), height: 420 });
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Compute hierarchical nested squarified treemap layout
  useEffect(() => {
    const { width, height } = dimensions;
    if (width <= 0 || height <= 0 || !data || !data.children || data.children.length === 0) {
      setNodes([]);
      return;
    }

    // Step 1: Layout direct Level-1 children of current viewed node
    const root = d3
      .hierarchy<{ children: StorageTreeNode[] }>({
        children: data.children,
      })
      .sum((d: any) => Math.max(d.size_bytes || 0, 1024))
      .sort((a, b) => (b.value || 0) - (a.value || 0));

    const treemapLayout = d3
      .treemap<{ children: StorageTreeNode[] }>()
      .size([width, height])
      .paddingInner(3)
      .paddingOuter(2)
      .round(true);

    const layoutRoot = treemapLayout(root);
    const rects: RectNode[] = [];
    const colorScale = d3.scaleOrdinal(PALETTE);

    // Step 2: For each Level-1 child, if it has sub-children and sufficient space, create an inner treemap
    (layoutRoot.children || []).forEach((lvl1Node: any, idx: number) => {
      const childData: StorageTreeNode = lvl1Node.data;
      const baseColor = colorScale(String(idx));
      const w = lvl1Node.x1 - lvl1Node.x0;
      const h = lvl1Node.y1 - lvl1Node.y0;

      const hasSubChildren =
        childData.is_dir && childData.children && childData.children.length > 0;

      // If bounding box is large enough to show nested subdivisions
      if (hasSubChildren && w > 80 && h > 65) {
        // Add header banner for parent directory
        rects.push({
          x0: lvl1Node.x0,
          y0: lvl1Node.y0,
          x1: lvl1Node.x1,
          y1: lvl1Node.y0 + 20,
          data: childData,
          depth: 1,
          color: baseColor,
          isParentHeader: true,
        });

        // Compute inner treemap layout inside remaining area
        const innerW = Math.max(10, w - 4);
        const innerH = Math.max(10, h - 24);

        const innerRoot = d3
          .hierarchy<{ children: StorageTreeNode[] }>({
            children: childData.children,
          })
          .sum((d: any) => Math.max(d.size_bytes || 0, 1024))
          .sort((a, b) => (b.value || 0) - (a.value || 0));

        const innerTreemap = d3
          .treemap<{ children: StorageTreeNode[] }>()
          .size([innerW, innerH])
          .paddingInner(1.5)
          .paddingOuter(1)
          .round(true);

        const innerLayout = innerTreemap(innerRoot);

        (innerLayout.children || []).forEach((subNode: any) => {
          rects.push({
            x0: lvl1Node.x0 + 2 + subNode.x0,
            y0: lvl1Node.y0 + 22 + subNode.y0,
            x1: lvl1Node.x0 + 2 + subNode.x1,
            y1: lvl1Node.y0 + 22 + subNode.y1,
            data: subNode.data,
            depth: 2,
            color: baseColor,
          });
        });
      } else {
        // Render as solid tile
        rects.push({
          x0: lvl1Node.x0,
          y0: lvl1Node.y0,
          x1: lvl1Node.x1,
          y1: lvl1Node.y1,
          data: childData,
          depth: 1,
          color: baseColor,
        });
      }
    });

    setNodes(rects);
  }, [data, dimensions]);

  // Adjust canvas size for High-DPI screens ONLY when dimensions change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = dimensions;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }, [dimensions]);

  // Fast 60 FPS HTML5 Canvas Rendering
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = dimensions;
    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background matches the card the canvas sits in
    ctx.fillStyle = theme.bgCss;
    ctx.fillRect(0, 0, width, height);

    const font = theme.font;

    // Draw all rectangles
    for (const node of nodes) {
      const w = node.x1 - node.x0;
      const h = node.y1 - node.y0;
      if (w <= 0 || h <= 0) continue;

      const isHovered = hoveredNode === node;
      const kind: TileKind = node.isParentHeader ? "header" : node.depth === 2 ? "inner" : "tile";

      ctx.fillStyle = tileFill(theme, hueFor(node), kind, isHovered);
      ctx.fillRect(node.x0, node.y0, w, h);

      if (isHovered) {
        ctx.strokeStyle = theme.focus;
        ctx.lineWidth = 2;
        ctx.strokeRect(node.x0 + 1, node.y0 + 1, w - 2, h - 2);
      }

      if (node.isParentHeader) {
        // Parent folder banner header
        ctx.fillStyle = theme.text;
        ctx.font = `600 12px ${font}`;
        const label = `${node.data.name}  ${formatBytes(node.data.size_bytes)}`;
        ctx.fillText(fitText(ctx, label, w - 10), node.x0 + 5, node.y0 + 14);
      } else if (w > 45 && h > 20) {
        // Regular tile (direct child or inner sub-tile): labels if sufficient room
        ctx.fillStyle = theme.text;
        ctx.font = `600 12px ${font}`;
        ctx.fillText(fitText(ctx, node.data.name, w - 10), node.x0 + 5, node.y0 + 15);

        if (h > 34) {
          ctx.fillStyle = theme.textSecondary;
          ctx.font = `12px ${font}`;
          ctx.fillText(fitText(ctx, formatBytes(node.data.size_bytes), w - 10), node.x0 + 5, node.y0 + 30);
        }
      }
    }

    ctx.restore();
  }, [dimensions, nodes, hoveredNode, theme]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setMousePos({ x: e.clientX, y: e.clientY });

    const found =
      nodes.find((n) => x >= n.x0 && x <= n.x1 && y >= n.y0 && y <= n.y1) || null;
    setHoveredNode(found);
  };

  const handleMouseLeave = () => {
    setHoveredNode(null);
  };

  const handleClick = () => {
    if (hoveredNode) {
      onSelectNode(hoveredNode.data);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (hoveredNode && onOpenExplorer) {
      onOpenExplorer(hoveredNode.data.path);
    }
  };

  // Top 5 largest direct children for legend
  const topLegendItems = useMemo(() => {
    if (!data || !data.children || data.children.length === 0) return [];
    const sorted = [...data.children].sort((a, b) => b.size_bytes - a.size_bytes);
    const colorScale = d3.scaleOrdinal(PALETTE);
    return sorted.slice(0, 5).map((item, idx) => ({
      ...item,
      color: tileFill(theme, item.is_dir ? colorScale(String(idx)) : FILE_HUE, "tile"),
      percentage: data.size_bytes > 0 ? ((item.size_bytes / data.size_bytes) * 100).toFixed(1) : "0",
    }));
  }, [data, theme]);

  const fillVars = (template: string, vars: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

  return (
    <div ref={containerRef} className="relative w-full space-y-3">
      <div className="rounded-md overflow-hidden bg-[var(--bg-card)] relative">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          className="cursor-pointer block"
        />

        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-muted)]">
            {t.storage.emptyView}
          </div>
        )}
      </div>

      {/* Top Items Legend Strip */}
      {topLegendItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-xs text-[var(--text-muted)] mr-1">{t.storage.topItems}</span>
          {topLegendItems.map((item) => (
            <button
              key={item.path}
              onClick={() => onSelectNode(item)}
              className="h-7 flex items-center gap-1.5 px-2 rounded-md hover:bg-[var(--fill-subtle)] border border-[var(--border-card)] transition-colors cursor-pointer text-xs"
            >
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: item.color }} />
              <span className="text-[var(--text-primary)] truncate max-w-[140px]">{item.name}</span>
              <span className="font-ibm-mono text-[var(--text-muted)] whitespace-nowrap tabular-nums">
                {formatBytes(item.size_bytes)} · {item.percentage}%
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Screen-Clamped Hover Tooltip */}
      {hoveredNode && (
        <div
          className="fixed z-50 pointer-events-none p-3 bg-[var(--bg-card)] border border-[var(--border-card)] rounded-lg shadow-lg text-xs space-y-1 max-w-sm"
          style={{
            left: `${Math.min(window.innerWidth - 320, mousePos.x + 14)}px`,
            top: `${Math.min(window.innerHeight - 150, mousePos.y + 14)}px`,
          }}
        >
          <div className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <span
              className="w-3 h-3 rounded-sm inline-block shrink-0"
              style={{
                backgroundColor: tileFill(
                  theme,
                  hueFor(hoveredNode),
                  hoveredNode.isParentHeader ? "header" : hoveredNode.depth === 2 ? "inner" : "tile"
                ),
              }}
            />
            <span className="truncate">{hoveredNode.data.name}</span>
            {hoveredNode.data.is_system_protected && (
              <span className="inline-flex items-center h-5 px-2 rounded text-xs font-medium bg-[color-mix(in_srgb,var(--brand-amber)_16%,transparent)] text-[var(--brand-amber)] shrink-0">
                {t.storage.protected}
              </span>
            )}
          </div>

          <div className="font-ibm-mono text-[var(--text-primary)] font-semibold flex items-center gap-2 tabular-nums">
            <span className="whitespace-nowrap">{formatBytes(hoveredNode.data.size_bytes)}</span>
            {data.size_bytes > 0 && (
              <span className="text-[var(--text-muted)] font-normal whitespace-nowrap">
                {fillVars(t.storage.tipOfView, {
                  pct: ((hoveredNode.data.size_bytes / data.size_bytes) * 100).toFixed(1),
                })}
              </span>
            )}
          </div>

          <div className="text-xs text-[var(--text-secondary)]">
            {hoveredNode.data.is_dir ? t.storage.tipFolder : t.storage.tipFile}
            {hoveredNode.data.is_dir && (
              <span> · {fillVars(t.storage.tipFiles, { count: hoveredNode.data.file_count.toLocaleString() })}</span>
            )}
          </div>

          <div className="font-code text-xs text-[var(--text-muted)] truncate pt-1 border-t border-[var(--border-divider)] mt-1">
            {hoveredNode.data.path}
          </div>
          <div className="text-xs text-[var(--text-secondary)]">{t.storage.tipHint}</div>
        </div>
      )}
    </div>
  );
};

export default TreemapCanvas;
