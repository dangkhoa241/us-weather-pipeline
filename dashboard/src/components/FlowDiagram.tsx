// SVG flow diagram for the "How it works" page (lib/howItWorks.ts holds the data). Nodes are keyboard buttons
// (Tab, Enter/Space; selecting the open node again closes its panel, so does a click on empty diagram space); where
// each part runs is shown by lane, border pattern and a text tag, never by color alone.
// Dots move along the edges to show data flowing; with prefers-reduced-motion there are no dots, only static arrows.
import { useId, useState, type KeyboardEvent, type MouseEvent } from "react";
import { NODES, WHERE, edgePath, type NodeId, type View } from "@/lib/howItWorks";

export type NodeBadges = Partial<Record<NodeId, string>>;
type Props = {
  view: View; desktop: boolean; reducedMotion: boolean; badges: NodeBadges;
  selected: NodeId | null; onOpen: (id: NodeId) => void; onBackground: () => void;
  nodeRef: (id: NodeId, el: SVGGElement | null) => void;
};

const STROKE: Record<string, string> = { aws: "stroke-foreground", local: "stroke-foreground/80", external: "stroke-muted-foreground" };

export function FlowDiagram({ view, desktop, reducedMotion, badges, selected, onOpen, onBackground, nodeRef }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [focused, setFocused] = useState<NodeId | null>(null);
  const layout = desktop ? view.desktop : view.mobile;
  const { w, h } = layout.node;
  const pos = (id: NodeId) => layout.at[id]!;
  const edges = view.edges.filter((e) => desktop || !e.mobile?.hidden)
    .map((e) => ({ e, ...edgePath(pos(e.from), pos(e.to), layout.node, desktop ? e.desktop : e.mobile) }));
  const key = (id: NodeId) => (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onOpen(id); }
  };
  // A click anywhere in the diagram that isn't on a node (lanes, edges, labels, empty space).
  const background = (ev: MouseEvent) => {
    if (!(ev.target as Element).closest("[data-flow-node]")) onBackground();
  };

  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className={`h-auto w-full ${desktop ? "" : "mx-auto max-w-[420px]"}`}
      role="group" aria-label={`${view.title} diagram: ${view.nodes.length} parts. Select one for details.`}
      data-flow-view={view.id} data-flow-layout={desktop ? "desktop" : "mobile"} data-motion={reducedMotion ? "reduced" : "animated"}
      onClick={background}>
      <defs>
        <marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
        </marker>
      </defs>

      {desktop && view.lanes.map((l) => (
        <g key={l.where} data-flow-lane={l.where}>
          <rect x={0} y={l.y} width={layout.width} height={l.h} className={l.where === "aws" ? "fill-muted/70" : "fill-muted/30"} />
          <text x={8} y={l.y + 16} className="fill-muted-foreground text-[11px] font-semibold uppercase tracking-wide">{WHERE[l.where].label}</text>
        </g>
      ))}
      {desktop && view.columns.map((c) => (
        <text key={c.label} x={c.x + c.w / 2} y={24} textAnchor="middle" className="fill-foreground text-[13px] font-semibold">{c.label}</text>
      ))}
      {desktop && view.columns.slice(1).map((c) => (
        <line key={c.label} x1={c.x} x2={c.x} y1={34} y2={layout.height - 8} className="stroke-border" strokeDasharray="2 6" />
      ))}

      {edges.map(({ e, d }) => (
        <path key={`${e.from}-${e.to}`} d={d} fill="none" className="stroke-muted-foreground" strokeWidth={1.5}
          strokeDasharray={e.dashed ? "5 4" : undefined} markerEnd={`url(#${uid}-arrow)`} data-flow-edge={`${e.from}>${e.to}`} />
      ))}
      {!reducedMotion && edges.map(({ e, d }, i) => (
        <circle key={`dot-${e.from}-${e.to}`} r={3.5} className="fill-primary" data-flow-dot>
          <animateMotion dur="3.6s" repeatCount="indefinite" begin={`-${((i * 0.53) % 3.6).toFixed(2)}s`} path={d} />
        </circle>
      ))}
      {desktop && edges.filter(({ e }) => e.label && !e.desktop?.hideLabel).map(({ e, mid }) => (
        <text key={`label-${e.from}-${e.to}`} x={e.desktop?.labelAt?.x ?? mid.x} y={e.desktop?.labelAt?.y ?? mid.y - 6}
          textAnchor={e.desktop?.labelAt?.anchor ?? "middle"} strokeWidth={4} strokeLinejoin="round"
          className="fill-muted-foreground stroke-background text-[11px] [paint-order:stroke]">{e.label}</text>
      ))}

      {view.nodes.map((id) => {
        const n = NODES[id];
        const p = pos(id);
        const where = WHERE[n.where];
        const badge = badges[id];
        return (
          <g key={id} ref={(el) => nodeRef(id, el)} role="button" tabIndex={0} className="cursor-pointer outline-none"
            aria-label={`${n.label} (${n.sub}), ${where.label}${badge ? `, ${badge}` : ""}. Show details.`}
            aria-haspopup="dialog" aria-expanded={selected === id} data-flow-node={id} data-where={n.where}
            onClick={() => onOpen(id)} onKeyDown={key(id)} onFocus={() => setFocused(id)} onBlur={() => setFocused(null)}>
            {focused === id && (
              <rect x={p.x - w / 2 - 5} y={p.y - h / 2 - 5} width={w + 10} height={h + 10} rx={13} fill="none" className="stroke-ring" strokeWidth={2.5} />
            )}
            <rect x={p.x - w / 2} y={p.y - h / 2} width={w} height={h} rx={10} className={`fill-card ${selected === id ? "stroke-primary" : STROKE[n.where]}`}
              strokeWidth={selected === id ? 3 : n.where === "aws" ? 2 : 1.6} strokeDasharray={where.dash || undefined} />
            <text x={p.x} y={p.y - h / 2 + 13} textAnchor="middle" className="fill-muted-foreground text-[9px] font-semibold uppercase tracking-wider">{where.short}</text>
            <text x={p.x} y={p.y + 5} textAnchor="middle" className="fill-foreground text-[13px] font-semibold">{n.label}</text>
            <text x={p.x} y={p.y + 19} textAnchor="middle" className="fill-muted-foreground text-[10.5px]">{n.sub}</text>
            {badge && (
              <g data-flow-badge={id}>
                <circle cx={p.x - 62} cy={p.y + h / 2 + 11} r={3} className="fill-emerald-500" />
                <text x={p.x - 55} y={p.y + h / 2 + 14.5} className="fill-foreground text-[10px]">{badge}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
