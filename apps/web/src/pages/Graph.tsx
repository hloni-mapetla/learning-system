import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import cytoscape, { type Core } from 'cytoscape';
import { NOTE_KINDS } from '@loom/core/types';
import type { GraphEdge, GraphNode } from '@loom/core';
import { qs, useApi } from '../lib/api';
import { PageHeader, Select } from '../components/ui';

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const REL_COLOR: Record<string, string> = {
  supports: '--good',
  contradicts: '--again',
  example_of: '--easy',
  prerequisite_of: '--hard',
  related: '--muted',
  wikilink: '--faint',
  from_source: '--line',
};

export function GraphPage() {
  const params = useSearch({ strict: false }) as { focus?: string };
  const navigate = useNavigate();
  const [tag, setTag] = useState('');
  const [kind, setKind] = useState('');
  const [depth, setDepth] = useState(2);
  const [sourceEdges, setSourceEdges] = useState(true);
  const [hideIsolated, setHideIsolated] = useState(true);
  const tags = useApi<{ name: string }[]>('/tags');
  const { data } = useApi<GraphData>(
    `/graph${qs({ focus: params.focus, depth: params.focus ? depth : undefined, tag, kinds: kind, sourceEdges, hideIsolated: params.focus ? undefined : hideIsolated })}`,
  );
  const el = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);

  useEffect(() => {
    if (!el.current || !data) return;
    cy.current?.destroy();
    const accent = css('--accent');
    const c = cytoscape({
      container: el.current,
      elements: [
        ...data.nodes.map((n) => ({
          data: { id: n.id, label: n.title.length > 40 ? n.title.slice(0, 38) + '…' : n.title, type: n.type, kind: n.kind, degree: n.degree, focus: n.id === params.focus ? 1 : 0 },
        })),
        ...data.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, rel: e.rel } })),
      ],
      style: [
        {
          selector: 'node',
          style: {
            'background-color': css('--faint'),
            label: 'data(label)',
            color: css('--ink'),
            'font-size': 10,
            'text-valign': 'bottom',
            'text-margin-y': 4,
            width: 'mapData(degree, 0, 20, 8, 28)',
            height: 'mapData(degree, 0, 20, 8, 28)',
            'text-max-width': '120px',
            'text-wrap': 'ellipsis',
            'min-zoomed-font-size': 7,
          },
        },
        { selector: 'node[type = "source"]', style: { shape: 'round-rectangle', 'background-color': accent, width: 22, height: 22, 'font-weight': 'bold' } },
        { selector: 'node[kind = "concept"], node[kind = "claim"]', style: { 'background-color': css('--easy') } },
        { selector: 'node[kind = "highlight"]', style: { 'background-color': css('--hard'), width: 7, height: 7 } },
        { selector: 'node[focus = 1]', style: { 'border-width': 3, 'border-color': css('--ink') } },
        {
          selector: 'edge',
          style: { width: 1.2, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, opacity: 0.8 },
        },
        ...Object.entries(REL_COLOR).map(([rel, v]) => ({
          selector: `edge[rel = "${rel}"]`,
          style: { 'line-color': css(v), 'target-arrow-color': css(v) },
        })),
        { selector: 'edge[rel = "from_source"]', style: { 'target-arrow-shape': 'none', 'line-style': 'dotted', width: 1 } },
        { selector: 'edge[rel = "contradicts"], edge[rel = "supports"]', style: { width: 2 } },
        { selector: '.faded', style: { opacity: 0.12 } },
      ] as any,
      layout: { name: 'cose', animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 110, nodeOverlap: 20, padding: 30 } as any,
      wheelSensitivity: 0.3,
    });
    // Small graphs otherwise get zoomed to fill the canvas, with giant labels.
    if (c.zoom() > 1.3) {
      c.zoom(1.3);
      c.center();
    }
    c.on('tap', 'node', (e) => {
      const d = e.target.data();
      navigate({ to: d.type === 'note' ? '/notes/$id' : '/sources/$id', params: { id: d.id } });
    });
    c.on('mouseover', 'node', (e) => {
      const hood = e.target.closedNeighborhood();
      c.elements().not(hood).addClass('faded');
    });
    c.on('mouseout', 'node', () => c.elements().removeClass('faded'));
    cy.current = c;
    return () => c.destroy();
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageHeader
        title={params.focus ? 'Local graph' : 'Graph'}
        subtitle={data && `${data.nodes.length} items · ${data.edges.length} links${data.truncated ? ' (showing the most connected)' : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {params.focus ? (
              <>
                <Select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                  {[1, 2, 3].map((d) => <option key={d} value={d}>Depth {d}</option>)}
                </Select>
                <button className="text-accent" onClick={() => navigate({ to: '/graph' })}>Global graph</button>
              </>
            ) : (
              <>
                <Select value={tag} onChange={(e) => setTag(e.target.value)}>
                  <option value="">All topics</option>
                  {tags.data?.map((t) => <option key={t.name} value={t.name}>#{t.name}</option>)}
                </Select>
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">All kinds</option>
                  {NOTE_KINDS.map((k) => <option key={k}>{k}</option>)}
                </Select>
                <label className="flex items-center gap-1 text-muted"><input type="checkbox" checked={hideIsolated} onChange={(e) => setHideIsolated(e.target.checked)} /> hide unlinked</label>
              </>
            )}
            <label className="flex items-center gap-1 text-muted"><input type="checkbox" checked={sourceEdges} onChange={(e) => setSourceEdges(e.target.checked)} /> source clusters</label>
          </div>
        }
      />
      <div ref={el} className="h-[calc(100vh-11rem)] min-h-96 rounded-xl border border-line bg-panel" />
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-faint">
        <span><span className="text-good">━</span> supports</span>
        <span><span className="text-again">━</span> contradicts</span>
        <span><span className="text-easy">━</span> example of</span>
        <span><span className="text-hard">━</span> prerequisite of</span>
        <span>┄ from source</span>
        <span><span className="text-accent">■</span> source · <span className="text-easy">●</span> concept/claim · <span className="text-hard">●</span> highlight</span>
      </div>
    </div>
  );
}
