import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as d3 from "d3";

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

const PALETTE = [
  "#0078d4", // Windows Accent Blue
  "#8b5cf6", // Purple
  "#06b6d4", // Cyan
  "#10b981", // Emerald
  "#f59e0b", // Amber
  "#ec4899", // Pink
  "#6366f1", // Indigo
  "#14b8a6", // Teal
  "#f97316", // Orange
  "#0ea5e9", // Sky
];

export const TreemapCanvas: React.FC<TreemapCanvasProps> = ({
  data,
  onSelectNode,
  onOpenExplorer,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
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

    // Deep dark background
    ctx.fillStyle = "#121212";
    ctx.fillRect(0, 0, width, height);

    // Draw all rectangles
    for (const node of nodes) {
      const w = node.x1 - node.x0;
      const h = node.y1 - node.y0;
      if (w <= 0 || h <= 0) continue;

      const isHovered = hoveredNode === node;

      if (node.isParentHeader) {
        // Parent folder banner header
        ctx.fillStyle = node.color;
        ctx.globalAlpha = isHovered ? 0.95 : 0.85;
        ctx.fillRect(node.x0, node.y0, w, h);

        ctx.strokeStyle = isHovered ? "#ffffff" : "rgba(0,0,0,0.4)";
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.strokeRect(node.x0, node.y0, w, h);

        ctx.globalAlpha = 1.0;
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10.5px Inter, sans-serif";
        const label = `📁 ${node.data.name} (${formatBytes(node.data.size_bytes)})`;
        ctx.fillText(label, node.x0 + 4, node.y0 + 14, w - 8);
      } else {
        // Regular tile (direct child or inner sub-tile)
        ctx.fillStyle = isHovered ? "#38bdf8" : node.color;
        ctx.globalAlpha = node.depth === 2 ? (isHovered ? 0.95 : 0.65) : (isHovered ? 0.95 : 0.85);
        ctx.fillRect(node.x0, node.y0, w, h);

        ctx.strokeStyle = isHovered ? "#ffffff" : "rgba(0,0,0,0.35)";
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.strokeRect(node.x0, node.y0, w, h);

        // Labels if sufficient room
        if (w > 45 && h > 20) {
          ctx.globalAlpha = 1.0;
          ctx.fillStyle = "#ffffff";
          ctx.font = w > 70 ? "bold 11px Inter, sans-serif" : "bold 10px Inter, sans-serif";

          const icon = node.data.is_dir ? "📁 " : "📄 ";
          const label = `${icon}${node.data.name}`;
          ctx.fillText(label, node.x0 + 4, node.y0 + 13, w - 8);

          if (h > 36) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
            ctx.font = "10px JetBrains Mono, monospace";
            ctx.fillText(formatBytes(node.data.size_bytes), node.x0 + 4, node.y0 + 26, w - 8);
          }
        }
      }
    }

    ctx.restore();
  }, [dimensions, nodes, hoveredNode]);

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
      color: colorScale(String(idx)),
      percentage: data.size_bytes > 0 ? ((item.size_bytes / data.size_bytes) * 100).toFixed(1) : "0",
    }));
  }, [data]);

  return (
    <div ref={containerRef} className="relative w-full space-y-2">
      <div className="rounded-[4px] overflow-hidden border border-[var(--border-subtle)] bg-[#121212] shadow-inner relative">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          className="cursor-pointer block"
        />

        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-muted)] font-ibm-mono">
            No files or folders to display in current view
          </div>
        )}
      </div>

      {/* Top Items Legend Strip */}
      {topLegendItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1 px-1 text-xs">
          <span className="text-[11px] text-[var(--text-muted)] font-medium">Top Items:</span>
          {topLegendItems.map((item) => (
            <button
              key={item.path}
              onClick={() => onSelectNode(item)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-[3px] bg-black/20 hover:bg-white/[0.05] border border-[var(--border-card)] transition-colors cursor-pointer text-[11px]"
            >
              <span
                className="w-2 h-2 rounded-xs shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="font-ibm-mono text-[var(--text-primary)] truncate max-w-[120px]">
                {item.name}
              </span>
              <span className="font-ibm-mono text-[var(--text-secondary)]">
                {formatBytes(item.size_bytes)} ({item.percentage}%)
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Screen-Clamped Hover Tooltip */}
      {hoveredNode && (
        <div
          className="fixed z-50 pointer-events-none p-3 bg-[#1e1e1e]/95 border border-[#0078d4]/60 rounded-[6px] shadow-2xl text-xs backdrop-blur-md space-y-1 max-w-sm"
          style={{
            left: `${Math.min(window.innerWidth - 320, mousePos.x + 14)}px`,
            top: `${Math.min(window.innerHeight - 150, mousePos.y + 14)}px`,
          }}
        >
          <div className="font-semibold text-white flex items-center gap-2">
            <span
              className="w-3 h-3 rounded-xs inline-block shrink-0"
              style={{ backgroundColor: hoveredNode.color }}
            />
            <span className="truncate">{hoveredNode.data.name}</span>
            {hoveredNode.data.is_system_protected && (
              <span className="px-1.5 py-0.2 rounded-[3px] text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
                Protected
              </span>
            )}
          </div>

          <div className="font-ibm-mono text-cyan-300 font-bold flex items-center gap-2">
            <span>{formatBytes(hoveredNode.data.size_bytes)}</span>
            {data.size_bytes > 0 && (
              <span className="text-[var(--text-muted)] font-normal">
                ({((hoveredNode.data.size_bytes / data.size_bytes) * 100).toFixed(1)}% of view)
              </span>
            )}
          </div>

          <div className="text-[11px] text-[var(--text-secondary)] font-ibm-mono">
            {hoveredNode.data.is_dir ? "📁 Directory" : "📄 File"}
            {hoveredNode.data.is_dir && (
              <span> • {hoveredNode.data.file_count.toLocaleString()} files</span>
            )}
          </div>

          <div className="font-ibm-mono text-[10px] text-[var(--text-muted)] truncate pt-0.5 border-t border-[var(--border-divider)] mt-1">
            {hoveredNode.data.path}
          </div>
          <div className="text-[9px] text-[#0078d4] pt-0.5">
            Click to drill in • Right-click to open in Explorer
          </div>
        </div>
      )}
    </div>
  );
};

export default TreemapCanvas;
