import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { END, LIMITATIONS, main, renderBlock, splice, START, validator, type Delivery } from "./render";

// Synthetic numbers only: thirteen ISO weeks, the last one still open.
const MONDAYS = Array.from({ length: 13 }, (_, i) => new Date(Date.UTC(2026, 6, 6 + 7 * i)).toISOString().slice(0, 10));
const series = (base: number, sys?: number) =>
  MONDAYS.map((week_start, i) => ({ week_start, count: base + i, ...(sys === undefined ? {} : { on_system_repo: sys + i }), partial: i === MONDAYS.length - 1 }));

function sample(): Delivery & Record<string, unknown> {
  const head = (population: string, source: string, observed_at = "2026-09-30T02:00Z") => ({ population, source, state: "read" as const, observed_at });
  return {
    schema_version: 1,
    generated_at: "2026-09-30T14:00Z",
    windows: { week: "iso-week" },
    prs_merged: {
      operator: { ...head("operator", "github_search"), weeks: series(300, 200) },
      org: { ...head("org", "github_search"), includes_operator: true, weeks: series(500) },
    },
    prs_closed_unmerged: {
      operator: { ...head("operator", "github_search"), weeks: series(3) },
      org: { ...head("org", "github_search"), includes_operator: true, weeks: series(9) },
    },
    review: {
      ...head("install", "delivery_meters", "2026-09-30T14:00Z"),
      window: { since: "2026-09-16", until: "2026-09-30" },
      merged_prs_in_window: 600, rounds_per_merged_pr_mean: 3.5, rounds_per_merged_pr_median: 2, p1_per_merged_pr_mean: 2,
    },
    cards_completed: { ...head("board", "board", "2026-09-30T14:00Z"), weeks: series(100) },
    legs_started: { ...head("install", "leg_ledger", "2026-09-30T14:00Z"), weeks: series(40), total: 600 },
    system_updates: { ...head("install", "system_updates", "2026-09-30T14:00Z"), weeks: series(5), total: 120 },
    tokens: { population: "install", source: "leg_ledger", state: "partial", observed_at: "2026-09-30T14:00Z" },
    unmeasured: [{ metric: "tokens_per_merged_pr", reason: "not_published" }],
  } as Delivery & Record<string, unknown>;
}

const AT = (h: number) => new Date(Date.parse("2026-09-30T14:00:00Z") + h * 3_600_000);
const PROSE = "# Someone\n\nHand-written prose, **kept** exactly.\n";

describe("schema", () => {
  const validate = validator();
  test("the sample is valid", () => expect(validate(sample())).toEqual([]));
  test("a title key anywhere is refused", () => {
    const d = sample();
    (d.cards_completed as Record<string, unknown>).title = "a private card title";
    expect(validate(d).length).toBeGreaterThan(0);
  });
  test("a dollar key is refused", () => expect(validate({ ...sample(), usd: 100 }).length).toBeGreaterThan(0));
  test("figures on a block that was not read are refused", () => {
    const d = sample();
    d.review!.state = "unreadable";
    expect(validate(d).length).toBeGreaterThan(0);
  });
});

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "render-"));
  const run = (data: unknown, readme = PROSE) => {
    writeFileSync(join(dir, "d.json"), JSON.stringify(data));
    writeFileSync(join(dir, "README.md"), readme);
    const code = main(["--json", join(dir, "d.json"), "--readme", join(dir, "README.md"), "--block-out", join(dir, "block.md"), "--now", AT(1).toISOString()]);
    return { code, readme: readFileSync(join(dir, "README.md"), "utf8") };
  };
  test("an invalid JSON exits 1 and leaves README.md byte-identical", () => {
    const r = run({ ...sample(), host: "box" });
    expect(r.code).toBe(1);
    expect(r.readme).toBe(PROSE);
  });
  test("a valid JSON writes README.md and the block alone", () => {
    const r = run(sample());
    expect(r.code).toBe(0);
    expect(r.readme.startsWith(PROSE)).toBe(true);
    expect(readFileSync(join(dir, "block.md"), "utf8")).toBe(`${renderBlock(sample(), { now: AT(1) })}\n`);
  });
});

describe("splice", () => {
  const block = renderBlock(sample(), { now: AT(1) });
  test("no markers: they are appended once, prose untouched", () => {
    const out = splice(PROSE, block);
    expect(out.startsWith(PROSE)).toBe(true);
    expect(out.split(START).length - 1).toBe(1);
    expect(out.split(END).length - 1).toBe(1);
  });
  test("re-rendering is byte-identical and keeps the prose", () => {
    const once = splice(PROSE, block);
    const twice = splice(once, block);
    expect(twice).toBe(once);
    expect(twice.slice(0, twice.indexOf(START))).toBe(`${PROSE}\n`);
  });
  test("text after the end marker is kept", () => {
    const out = splice(`${PROSE}${START}\nold\n${END}\n\nfooter\n`, block);
    expect(out.endsWith(`${END}\n\nfooter\n`)).toBe(true);
    expect(out).not.toContain("\nold\n");
  });
  test("malformed markers are refused", () => {
    expect(() => splice(`${PROSE}${END}\n${START}\n`, block)).toThrow();
    expect(() => splice(`${PROSE}${START}\n`, block)).toThrow();
    expect(() => splice(`${PROSE}${START}\n${START}\n${END}\n`, block)).toThrow();
  });
});

describe("the block", () => {
  const d = sample();
  const block = renderBlock(d, { now: AT(1) });
  const figures = block.split("\n").filter((l) => l.startsWith("- **")).slice(0, 4);

  test("four figures first, in order: merged, review, cards, closed unmerged", () => {
    const w = 11; // the newest complete week
    expect(figures[0]).toStartWith(`- **${300 + w}** · pull requests merged in the ISO week of ${MONDAYS[w]}, mine, ${200 + w} of them on the system's own repository; the company's, all operators, mine included: **${500 + w}**`);
    expect(figures[1]).toStartWith("- **2** · review rounds per merged pull request, median (mean 3.5), over 600 pull requests merged on the system's own repository from 2026-09-16 to 2026-09-30");
    expect(figures[2]).toStartWith(`- **${100 + w}** · work items completed in the ISO week of ${MONDAYS[w]}`);
    expect(figures[3]).toStartWith(`- **${3 + w}** · pull requests closed without merging in the ISO week of ${MONDAYS[w]}, mine; the company's, all operators, mine included: **${9 + w}**`);
    for (const f of figures) expect(f).toMatch(/ · .+ · .+ · as of \d{4}-\d{2}-\d{2} \d{2}:00 UTC$/);
  });

  test("then the limitations paragraph verbatim, the table, the counting notes", () => {
    const iFig = block.indexOf(figures[3]);
    const iLim = block.indexOf(`\n${LIMITATIONS}\n`);
    const iTable = block.indexOf("### Twelve weeks");
    const iHow = block.indexOf("### How these are counted");
    expect(iFig).toBeGreaterThan(-1);
    expect(iLim).toBeGreaterThan(iFig);
    expect(iTable).toBeGreaterThan(iLim);
    expect(iHow).toBeGreaterThan(iTable);
  });

  test("the table holds thirteen weeks, newest first, the open one marked", () => {
    const rows = block.split("\n").filter((l) => /^\| \d{4}-/.test(l));
    expect(rows.length).toBe(13);
    expect(rows[0]).toStartWith(`| ${MONDAYS[12]} (so far) |`);
    expect(rows[12]).toStartWith(`| ${MONDAYS[0]} |`);
  });

  test("no tokens figure, no raw HTML", () => {
    expect(block).not.toMatch(/\btokens? (spent|per)\b[^(]*\*\*/);
    expect(block).not.toContain("<");
  });
});

describe("an old reading", () => {
  test("47 hours: no line; 49 hours: 'Last reading <date>'", () => {
    expect(renderBlock(sample(), { now: AT(47) })).not.toContain("Last reading");
    expect(renderBlock(sample(), { now: AT(49) })).toContain("Last reading 2026-09-30 14:00 UTC.");
  });
  test("the word stale never appears, fresh or old", () => {
    for (const h of [1, 47, 49, 24 * 30]) expect(renderBlock(sample(), { now: AT(h) }).toLowerCase()).not.toContain("stale");
  });
});

describe("a source that was not read", () => {
  test("unreadable review and a missing cards block say not measured, never zero", () => {
    const d = sample();
    d.review = { population: "install", source: "delivery_meters", state: "unreadable", observed_at: "2026-09-30T14:00Z" } as never;
    delete d.cards_completed;
    expect(validator()(d)).toEqual([]);
    const lines = renderBlock(d, { now: AT(1) }).split("\n");
    expect(lines.find((l) => l.includes("review rounds per merged pull request ·"))).toBe(
      "- **not measured** · review rounds per merged pull request · the source could not be read at this reading · as of 2026-09-30 14:00 UTC",
    );
    expect(lines.find((l) => l.includes("work items completed ·"))).toBe("- **not measured** · work items completed · not in this reading");
    const row = lines.find((l) => l.startsWith(`| ${MONDAYS[11]} |`))!;
    expect(row.split("|")[7].trim()).toBe("n/a"); // the work-items column
    expect(row.split("|")[6].trim()).toBe(String(9 + 11)); // its neighbour still read
  });
  test("an org series not read drops the company's figure, keeps mine", () => {
    const d = sample();
    d.prs_merged!.org = { population: "org", source: "github_search", state: "rate_limited", observed_at: "2026-09-30T02:00Z", includes_operator: true } as never;
    expect(validator()(d)).toEqual([]);
    const first = renderBlock(d, { now: AT(1) }).split("\n").find((l) => l.startsWith("- **"))!;
    expect(first).toContain("mine, ");
    expect(first).not.toContain("the company's");
  });
});
