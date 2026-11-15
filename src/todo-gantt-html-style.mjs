export const CSS = `
:root{
  color-scheme:light;
  --surface-1:#fcfcfb;
  --surface-2:#f4f4f2;
  --text-primary:#0b0b0b;
  --text-secondary:#52514e;
  --border:#d9d8d4;
  --accent:#2a78d6;
  --good:#0ca30c;
  --critical:#d03b3b;
  font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif;
  font-size:13.5px;
  font-weight:400;
  line-height:1.6;
}
*{box-sizing:border-box}
body{display:grid;grid-template-rows:minmax(0,1fr);height:100vh;margin:0;background:var(--surface-1);color:var(--text-primary)}
.shell{display:grid;grid-template-columns:minmax(0,var(--split,58%)) auto minmax(24rem,1fr);min-width:0;min-height:0}
.gantt-pane{display:grid;grid-template-rows:auto auto minmax(0,1fr);min-width:0;min-height:0;overflow:hidden;background:var(--surface-1)}
.pane-divider{width:8px;cursor:col-resize;background:rgba(217,216,212,.5);touch-action:none}
.diagram-toolbar{z-index:3;display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface-2);color:var(--text-secondary)}
/* 監査前の札が入って以降、ツールバーは幅の奪い合いになる。操作系は縮ませない——
   縮むと「等倍」「全体表示」が2行に折れて、押せるが読みにくい形になる。削るのは札の側で、
   そちらはellipsisと件数の下限を持っている。 */
.diagram-toolbar button{flex:0 0 auto;white-space:nowrap;min-height:32px;padding:0 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-2);color:var(--text-primary);font:500 12px/1.6 system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif}
.diagram-toolbar button:focus-visible{outline:2px solid var(--text-primary);outline-offset:2px}
.zoom-readout{min-width:48px;text-align:center;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.diagram-note{margin-left:auto;color:var(--text-secondary);font-size:12px;font-weight:500}
.project-heading{margin-right:8px;color:var(--text-primary);font-size:13px;font-weight:650;white-space:nowrap}
.audit-pending-chip{flex:0 1 auto;min-width:9em;max-width:30em;overflow:hidden;padding:2px 8px;border:1px solid var(--critical);border-radius:9999px;background:var(--surface-1);color:var(--critical);font-size:12px;font-weight:650;white-space:nowrap;text-overflow:ellipsis}.status-symbol.status-in-progress{color:var(--accent)}.status-symbol.status-done{color:var(--good)}.status-symbol.status-blocked{color:var(--critical)}
.diagram-legend{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface-1);color:var(--text-secondary);font-size:12px;font-weight:500}
.diagram-legend>span{white-space:nowrap}.diagram-legend>p{flex:1 0 100%;margin:0;font-weight:400}
.category-legend{margin-left:auto}.category-legend summary{cursor:pointer;color:var(--text-primary)}
.category-legend dl{position:absolute;z-index:4;right:16px;max-width:38rem;margin:8px 0 0;padding:12px 16px;border:1px solid var(--border);background:var(--surface-1);box-shadow:0 4px 16px rgba(11,11,11,.12)}
.category-entry+ .category-entry{margin-top:8px}.category-entry dt{color:var(--text-primary)}.category-entry dd{margin:0;color:var(--text-secondary);font-weight:400}
.diagram-scroll{min-width:0;min-height:0;max-width:calc(100% - 16px);margin:8px;overflow:auto;overscroll-behavior:contain;border:1px solid rgba(217,216,212,.5)}
.todo-gantt{display:block;max-width:none}
.narrative-pane{min-width:0;overflow:auto;background:var(--surface-1)}
[hidden]{display:none!important}
.right-toolbar{position:sticky;z-index:3;top:0;display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface-1)}
.right-toolbar button,.relation-list button,.active-list button,.task-index-list button{padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-2);color:var(--text-primary);font:500 12px/1.6 system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif;text-align:left;cursor:pointer}
.right-toolbar button:focus-visible,.relation-list button:focus-visible,.active-list button:focus-visible,.task-index-list button:focus-visible{outline:2px solid var(--text-primary);outline-offset:2px}
.right-content{max-width:72ch;margin:0 auto;padding:16px 24px 48px}
.right-overview h1,.task-detail h1{margin:0 0 16px;font-size:19px;font-weight:650;line-height:1.45}
.right-overview h2,.task-detail h2{margin:24px 0 8px;font-size:16px;font-weight:600}
.status-summary{display:flex;flex-wrap:wrap;gap:8px 16px;margin:16px 0;padding:12px;background:var(--surface-2)}
.seam-overview{margin:24px 0}.seam-overview>h2{margin-bottom:8px}
.seam-plan{margin:8px 0;padding:12px;border:1px solid var(--border);border-left:4px solid var(--accent);background:var(--surface-2)}
.seam-plan>header{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}.seam-plan>header>code{font-weight:650}.seam-component-count{margin-left:auto;color:var(--text-secondary);font-size:12px}
.seam-coverage{padding:1px 7px;border:1px solid var(--border);border-radius:9999px;background:var(--surface-1);font-size:11px;font-weight:650}.seam-coverage.coverage-missing,.seam-coverage.coverage-stale,.seam-coverage.coverage-superseded{border-color:var(--critical);color:var(--critical)}
.seam-guidance,.seam-next-action{margin:6px 0 0;color:var(--text-secondary);font-size:12px}.seam-next-action code{color:var(--text-primary);font-weight:650}
.seam-component{margin-top:10px;padding:10px;border:1px solid var(--border);border-left:4px solid var(--text-secondary);background:var(--surface-1)}.seam-component.verdict-seam_candidate{border-left-color:var(--good)}.seam-component.verdict-intentional_serial{border-left-color:var(--critical)}.seam-component.verdict-unknown_requires_evidence{border-left-color:var(--accent)}
.seam-component>header{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;font-weight:650}.seam-component>header code{overflow-wrap:anywhere}
.seam-conflicts,.seam-evidence-needed ul,.seam-reasons ul,.seam-surfaces ul{margin:8px 0 0;padding:0;list-style:none}.seam-conflict{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:8px;border:1px solid var(--border)}.seam-conflict+.seam-conflict{margin-top:6px}
.seam-target{font-size:13.5px;overflow-wrap:anywhere}.seam-conflict-kind{color:var(--text-secondary);font-size:11px}.seam-pairs{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:4px 10px}.seam-task-pair{font-weight:650}
.seam-evidence-needed,.seam-reasons,.seam-surfaces{margin-top:10px}.seam-evidence-needed h4,.seam-reasons h4,.seam-surfaces h4{margin:0;font-size:12px}.seam-evidence-needed li,.seam-reasons li,.seam-surfaces li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:5px 8px;background:var(--surface-2)}.seam-evidence-needed li+li,.seam-reasons li+li,.seam-surfaces li+li{margin-top:4px}.seam-evidence-needed li>code{font-weight:650}.seam-evidence-needed li>span,.seam-reasons li>span,.seam-surfaces li>span{color:var(--text-secondary)}
.seam-tests{margin:8px 0 0;color:var(--text-secondary);font-size:12px}.seam-empty-group{margin-top:8px;border-top:1px solid var(--border)}.seam-empty-group>summary{display:flex;gap:10px;padding:8px 0;cursor:pointer;color:var(--text-secondary)}.seam-empty-group>summary span{margin-left:auto}.seam-plan-compact{border-left-width:1px}
.phase-overview>p{color:var(--text-secondary)}.phase-overview>ol{display:grid;gap:8px;margin:0;padding:0;list-style:none}.phase-progress{padding:10px 12px;border:1px solid var(--border);border-left-width:4px;background:var(--surface-2)}.phase-progress>header{display:flex;justify-content:space-between;gap:12px}.phase-progress>p{margin:4px 0;color:var(--text-secondary);font-size:12px}.phase-progress progress{display:block;width:100%}.phase-progress.status-accepted{border-left-color:var(--good)}.phase-progress.status-reviewing,.phase-progress.status-gate_ready{border-left-color:var(--accent)}.phase-progress.status-rejected{border-left-color:var(--critical)}
.active-list,.relation-list{margin:0;padding:0;list-style:none}.active-list li+li,.relation-list li+li{margin-top:8px}
.active-list button{width:100%}.anchor-status,.readiness-note,.category-description,.relation-empty{color:var(--text-secondary)}
.task-detail>header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}.detail-status,.detail-reference{font-size:12px;font-weight:600}.detail-reference{color:var(--text-secondary)}
.work-log{margin-top:24px;padding-top:1px;border-top:1px solid var(--border)}
.work-log-entry{margin-top:10px;padding:12px;border:1px solid var(--border);border-left:4px solid var(--accent);background:var(--surface-2)}
.work-log-entry>header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 12px;color:var(--text-secondary);font-size:12px;font-weight:600}
.work-log-body{overflow-wrap:anywhere}.work-log-body pre{max-width:100%;overflow:auto;padding:8px;background:var(--surface-1)}.work-log-body code{overflow-wrap:anywhere}
.work-log-origin,.work-log-head,.note-warning{color:var(--text-secondary);font-size:12px;overflow-wrap:anywhere}.note-warning{color:var(--critical)}
.gantt-warning{margin:16px 0;padding:12px;border:1px solid var(--critical);background:var(--surface-2)}.gantt-warning h2{margin:0 0 8px}.gantt-warning ul{margin:0;padding-left:20px}
.relation-list button{display:flex;width:100%;flex-direction:column}.relation-list button span{font-weight:400}.relation-kind{display:block;margin-top:4px;color:var(--text-secondary);font-size:12px}
.relation-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}.relation-status{color:var(--text-secondary);font-size:12px;font-weight:600;white-space:nowrap}.relation-status.status-in-progress{color:var(--accent)}.relation-status.status-done{color:var(--good)}.relation-status.status-blocked{color:var(--critical)}
.task-diagnostics{margin:16px 0;color:var(--text-secondary);font-size:12px}.task-diagnostics summary{cursor:pointer;color:var(--text-primary);font-weight:600}.task-diagnostics dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px}.task-diagnostics dd{margin:0;overflow-wrap:anywhere}
.task-index>h1{margin:0 0 8px;font-size:19px;font-weight:650;line-height:1.45}.task-index>p{margin:0 0 24px;color:var(--text-secondary)}
.task-index-plan+.task-index-plan{margin-top:32px}.task-index-plan h2{margin:0 0 12px;font-size:16px;font-weight:600}.task-index-plan h2 code{font-size:inherit}
.task-index-list{margin:0;padding:0;list-style:none}.task-index-list li+li{margin-top:8px}.task-index-list button{display:grid;width:100%;grid-template-columns:1.5rem auto minmax(0,1fr);gap:4px 8px;align-items:baseline}
.task-index-status{grid-row:1 / span 2;color:var(--text-secondary);font-size:13.5px;text-align:center}.task-index-status.status-in-progress{color:var(--accent)}.task-index-status.status-done{color:var(--good)}.task-index-status.status-blocked{color:var(--critical)}
.task-index-reference{color:var(--text-secondary);font-size:12px;white-space:nowrap}.task-index-list strong{font-size:13.5px;font-weight:600;overflow-wrap:anywhere}.task-index-blocked-reason{grid-column:2 / -1;color:var(--text-secondary);font-size:12px;overflow-wrap:anywhere}
.structure-inspection>h1,.structure-noscript>h1{margin:0 0 8px;font-size:19px}.structure-inspection>p{color:var(--text-secondary)}
.structure-plan{margin:18px 0;border:1px solid var(--border);background:var(--surface-1)}.structure-plan>summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:10px 12px;cursor:pointer;background:var(--surface-2)}.structure-plan>summary>code{font-weight:700}.structure-plan>summary>span{color:var(--text-secondary);font-size:12px}
.structure-verdict{padding:1px 7px;border:1px solid var(--border);border-radius:9999px}.structure-verdict.verdict-consistent{border-color:var(--good);color:var(--good)}.structure-verdict.verdict-inconsistent,.structure-verdict.verdict-unreadable{border-color:var(--critical);color:var(--critical)}.structure-verdict.verdict-unknown,.structure-verdict.verdict-stale{border-color:var(--accent);color:var(--accent)}
.structure-findings,.structure-graph,.structure-actions{margin:0;padding:12px;border-top:1px solid var(--border)}.structure-findings h3,.structure-graph h3{margin:0 0 8px;font-size:14px}.structure-findings ol,.structure-edge-list,.structure-actions ul,.structure-node details ul{margin:0;padding:0;list-style:none}
.structure-finding{padding:9px;border-left:4px solid var(--accent);background:var(--surface-2)}.structure-finding+.structure-finding{margin-top:7px}.structure-finding.severity-error{border-left-color:var(--critical)}.structure-finding.severity-notice{border-left-color:var(--good)}.structure-finding>header{display:flex;justify-content:space-between;gap:10px}.structure-finding>p{margin:5px 0 0;color:var(--text-secondary);font-size:12px}.structure-finding-targets{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px}
.structure-finding-targets button,.structure-finding-edge-targets button,.structure-edge-list button{max-width:100%;padding:2px 5px;border:1px solid var(--border);background:var(--surface-1);cursor:pointer}.structure-finding-targets code,.structure-finding-edge-targets code,.structure-edge-list code{overflow-wrap:anywhere}.structure-finding-edge-targets{display:grid;gap:4px;margin-top:5px}.structure-finding-edge-targets button{text-align:left}
.structure-node-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:8px}.structure-node{min-width:0;padding:9px;border:1px solid var(--border);border-left:4px solid var(--text-secondary);background:var(--surface-2);scroll-margin:56px}.structure-node.kind-task_transform{border-left-color:var(--accent)}.structure-node.kind-data{border-left-color:var(--critical)}.structure-node.kind-code,.structure-node.kind-source_symbol{border-left-color:var(--text-primary)}.structure-node.kind-external{border-left-color:var(--text-secondary)}.structure-node.kind-changeset{border-left-color:var(--good)}.structure-node.focused{outline:3px solid var(--critical);outline-offset:2px}.structure-node>header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 8px}.structure-node>header>span{font-weight:700}.structure-node>header>code{max-width:100%;overflow-wrap:anywhere;color:var(--text-secondary)}.structure-node>p{margin:5px 0;font-size:12px}.structure-node details{margin-top:6px}.structure-node details summary{cursor:pointer}.structure-node details li{overflow-wrap:anywhere}
.structure-edge-list{display:grid;gap:5px}.structure-edge-list li{display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:5px;padding:6px;background:var(--surface-2);scroll-margin:56px}.structure-edge-list li.focused{outline:3px solid var(--critical);outline-offset:2px}.structure-edge-list li>span:first-child{color:var(--text-secondary);font-size:11px}.structure-actions summary{cursor:pointer;font-weight:650}.structure-actions li+li{margin-top:5px}.structure-severity-error{color:var(--critical)}.structure-noscript{margin:16px 24px;padding:12px;border:1px solid var(--critical)}
.todo-gantt text{font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif;pointer-events:none}
.todo-node .node-surface{fill:var(--surface-2);stroke:var(--border);stroke-width:1}
.todo-node .node-meta{fill:var(--text-secondary);font-size:12px;font-weight:500}
.todo-node .node-title{fill:var(--text-primary);font-size:13.5px;font-weight:400}
.todo-node .node-title-line{font-size:13.5px;font-weight:400}
.todo-node .status-mark{fill:var(--text-secondary);font-size:13.5px;font-weight:400}
.fold-chip{padding:2px 8px;border:1px solid var(--border);border-radius:9999px;background:var(--surface-2);color:var(--text-primary);font:650 13.5px/1.6 system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif}
button.fold-chip{cursor:pointer}button.fold-chip:focus-visible{outline:2px solid var(--text-primary);outline-offset:2px}
button.fold-chip[aria-expanded="true"]{border-color:var(--text-primary)}
[data-diagram][hidden]{display:none}
.fold-note{flex:1 0 100%;margin:4px 0 0;color:var(--text-secondary);font-weight:400}
.task-index-folded{margin-top:8px}
.task-index-folded>summary,.phase-settled>summary{cursor:pointer;padding:6px 0;color:var(--text-secondary);font-weight:600}
.phase-settled>summary:focus-visible{outline:2px solid var(--text-primary);outline-offset:2px}
.status-in-progress .node-surface{fill:var(--surface-1);stroke:var(--accent);stroke-width:2}
.status-in-progress .status-mark{fill:var(--accent)}
.status-in-progress .status-bar{stroke:var(--accent);stroke-width:2;stroke-linecap:round}
.status-done .node-surface{fill:var(--surface-2);stroke:var(--border);stroke-width:1}
.status-done .status-mark{fill:var(--good)}
.connections ul{margin:4px 0 8px;padding-left:18px}.connection time{color:var(--text-secondary);font-size:12px;white-space:nowrap}.connection-chip{display:inline-block;margin-left:6px;padding:0 8px;border:1px solid var(--accent);border-radius:9999px;color:var(--accent);font-size:12px;white-space:nowrap}
.status-blocked .node-surface{fill:var(--surface-1);stroke:var(--critical);stroke-width:2}
.status-blocked .status-mark{fill:var(--critical)}
.next-ready-node .node-surface{stroke:var(--accent);stroke-width:2;stroke-dasharray:4 3}
/* 独立性は記号と色で示す。枠線はstatusとready frontierが使い切っている（ADR 0129）。 */
.independence-badge{font-size:10px;font-weight:600;letter-spacing:0.02em}
.independence-verified .independence-badge{fill:var(--good)}
.independence-conflict .independence-badge{fill:var(--critical)}
.independence-unknown .independence-badge{fill:var(--text-secondary)}
.todo-node:focus .node-surface,.selected-node .node-surface{stroke:var(--text-primary);stroke-width:2.5}
.dependency-edge .edge-route{fill:none;stroke:var(--text-secondary);stroke-width:1.5;stroke-linejoin:round;opacity:.4}
.dependency-edge .edge-arrow{fill:var(--text-secondary);opacity:.7}
.longest-chain-edge .edge-route,.selected-incident-edge .edge-route{stroke:var(--text-primary);stroke-width:2.5;opacity:1}
.longest-chain-edge .edge-arrow,.selected-incident-edge .edge-arrow{fill:var(--text-primary);opacity:1}
.join-marker circle{fill:var(--text-primary);stroke:none}
.join-contact-marker{fill:var(--text-primary);stroke:none}.join-connector .edge-route{fill:none;stroke:var(--text-secondary);stroke-width:1.5;opacity:.7}
.summary-container{fill:var(--surface-1);stroke:var(--border);stroke-width:1;stroke-opacity:.5}
.summary-chip{fill:var(--surface-2);stroke:none}
.summary-plan text{fill:var(--text-primary);font-size:12px;font-weight:500}
.summary-lane text{fill:var(--text-secondary);font-size:12px;font-weight:500}
.summary-lane{cursor:pointer}
.lane-dimmed{opacity:.35}
@media(max-width:900px){body{display:block;height:auto}.shell{display:block}.pane-divider{display:none}.gantt-pane,.narrative-pane{height:70vh}.gantt-pane{border-bottom:1px solid var(--border)}}
`;

// 階層を持つplanだけが読み込む。親無しplanのHTML/CSS bytesを変えないため、基底CSSへは混ぜない。
export const NESTED_CSS = `
.nested-task-panel{filter:drop-shadow(0 4px 12px rgba(11,11,11,.18))}
.nested-task-surface{fill:var(--surface-1);stroke:var(--text-secondary);stroke-width:1.5}
.nested-task-label{fill:var(--text-primary);font-size:12px;font-weight:650}
.nested-task-link{fill:none;stroke:var(--text-secondary);stroke-width:1.5;stroke-dasharray:4 3}
.nested-task-diagram{outline:1px solid var(--border);background:var(--surface-1)}
.nested-task-toggle{cursor:pointer}
.nested-task-toggle rect{fill:var(--surface-1);stroke:var(--text-secondary);stroke-width:1.5}
.nested-task-toggle text{fill:var(--text-primary);font-size:14px;font-weight:650}
.nested-task-toggle:focus rect{stroke:var(--text-primary);stroke-width:2.5}
`;
