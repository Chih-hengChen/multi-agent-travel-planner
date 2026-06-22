import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSessions, readTraceJsonl, buildSessionTrace } from "./trace-aggregator.js";
import { renderHtml } from "./trace-html-renderer.js";

interface CliArgs {
  sid?: string;
  latest?: boolean;
  all?: boolean;
  watch?: boolean;
  open?: boolean;
  traceDir: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { traceDir: "data/trace", outDir: "data/trace-viewer" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sid") args.sid = argv[++i];
    else if (a === "--latest") args.latest = true;
    else if (a === "--all") args.all = true;
    else if (a === "--watch") args.watch = true;
    else if (a === "--open") args.open = true;
    else if (a === "--trace-dir") args.traceDir = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else throw new Error(`Unknown arg: ${a}`);
  }
  const selectors = [args.sid, args.latest, args.all].filter(Boolean).length;
  if (selectors === 0) { printHelp(); process.exit(1); }
  if (selectors > 1) throw new Error("--sid / --latest / --all are mutually exclusive");
  return args;
}

function printHelp(): void {
  console.log(`trace-viewer — render agent loop trace jsonl as interactive HTML

Usage:
  npx tsx scripts/trace-viewer.ts [options]

Options:
  --sid <id>       render a specific session
  --latest         render the most recent session
  --all            render all sessions
  --trace-dir <d>  trace directory (default: data/trace)
  --out-dir <d>    output directory (default: data/trace-viewer)
  --watch          re-render on file change (only with --sid)
  --open           open in browser after render
  -h, --help       show this help`);
}

function openInBrowser(outPath: string): void {
  const { exec } = require("node:child_process");
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} "${outPath}"`);
}

async function main() {
  const args = parseArgs(process.argv);
  const sessions = listSessions(args.traceDir);

  if (sessions.length === 0) {
    console.warn(`[trace-viewer] No sessions found in ${args.traceDir}.`);
    console.warn(`  Use --trace-dir scripts/_trace-fixtures to preview with mock data.`);
    process.exit(0);
  }

  let targets = args.all ? sessions
    : args.latest ? [sessions[0]]
    : sessions.filter((s) => s.sid === args.sid);

  if (args.sid && targets.length === 0) {
    console.error(`[trace-viewer] Session "${args.sid}" not found.`);
    process.exit(1);
  }

  mkdirSync(args.outDir, { recursive: true });

  for (const s of targets) {
    const events = readTraceJsonl(join(args.traceDir, `${s.sid}.jsonl`));
    const session = buildSessionTrace(s.sid, events);
    const html = renderHtml(session);
    const outPath = join(args.outDir, `${s.sid}.html`);
    writeFileSync(outPath, html, "utf8");
    const sizeKb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
    console.log(`[OK] ${outPath}  (${sizeKb}KB, ${session.stats.totalIters} iters, ${session.stats.totalEvents} events)`);
    if (args.open && targets.length === 1) openInBrowser(outPath);
  }

  if (args.watch && args.sid) {
    const { watch } = require("node:fs");
    const filePath = join(args.traceDir, `${args.sid}.jsonl`);
    let timer: ReturnType<typeof setTimeout>;
    console.log(`[trace-viewer] watching ${filePath}...`);
    watch(filePath, () => {
      clearTimeout(timer);
      timer = setTimeout(() => main().catch(console.error), 500);
    });
  }
}

main().catch((err) => {
  console.error("[trace-viewer]", err.message);
  process.exit(1);
});
