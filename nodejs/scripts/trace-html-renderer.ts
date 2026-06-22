import { TOOL_FALLBACK_CHAIN } from "../src/tools/policy.js";
import type { ToolName } from "../src/tools/policy.js";
import type { SessionTrace } from "./trace-aggregator.js";
import { sumToolCalls } from "./trace-aggregator.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fallbackSource(tool: string, level: number): string {
  const chain = TOOL_FALLBACK_CHAIN[tool as ToolName];
  if (!chain || chain.length === 0) return "no fallback defined";
  return chain[level] ?? `beyond-chain (L${level})`;
}

function formatSummary(v: unknown, maxLen = 200): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string") return v.length > maxLen ? v.slice(0, maxLen) + "..." : v;
  const json = JSON.stringify(v, null, 2);
  return json.length > maxLen ? json.slice(0, maxLen) + "\n... (truncated)" : json;
}

interface ToolByLevel {
  tool: string;
  total: number;
  fallbackCount: number;
  rate: number;
  byLevel: Record<number, number>;
}

function toolByLevelStats(session: SessionTrace): ToolByLevel[] {
  const map = new Map<string, ToolByLevel>();
  for (const e of session.events) {
    if (e.type !== "tool_exec") continue;
    let s = map.get(e.tool);
    if (!s) { s = { tool: e.tool, total: 0, fallbackCount: 0, rate: 0, byLevel: {} }; map.set(e.tool, s); }
    s.total++;
    s.byLevel[e.fallbackLevel] = (s.byLevel[e.fallbackLevel] ?? 0) + 1;
    if (e.fallbackLevel > 0) s.fallbackCount++;
  }
  for (const s of map.values()) s.rate = s.total > 0 ? s.fallbackCount / s.total : 0;
  return Array.from(map.values()).sort((a, b) => a.tool.localeCompare(b.tool));
}

function renderCss(): string {
  return `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.5}
.top-bar{background:#1e293b;border-bottom:1px solid #334155;padding:12px 20px;position:sticky;top:0;z-index:10}
.top-bar .meta{display:flex;flex-wrap:wrap;gap:8px 20px;font-size:13px}
.top-bar .timeline{margin-top:6px;font-size:12px;color:#94a3b8}
.top-bar .warn{color:#f59e0b}
.top-bar .err{color:#ef4444}
.layout{display:grid;grid-template-columns:220px 1fr 280px;height:calc(100vh - 80px)}
.left-pane{background:#1e293b;border-right:1px solid #334155;overflow-y:auto;padding:8px}
.phase-group{margin-bottom:12px}
.phase-header{font-size:12px;text-transform:uppercase;color:#64748b;padding:4px 8px;font-weight:600}
.iter-item{list-style:none;padding:6px 12px;cursor:pointer;border-radius:4px;font-size:13px;display:flex;align-items:center;gap:6px}
.iter-item:hover{background:#334155}
.iter-item.selected{background:#1d4ed8;color:#fff}
.iter-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.iter-dot.err{background:#ef4444}
.iter-dot.fb{background:#f59e0b}
.center-pane{overflow-y:auto;padding:20px}
.thought{border-left:3px solid #6366f1;padding:8px 16px;margin-bottom:20px;background:#1e1b4b;border-radius:0 6px 6px 0}
.thought h3{font-size:14px;color:#818cf8;margin-bottom:8px}
.thought blockquote{font-size:14px;color:#c7d2fe;white-space:pre-wrap}
.tool-calls{margin-bottom:20px}
.tool-calls h3{font-size:14px;color:#94a3b8;margin-bottom:8px}
.tool-call{background:#1e293b;border:1px solid #334155;border-radius:6px;padding:10px;margin-bottom:8px}
.tool-header{display:flex;align-items:center;gap:10px;font-size:13px}
.tool-name{font-weight:600;color:#e2e8f0}
.duration{color:#64748b;font-size:12px}
.fallback-badge{border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.fallback-badge.ok{background:#065f46;color:#6ee7b7}
.fallback-badge.warn{background:#78350f;color:#fcd34d}
.fallback-badge.err{background:#7f1d1d;color:#fca5a5}
.fallback-badge.crit{background:#450a0a;color:#fecaca}
.amap-wait{color:#f59e0b;font-size:11px}
.tool-call .result{margin-top:8px}
.tool-call .result summary{font-size:12px;color:#64748b;cursor:pointer}
.tool-call .result pre{background:#0f172a;padding:8px;border-radius:4px;font-size:12px;max-height:200px;overflow-y:auto;margin-top:4px}
.errors{margin-bottom:20px}
.errors h3{font-size:14px;color:#ef4444;margin-bottom:8px}
.errors pre{background:#450a0a;padding:8px;border-radius:4px;font-size:12px;color:#fca5a5}
.right-pane{background:#1e293b;border-left:1px solid #334155;overflow-y:auto;padding:16px}
.right-pane h3{font-size:13px;color:#94a3b8;margin-bottom:10px}
.state-diff{list-style:none}
.state-diff li{padding:6px 0;border-bottom:1px solid #1e293b;font-size:12px}
.state-diff .field{color:#818cf8;display:block}
.state-diff .value{color:#cbd5e1;display:block;word-break:break-all}
.op-set .field{color:#34d399}
.op-append .field{color:#60a5fa}
.op-merge .field{color:#fbbf24}
.fallback-summary{background:#1e293b;border:1px solid #334155;border-radius:6px;padding:10px;margin-top:20px}
.fallback-summary summary{font-size:13px;color:#94a3b8;cursor:pointer;margin-bottom:8px}
.fallback-summary table{width:100%;font-size:11px;border-collapse:collapse}
.fallback-summary th,.fallback-summary td{text-align:left;padding:4px 8px;border-bottom:1px solid #1e293b}
.fallback-summary .ok{color:#6ee7b7}
.fallback-summary .warn{color:#fcd34d}
.empty-msg{color:#475569;font-size:13px;margin-top:80px;text-align:center}`;
}

function renderJs(session: SessionTrace): string {
  const iterData = session.iterCards.map((c) => ({
    i: c.iter,
    t: c.llmResponse?.thought ?? "",
    te: c.toolExecs.map((te) => ({
      n: te.tool,
      d: te.durationMs,
      l: te.fallbackLevel,
      ln: fallbackSource(te.tool, te.fallbackLevel),
      s: formatSummary(te.resultSummary),
      w: te.amapWaitMs ?? 0,
    })),
    sc: c.stateChanges.map((sc) => ({ f: sc.field, o: sc.op, v: formatSummary(sc.valueSummary, 80) })),
    er: c.errors.map((e) => e.error),
  }));
  const fbs = toolByLevelStats(session);
  return `const D=${JSON.stringify(iterData)},F=${JSON.stringify(fbs)};
function S(n){document.querySelectorAll(".iter-item").forEach(e=>e.classList.toggle("selected",+e.dataset.iter===n));C(n);R(n)}
function C(n){var d=D[n];if(!d)return;document.getElementById("ct").textContent=d.t||"(no thought)";var el=document.getElementById("ctl"),t=el.parentElement.querySelector("h3");t.textContent="Tool calls ("+d.te.length+")";el.innerHTML=d.te.length?d.te.map(function(t){return'<li class="tool-call"><div class="tool-header"><span class="tool-name">'+t.n+'</span><span class="duration">'+t.d+'ms</span><span class="fallback-badge '+(t.l==0?"ok":t.l==1?"warn":"err")+'" title="L'+t.l+' = '+t.ln+'">L'+t.l+"●</span>"+(t.w?'<span class="amap-wait">+'+t.w+"ms</span>":"")+'</div><details class="result"><summary>Result</summary><pre>'+t.s.replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</pre></details></li>"}).join(""):'<li class="empty-msg">no tool calls</li>';var ee=document.getElementById("ce");ee.hidden=!d.er.length;if(d.er.length)ee.querySelector("pre").textContent=d.er.join("\\n")}
function R(n){var d=D[n];if(!d)return;var el=document.getElementById("rd");el.innerHTML=d.sc.length?d.sc.map(function(s){return'<li class="op-'+s.o+'"><span class="field">'+s.f+'</span><span class="op">'+s.o+'</span><span class="value">'+s.v.replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</span></li>"}).join(""):'<div class="empty-msg">no state changes</div>'}
document.addEventListener("DOMContentLoaded",function(){document.querySelectorAll(".iter-item").forEach(function(e){e.addEventListener("click",function(){S(+e.dataset.iter)})});document.getElementById("fbt").innerHTML=F.map(function(f){return'<tr><td>'+f.tool+'</td><td>'+f.total+'</td><td>'+f.fallbackCount+'</td><td class="'+(f.rate>0.3?"warn":f.rate==0?"ok":"")+'">'+(f.rate*100).toFixed(1)+'%</td><td>'+Object.entries(f.byLevel).map(function(e){return"L"+e[0]+":"+e[1]}).join(" ")+'</td></tr>'}).join("");S(0)})`;
}

function renderTopBar(session: SessionTrace): string {
  const tl = session.phaseTimeline.map((s) => `${s.phase}(${s.iterCount})`).join(" → ");
  const totalCalls = sumToolCalls(session.stats.toolCallCount);
  const fr = session.stats.fallbackRate;
  const frCls = fr > 0.3 ? "warn" : "";
  const errCls = session.stats.errorCount > 0 ? "err" : "";
  return `<header class="top-bar">
<div class="meta">
<span>Session: ${esc(session.sid)}</span>
<span>Iters: ${session.stats.totalIters}</span>
<span>Duration: ${(session.stats.durationMs / 1000).toFixed(1)}s</span>
<span>Tool calls: ${totalCalls}</span>
<span class="${frCls}">Fallback rate: ${(fr * 100).toFixed(1)}%</span>
<span class="${errCls}">Errors: ${session.stats.errorCount}</span>
</div>
<div class="timeline">${esc(tl)}</div></header>`;
}

function renderLeftPane(session: SessionTrace): string {
  let html = '<aside class="left-pane">';
  for (const seg of session.phaseTimeline) {
    const cards = session.iterCards.filter((c) => c.iter >= seg.startIter && c.iter <= seg.endIter);
    html += `<div class="phase-group"><div class="phase-header">${seg.phase} (${cards.length})</div><ul>`;
    for (const c of cards) {
      const hasErr = c.errors.length > 0;
      const hasFb = c.toolExecs.some((te) => te.fallbackLevel > 0);
      const dotCls = hasErr ? "err" : hasFb ? "fb" : "";
      html += `<li class="iter-item" data-iter="${c.iter}"><span class="iter-dot ${dotCls}"></span>iter ${c.iter}</li>`;
    }
    html += "</ul></div>";
  }
  html += "</aside>";
  return html;
}

function renderCenterPane(): string {
  return `<main class="center-pane">
<section class="thought"><h3>Thought</h3><blockquote id="ct"></blockquote></section>
<section class="tool-calls"><h3>Tool calls (0)</h3><ul id="ctl"></ul></section>
<section class="errors" id="ce" hidden><h3>Errors</h3><pre></pre></section>
</main>`;
}

function renderRightPane(session: SessionTrace): string {
  const stats = toolByLevelStats(session);
  let fbHtml = "";
  if (stats.length > 0) {
    fbHtml = `<details class="fallback-summary">
<summary>Fallback distribution</summary>
<table><thead><tr><th>Tool</th><th>Calls</th><th>FB</th><th>Rate</th><th>By Level</th></tr></thead>
<tbody id="fbt"></tbody></table></details>`;
  }
  return `<aside class="right-pane">
<h3>State diff</h3>
<ul class="state-diff" id="rd"></ul>
${fbHtml}
</aside>`;
}

export function renderHtml(session: SessionTrace): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trace — ${esc(session.sid)}</title>
<style>${renderCss()}</style>
</head>
<body>
${renderTopBar(session)}
<div class="layout">
${renderLeftPane(session)}
${renderCenterPane()}
${renderRightPane(session)}
</div>
<script>${renderJs(session)}</script>
</body>
</html>`;
}
