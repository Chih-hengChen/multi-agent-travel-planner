import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const FEEDBACK_DIR = path.join(PROJECT_ROOT, "data", "feedback");
const SESSIONS_DIR = path.join(FEEDBACK_DIR, "sessions");
const SELF_EVAL_PATH = path.join(FEEDBACK_DIR, "llm-self-eval.jsonl");

export interface PlanSummary {
  destination: string;
  departureCity: string;
  days: number;
  numTravelers: number;
  budget: number;
  totalCost: number;
  withinBudget: boolean;
  hotelName?: string;
  transportMode?: string;
}

export interface TraceSummary {
  totalIters: number;
  toolCallCount: number;
  fallbackCount: number;
  phaseDistribution: Record<string, number>;
  errorCount: number;
}

export interface UserRating {
  score: number;
  feedback?: string;
  ratedAt: string;
}

export interface LlmSelfEval {
  ts: string;
  sid: string;
  scores: {
    completeness: number;
    diversity: number;
    budgetReasonableness: number;
    executability: number;
    creativity: number;
  };
  failureCategory?: string;
  notes?: string;
}

export interface SessionFeedback {
  sid: string;
  plan: PlanSummary;
  traceSummary: TraceSummary;
  userMessage: string;
  userRating?: UserRating;
  llmSelfEval?: LlmSelfEval;
  createdAt: string;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function saveSessionFeedback(sid: string, data: {
  plan: PlanSummary;
  traceSummary: TraceSummary;
  userMessage: string;
}) {
  ensureDir(SESSIONS_DIR);
  const existing = loadSessionFeedback(sid);
  const record: SessionFeedback = {
    sid,
    ...data,
    userRating: existing?.userRating,
    llmSelfEval: existing?.llmSelfEval,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${sid}.json`),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
}

export function loadSessionFeedback(sid: string): SessionFeedback | null {
  const p = path.join(SESSIONS_DIR, `${sid}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveUserRating(sid: string, rating: UserRating) {
  const record = loadSessionFeedback(sid);
  if (!record) return false;
  record.userRating = rating;
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${sid}.json`),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  return true;
}

export function saveLlmSelfEval(eval_: LlmSelfEval) {
  ensureDir(FEEDBACK_DIR);
  fs.appendFileSync(SELF_EVAL_PATH, JSON.stringify(eval_) + "\n", "utf-8");
  const record = loadSessionFeedback(eval_.sid);
  if (record) {
    record.llmSelfEval = eval_;
    fs.writeFileSync(
      path.join(SESSIONS_DIR, `${eval_.sid}.json`),
      JSON.stringify(record, null, 2),
      "utf-8",
    );
  }
}

export function listRatedSessions(): SessionFeedback[] {
  ensureDir(SESSIONS_DIR);
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
  return files
    .map(f => JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8")) as SessionFeedback)
    .filter(r => r.userRating)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
