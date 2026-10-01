#!/usr/bin/env bun
/**
 * render.ts — writes the delivery section of this README from `delivery.json`.
 *
 *   bun scripts/render.ts --json <path> [--readme README.md]
 *                         [--block-out <path>] [--now <ISO time>]
 *   bun scripts/render.ts --json <path> --check     (validate only, write nothing)
 *
 * The JSON is validated against `data/delivery.schema.json` (a closed schema: counts,
 * dates, bounded means, flags and enums) before anything is written. An invalid JSON exits 1 and leaves
 * every file untouched. Everything above `<!-- delivery:start -->` is hand-written and
 * is kept byte for byte; the section between the markers is replaced. A README with no
 * markers gets them appended once, at the end.
 *
 * `--block-out` also writes the generated section alone (no markers), so it can be
 * screened as plain markdown. `--now` fixes the clock, for tests.
 *
 * The output depends on the JSON and on whether the reading is older
 * than 48 hours, so an hourly run over an unchanged JSON changes the README once: when
 * that reading crosses 48 hours.
 *
 * `--check --require-recent` also exits 4 when the reading is older than 48 hours, so
 * the workflow can fail on a feed that is still served but no longer updated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

export const START = "<!-- delivery:start -->";
export const END = "<!-- delivery:end -->";
export const OLD_AFTER_HOURS = 48;
export const SCHEMA_PATH = join(import.meta.dir, "..", "data", "delivery.schema.json");

const LIMITS_HEAD =
  "These are counts from private repositories and a private work board; a reader cannot re-run the queries, and the dated receipts are at /log. They count merged work, not revenue. A pull request is counted when GitHub records the merge; a review round is one pass by an automated reviewer that did not write the change, recorded on the pull request; an agent run is one session on one work item";
const LIMITS_TAIL = "Counts, never contents: no repository, client, path or person is published.";

/**
 * The limitations paragraph. Its one clause about the data states the measured share
 * of my merges on the system's own repository over the last two complete weeks (the
 * principal's pick on the L2 card); with fewer than two complete weeks read, the
 * clause is left out rather than guessed.
 */
export function limitations(d: Delivery): string {
  const mine = d.prs_merged?.operator;
  const complete = mine?.state === "read"
    ? [...(mine.weeks ?? [])].filter((w) => !w.partial).sort((x, y) => (x.week_start < y.week_start ? -1 : 1)).slice(-2)
    : [];
  if (complete.length < 2) return `${LIMITS_HEAD}. ${LIMITS_TAIL}`;
  const all = complete.reduce((n, w) => n + w.count, 0);
  const sys = complete.reduce((n, w) => n + (w.on_system_repo ?? 0), 0);
  return `${LIMITS_HEAD}; in the ISO weeks of ${complete[0]!.week_start} and ${complete[1]!.week_start}, ${num(sys)} of my ${num(all)} merged pull requests were on the system that runs the rest. ${LIMITS_TAIL}`;
}

// ─── the data shape (what the schema allows) ────────────────────────────────

type State = "read" | "partial" | "unreadable" | "rate_limited";
interface Week { week_start: string; count: number; partial: boolean; on_system_repo?: number }
interface Block { state: State; observed_at: string; weeks?: Week[] }
interface Review extends Block {
  window?: { since: string; until: string };
  merged_prs_in_window?: number;
  rounds_per_merged_pr_mean?: number;
  rounds_per_merged_pr_median?: number;
  p1_per_merged_pr_mean?: number;
}
export interface Delivery {
  schema_version: 1;
  generated_at: string;
  prs_merged?: { operator?: Block; org?: Block };
  prs_closed_unmerged?: { operator?: Block; org?: Block };
  review?: Review;
  cards_completed?: Block;
  legs_started?: Block;
  system_updates?: Block;
  repos_active_30d?: { state: State; observed_at: string; count?: number; completeness?: "exact" | "lower_bound" };
  /** Never rendered; read only to check the not-measured list against it. */
  tokens?: { state: State; observed_at: string };
  unmeasured?: Array<{ metric: string; reason: string }>;
}

// ─── validation ─────────────────────────────────────────────────────────────

/**
 * The schema, then the facts the prose below states about the data and the schema
 * cannot express. A reading that breaks one is refused like a schema failure, so the
 * section never says "of them", "mine included", "ISO week", "not measured" or
 * "last reading" about numbers that make the sentence false.
 */
export function validator(schemaPath = SCHEMA_PATH): (data: unknown, now?: Date) => string[] {
  const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  return (data, now = new Date()) => {
    if (!validate(data)) return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
    return proseFacts(data as Delivery, now);
  };
}

const WEEK_MS = 7 * 86_400_000;
const hourMs = (h: string) => Date.parse(`${h.slice(0, 16)}:00Z`);

/** `2026-09-30T14:00Z` names a real hour when it parses and prints back the same. */
const realHour = (h: string) => {
  const t = Date.parse(`${h.slice(0, 16)}:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 16) === h.slice(0, 16);
};

export function proseFacts(d: Delivery, now: Date = new Date()): string[] {
  const out: string[] = [];
  const hours: Array<[string, string]> = [["/generated_at", d.generated_at]];
  if (realHour(d.generated_at) && hourMs(d.generated_at) > now.getTime()) out.push(`/generated_at: ${d.generated_at} is in the future`);
  const blocks: Array<[string, Block | Review | Delivery["repos_active_30d"] | undefined]> = [
    ["prs_merged_operator", d.prs_merged?.operator], ["prs_merged_org", d.prs_merged?.org],
    ["prs_closed_unmerged_operator", d.prs_closed_unmerged?.operator], ["prs_closed_unmerged_org", d.prs_closed_unmerged?.org],
    ["review", d.review], ["cards_completed", d.cards_completed], ["legs_started", d.legs_started],
    ["system_updates", d.system_updates], ["repos_active_30d", d.repos_active_30d],
  ];
  for (const [name, b] of blocks) {
    if (!b) continue;
    hours.push([`${name}.observed_at`, b.observed_at]);
    if (b.observed_at > d.generated_at) out.push(`${name}: observed_at ${b.observed_at} is after generated_at`);
    const observed = hourMs(b.observed_at);
    const seen = new Set<string>();
    for (const w of (b as Block).weeks ?? []) {
      const start = Date.parse(`${w.week_start}T00:00:00Z`);
      if (new Date(start).getUTCDay() !== 1) out.push(`${name}: week_start ${w.week_start} is not a Monday`);
      if (seen.has(w.week_start)) out.push(`${name}: week_start ${w.week_start} appears twice`);
      seen.add(w.week_start);
      if (w.on_system_repo !== undefined && w.on_system_repo > w.count) out.push(`${name}: ${w.week_start} has more on the system's repository than in all`);
      if (start > observed) out.push(`${name}: week ${w.week_start} starts after its reading`);
      else if (!Number.isNaN(observed) && w.partial !== observed < start + WEEK_MS) {
        out.push(`${name}: week ${w.week_start} is marked ${w.partial ? "open" : "complete"} but had ${w.partial ? "" : "not "}ended at ${b.observed_at}`);
      }
    }
  }
  const win = d.review?.window;
  if (win && win.since > win.until) out.push(`review: window ${win.since} to ${win.until} runs backwards`);
  for (const [where, h] of hours) if (!realHour(h)) out.push(`${where}: ${h} is not a real hour`);
  for (const [mine, org] of [[d.prs_merged?.operator, d.prs_merged?.org], [d.prs_closed_unmerged?.operator, d.prs_closed_unmerged?.org]] as const) {
    if (mine?.state !== "read" || org?.state !== "read") continue;
    for (const w of mine.weeks ?? []) {
      const o = org.weeks?.find((x) => x.week_start === w.week_start);
      // An open week is read at each block's own hour, so only closed weeks are compared.
      if (o && !o.partial && !w.partial && o.count < w.count) out.push(`the company's ${w.week_start} is below mine, which it includes`);
    }
  }
  const blockOf = new Map<string, { state: State } | undefined>([...blocks, ["tokens_per_merged_pr", d.tokens]]);
  for (const u of d.unmeasured ?? []) {
    if (blockOf.get(u.metric)?.state === "read") out.push(`unmeasured: ${u.metric} is listed as not measured and was read`);
  }
  return out;
}

// ─── words ──────────────────────────────────────────────────────────────────

const STATE_WORDS: Record<Exclude<State, "read">, string> = {
  partial: "the source was only partly read at this reading, so no figure is published",
  unreadable: "the source could not be read at this reading",
  rate_limited: "the source turned the query away for its rate limit at this reading",
};

const METRIC_WORDS: Record<string, string> = {
  prs_merged_operator: "pull requests merged, mine",
  prs_merged_org: "pull requests merged, the company's",
  prs_closed_unmerged_operator: "pull requests closed without merging, mine",
  prs_closed_unmerged_org: "pull requests closed without merging, the company's",
  review: "review rounds per merged pull request",
  cards_completed: "work items completed",
  legs_started: "agent runs started",
  system_updates: "system updates applied",
  tokens_per_merged_pr: "tokens spent per merged pull request",
  repos_active_30d: "repositories with a merge in the last 30 days",
  fitness_ratio: "share of delivered work per unit of attention",
  clean_finish_rate: "share of agent runs that finished cleanly",
};

const REASON_WORDS: Record<string, string> = {
  sample_below_floor: "too few cases to state a figure",
  no_gate_in_window: "nothing to count in the window",
  source_unreadable: "the source could not be read",
  source_partial: "the source was only partly read",
  not_declared: "not configured on this install",
  rate_limited: "the source turned the query away for its rate limit",
  not_published: "not published in this version",
};

/** `2026-09-30T02:00Z` → `2026-09-30 02:00 UTC`. */
export const hour = (h: string) => `${h.slice(0, 10)} ${h.slice(11, 16)} UTC`;
const num = (n: number) => n.toLocaleString("en-US");
/** A mean to two decimals at most: 3.77, 2, 3.5. */
const mean = (n: number) => String(Math.round(n * 100) / 100);

const read = <T extends { state: State }>(b: T | undefined): b is T => b !== undefined && b.state === "read";

/** The newest complete week of a series by `week_start`, or its newest row when none is complete. */
function figureWeek(b: Block): Week | undefined {
  const newestFirst = [...(b.weeks ?? [])].sort((x, y) => (x.week_start < y.week_start ? 1 : x.week_start > y.week_start ? -1 : 0));
  return newestFirst.find((w) => !w.partial) ?? newestFirst[0];
}

const weekWords = (w: Week) => (w.partial ? `in the ISO week of ${w.week_start}, open at this reading` : `in the ISO week of ${w.week_start}`);

/** The company's count for the same week, with its own as-of when it was read at another hour. */
function companyClause(org: Block | undefined, week: string, mineObserved: string): string {
  const row = sameWeek(org, week);
  if (!row) return "";
  const notes: string[] = [];
  if (org!.observed_at !== mineObserved) notes.push(`as of ${hour(org!.observed_at)}`);
  if (row.partial) notes.push("the week open at its reading");
  const tail = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  return `; the company's, all operators, mine included: **${num(row.count)}**${tail}`;
}

function notMeasured(label: string, b: { state: State; observed_at: string } | undefined): string {
  if (!b) return `- **not measured** · ${label} · not in this reading`;
  return `- **not measured** · ${label} · ${STATE_WORDS[b.state as Exclude<State, "read">]} · as of ${hour(b.observed_at)}`;
}

/** The org series row for the same week as the operator's figure. */
const sameWeek = (b: Block | undefined, week: string) => (read(b) ? b.weeks?.find((w) => w.week_start === week) : undefined);

// ─── the four figures ───────────────────────────────────────────────────────

function figureMerged(d: Delivery): string {
  const mine = d.prs_merged?.operator;
  if (!read(mine)) return notMeasured("pull requests merged, mine", mine);
  const w = figureWeek(mine)!;
  const company = companyClause(d.prs_merged?.org, w.week_start, mine.observed_at);
  return `- **${num(w.count)}** · pull requests merged ${weekWords(w)}, mine, ${num(w.on_system_repo ?? 0)} of them on the system's own repository${company} · counted when GitHub records the merge, one search per week by author${company ? " and one by organization" : ""} · as of ${hour(mine.observed_at)}`;
}

function figureReview(d: Delivery): string {
  const r = d.review;
  if (!read(r)) return notMeasured("review rounds per merged pull request", r);
  return `- **${r.rounds_per_merged_pr_median}** · review rounds per merged pull request, median (mean ${mean(r.rounds_per_merged_pr_mean!)}), over ${num(r.merged_prs_in_window!)} pull requests merged on the system's own repository from ${r.window!.since} to ${r.window!.until} · a round is one pass by an automated reviewer that did not write the change, recorded on the pull request · as of ${hour(r.observed_at)}`;
}

function figureCards(d: Delivery): string {
  const c = d.cards_completed;
  if (!read(c)) return notMeasured("work items completed", c);
  const w = figureWeek(c)!;
  return `- **${num(w.count)}** · work items completed ${weekWords(w)} · items on my work board closed as completed; items closed as not planned are not counted · as of ${hour(c.observed_at)}`;
}

function figureClosed(d: Delivery): string {
  const mine = d.prs_closed_unmerged?.operator;
  if (!read(mine)) return notMeasured("pull requests closed without merging, mine", mine);
  const w = figureWeek(mine)!;
  const company = companyClause(d.prs_closed_unmerged?.org, w.week_start, mine.observed_at);
  return `- **${num(w.count)}** · pull requests closed without merging ${weekWords(w)}, mine${company} · counted by the same weekly searches, closed and not merged · as of ${hour(mine.observed_at)}`;
}

// ─── the twelve-week table ──────────────────────────────────────────────────

const TABLE_WEEKS = 13; // twelve complete ISO weeks and the current one

function table(d: Delivery): string[] {
  const columns: Array<{ head: string; block: Block | undefined; cell: (w: Week) => number }> = [
    { head: "merged, mine", block: d.prs_merged?.operator, cell: (w) => w.count },
    { head: "of them on the system's repository", block: d.prs_merged?.operator, cell: (w) => w.on_system_repo ?? 0 },
    { head: "merged, the company's", block: d.prs_merged?.org, cell: (w) => w.count },
    { head: "closed unmerged, mine", block: d.prs_closed_unmerged?.operator, cell: (w) => w.count },
    { head: "closed unmerged, the company's", block: d.prs_closed_unmerged?.org, cell: (w) => w.count },
    { head: "work items completed", block: d.cards_completed, cell: (w) => w.count },
    { head: "agent runs started", block: d.legs_started, cell: (w) => w.count },
    { head: "system updates applied", block: d.system_updates, cell: (w) => w.count },
  ];
  const starts = new Set<string>();
  for (const c of columns) if (read(c.block)) for (const w of c.block.weeks ?? []) starts.add(w.week_start);
  const weeks = [...starts].sort().slice(-TABLE_WEEKS).reverse();
  if (weeks.length === 0) return ["No weekly series is published at this reading."];
  const out = [
    `| ISO week from | ${columns.map((c) => c.head).join(" | ")} |`,
    `|---|${columns.map(() => "---:").join("|")}|`,
  ];
  for (const week of weeks) {
    const cells = columns.map((c) => {
      const row = sameWeek(c.block, week);
      // Each series is read at its own hour, so "open" belongs to the cell, never the row.
      return row ? `${num(c.cell(row))}${row.partial ? " (open)" : ""}` : "n/a";
    });
    out.push(`| ${week} | ${cells.join(" | ")} |`);
  }
  return out;
}

// ─── the block ──────────────────────────────────────────────────────────────

export interface RenderOptions { now: Date }

export function isOld(generatedAt: string, now: Date): boolean {
  const at = Date.parse(`${generatedAt.slice(0, 16)}:00Z`);
  return now.getTime() - at > OLD_AFTER_HOURS * 3_600_000;
}

export function renderBlock(d: Delivery, opts: RenderOptions): string {
  const lines: string[] = ["## Delivery, counted", ""];
  if (isOld(d.generated_at, opts.now)) {
    lines.push(`Last reading ${hour(d.generated_at)}. Every figure below is from that reading.`, "");
  }
  lines.push(figureMerged(d), figureReview(d), figureCards(d), figureClosed(d), "", limitations(d), "", "### Week by week", "", ...table(d), "");
  const r = d.review;
  if (read(r)) {
    lines.push(`Blocking findings caught before merge, per merged pull request on the system's own repository from ${r.window!.since} to ${r.window!.until}: mean ${mean(r.p1_per_merged_pr_mean!)}, as of ${hour(r.observed_at)}.`, "");
  }

  lines.push("### How these are counted", "");
  lines.push(
    "- **Mine**: pull requests I authored. **The company's**: every repository in the organization, every operator, mine included. A week is an ISO week, Monday to Sunday, in UTC. A figure marked open, in the list or the table, was counted before its week ended.",
    "- **Merged** and **closed unmerged**: one search per week and per population, read as the total the search reports, never by listing rows. The system's own repository is the one that holds the system running the rest; the table shows how many of my merges landed there each week.",
    "- **Review rounds**: on the system's own repository only, over the window named in the figure. The median is what a typical pull request took; the mean sits beside it.",
    "- **Work items completed**: items on my work board closed as completed. Items closed as not planned are left out.",
    "- **Agent runs started**: one session on one work item, counted when it starts, whether or not it finished.",
    "- **System updates applied**: one recorded change to the system's own setup, counted when applied.",
    "- A figure whose source could not be read is shown as not measured. In the table, n/a means there is no figure for that week: the source was not read, or it had no row for that week.",
  );
  const repos = d.repos_active_30d;
  if (repos && repos.state === "read") {
    lines.push(`- **Repositories with a merge in the last 30 days**: ${repos.completeness === "lower_bound" ? "at least " : ""}${num(repos.count!)}, as of ${hour(repos.observed_at)}. Names are never published.`);
  } else if (repos) {
    lines.push(`- **Repositories with a merge in the last 30 days**: not measured; ${STATE_WORDS[repos.state as Exclude<State, "read">]}, as of ${hour(repos.observed_at)}.`);
  }
  const unmeasured = (d.unmeasured ?? []).map((u) => `${METRIC_WORDS[u.metric]} (${REASON_WORDS[u.reason]})`);
  if (unmeasured.length > 0) lines.push(`- Not measured at this reading: ${unmeasured.join("; ")}.`);
  lines.push("", `Reading of ${hour(d.generated_at)}, checked against its schema before this section was written.`);
  return lines.join("\n");
}

// ─── the README ─────────────────────────────────────────────────────────────

export function splice(readme: string, block: string): string {
  const starts = markerLines(readme, START);
  const ends = markerLines(readme, END);
  if (starts.length === 0 && ends.length === 0) {
    const base = readme.endsWith("\n") ? readme : `${readme}\n`;
    return `${base}\n${START}\n${block}\n${END}\n`;
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    throw new Error(`README markers are malformed: expected exactly one ${START} line before exactly one ${END} line`);
  }
  return `${readme.slice(0, starts[0])}${START}\n${block}\n${readme.slice(ends[0])}`;
}

/**
 * The offset of every line that is exactly `marker` (a trailing CR allowed) and sits
 * outside a fenced code block, so a marker shown as an example is left alone. A fence
 * opens on three or more backticks or tildes and closes on a bare run of the same
 * character at least as long (CommonMark).
 */
function markerLines(readme: string, marker: string): number[] {
  const out: number[] = [];
  let fence: { ch: string; len: number } | null = null;
  let offset = 0;
  for (const line of readme.split("\n")) {
    const text = line.replace(/\r$/, "");
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (fence === null && open) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
    } else if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(text);
      if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) fence = null;
    } else if (text === marker) {
      out.push(offset);
    }
    offset += line.length + 1;
  }
  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const jsonPath = flag(argv, "--json");
  if (!jsonPath) {
    console.error("usage: bun scripts/render.ts --json <path> [--check] [--readme README.md] [--block-out <path>] [--now <ISO time>]");
    return 2;
  }
  const checkOnly = argv.includes("--check");
  const readmePath = flag(argv, "--readme") ?? "README.md";
  const nowFlag = flag(argv, "--now");
  const now = nowFlag ? new Date(nowFlag) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`render: --now is not a time: ${nowFlag}`);
    return 2;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (e) {
    console.error(`render: ${jsonPath} is not readable JSON: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const errors = validator()(data, now);
  if (errors.length > 0) {
    console.error(`render: ${jsonPath} fails the schema or a fact the section states; nothing written`);
    for (const e of errors) console.error(`  ${e}`);
    return 1;
  }
  if (checkOnly) {
    if (argv.includes("--require-recent") && isOld((data as Delivery).generated_at, now)) {
      console.error(`render: ${jsonPath} passes the schema, but its reading of ${(data as Delivery).generated_at} is older than ${OLD_AFTER_HOURS} hours`);
      return 4;
    }
    console.log(`render: ${jsonPath} passes the schema`);
    return 0;
  }
  const block = renderBlock(data as Delivery, { now });
  const next = splice(readFileSync(readmePath, "utf8"), block);
  const blockOut = flag(argv, "--block-out");
  if (blockOut) writeFileSync(blockOut, `${block}\n`);
  writeFileSync(readmePath, next);
  console.log(`render: ${readmePath} written from the reading of ${(data as Delivery).generated_at}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
