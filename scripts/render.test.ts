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
    (d.cards_completed as unknown as Record<string, unknown>).title = "a private card title";
    expect(validate(d).length).toBeGreaterThan(0);
  });
  test("a dollar key is refused", () => expect(validate({ ...sample(), usd: 100 }).length).toBeGreaterThan(0));
  test("figures on a block that was not read are refused", () => {
    const d = sample();
    d.review!.state = "unreadable";
    expect(validate(d).length).toBeGreaterThan(0);
  });
});

describe("facts the prose states", () => {
  const validate = validator();
  const refused = (mutate: (d: ReturnType<typeof sample>) => void) => {
    const d = sample();
    mutate(d);
    return validate(d);
  };
  test("a week_start that is not a Monday is refused", () =>
    expect(refused((d) => { d.cards_completed!.weeks![0]!.week_start = "2026-07-07"; })).toEqual(["cards_completed: week_start 2026-07-07 is not a Monday"]));
  test("more on the system's repository than in all is refused", () =>
    expect(refused((d) => { d.prs_merged!.operator!.weeks![3]!.on_system_repo = 999; })).toEqual([`prs_merged_operator: ${MONDAYS[3]} has more on the system's repository than in all`]));
  test("the company below mine is refused, for both pull-request series", () => {
    expect(refused((d) => { d.prs_merged!.org!.weeks![2]!.count = 1; })).toEqual([`the company's ${MONDAYS[2]} is below mine, which it includes`]);
    expect(refused((d) => { d.prs_closed_unmerged!.org!.weeks![2]!.count = 0; })).toEqual([`the company's ${MONDAYS[2]} is below mine, which it includes`]);
  });
  test("a metric both read and listed as not measured is refused", () =>
    expect(refused((d) => { d.unmeasured = [{ metric: "review", reason: "source_partial" }]; })).toEqual(["unmeasured: review is listed as not measured and was read"]));
  test("an hour the pattern accepts but no clock has is refused", () => {
    expect(refused((d) => { d.generated_at = "2026-02-30T14:00Z"; })).toContain("/generated_at: 2026-02-30T14:00Z is not a real hour");
    expect(refused((d) => { d.review!.observed_at = "2026-09-30T25:00Z"; })).toContain("review.observed_at: 2026-09-30T25:00Z is not a real hour");
  });
  test("a reading from the future, or a block read after the reading, is refused", () => {
    expect(validate(sample(), new Date("2026-09-30T13:30:00Z"))).toEqual(["/generated_at: 2026-09-30T14:00Z is in the future"]);
    expect(refused((d) => { d.review!.observed_at = "2026-09-30T15:00Z"; })).toEqual(["review: observed_at 2026-09-30T15:00Z is after generated_at"]);
  });
  test("a week twice in one series is refused", () =>
    expect(refused((d) => { d.legs_started!.weeks![1]!.week_start = MONDAYS[0]!; })).toContain(`legs_started: week_start ${MONDAYS[0]} appears twice`));
  test("open and complete must agree with the hour the block was read", () => {
    expect(refused((d) => { d.cards_completed!.weeks![11]!.partial = true; })).toEqual([`cards_completed: week ${MONDAYS[11]} is marked open but had ended at 2026-09-30T14:00Z`]);
    expect(refused((d) => { d.cards_completed!.weeks![12]!.partial = false; })).toEqual([`cards_completed: week ${MONDAYS[12]} is marked complete but had not ended at 2026-09-30T14:00Z`]);
  });
  test("a backwards review window is refused", () =>
    expect(refused((d) => { d.review!.window = { since: "2026-09-30", until: "2026-09-16" }; })).toEqual(["review: window 2026-09-30 to 2026-09-16 runs backwards"]));
  test("an open week is not compared across series read at different hours", () =>
    expect(refused((d) => { d.prs_merged!.org!.weeks![12]!.count = 1; })).toEqual([]));
  test("the sample breaks none of them", () => expect(validate(sample())).toEqual([]));
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
  test("--check validates and writes nothing", () => {
    writeFileSync(join(dir, "d.json"), JSON.stringify(sample()));
    writeFileSync(join(dir, "README.md"), PROSE);
    expect(main(["--json", join(dir, "d.json"), "--check", "--readme", join(dir, "README.md")])).toBe(0);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(PROSE);
    writeFileSync(join(dir, "d.json"), JSON.stringify({ ...sample(), usd: 1 }));
    expect(main(["--json", join(dir, "d.json"), "--check"])).toBe(1);
  });
  test("--check --require-recent exits 4 past 48 hours and 0 before", () => {
    writeFileSync(join(dir, "d.json"), JSON.stringify(sample()));
    expect(main(["--json", join(dir, "d.json"), "--check", "--require-recent", "--now", AT(47).toISOString()])).toBe(0);
    expect(main(["--json", join(dir, "d.json"), "--check", "--require-recent", "--now", AT(49).toISOString()])).toBe(4);
    expect(main(["--json", join(dir, "d.json"), "--check", "--now", AT(49).toISOString()])).toBe(0);
  });
  test("a valid JSON writes README.md and the block alone", () => {
    const r = run(sample());
    expect(r.code).toBe(0);
    const block = renderBlock(sample(), { now: AT(1) });
    expect(r.readme).toBe(splice(PROSE, block));
    expect(r.readme).toContain(START);
    expect(readFileSync(join(dir, "block.md"), "utf8")).toBe(`${block}\n`);
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
  test("markers shown inside a code fence are left alone", () => {
    const fenced = `${PROSE}\n\`\`\`md\n${START}\nexample prose\n${END}\n\`\`\`\nTail\n`;
    const out = splice(fenced, block);
    expect(out.startsWith(fenced)).toBe(true);
    expect(out.slice(fenced.length)).toBe(`\n${START}\n${block}\n${END}\n`);
    const tilde = `${PROSE}~~~~\n${START}\n~~~\n${END}\n~~~~\n${START}\nold\n${END}\n`;
    expect(splice(tilde, block)).toBe(`${PROSE}~~~~\n${START}\n~~~\n${END}\n~~~~\n${START}\n${block}\n${END}\n`);
  });
  test("CRLF outside the markers is kept byte for byte", () => {
    const crlf = `# A\r\n\r\nprose\r\n${START}\r\nold\r\n${END}\r\ntail\r\n`;
    const out = splice(crlf, block);
    expect(out.startsWith("# A\r\n\r\nprose\r\n")).toBe(true);
    expect(out.endsWith(`${END}\r\ntail\r\n`)).toBe(true);
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
    const iTable = block.indexOf("### Week by week");
    const iHow = block.indexOf("### How these are counted");
    expect(iFig).toBeGreaterThan(-1);
    expect(iLim).toBeGreaterThan(iFig);
    expect(iTable).toBeGreaterThan(iLim);
    expect(iHow).toBeGreaterThan(iTable);
  });

  test("the table holds thirteen weeks, newest first, the open one marked", () => {
    const rows = block.split("\n").filter((l) => /^\| \d{4}-/.test(l));
    expect(rows.length).toBe(13);
    expect(rows[0]).toStartWith(`| ${MONDAYS[12]} | 312 (open) | 212 (open) | 512 (open) |`);
    expect(rows[1]).toStartWith(`| ${MONDAYS[11]} | 311 | 211 | 511 |`);
    expect(rows[12]).toStartWith(`| ${MONDAYS[0]} |`);
  });

  test("no raw HTML, and no link anywhere", () => {
    expect(block).not.toContain("<");
    expect(block).not.toMatch(/https?:|\]\(/);
  });

  test("a mean prints at two decimals at most", () => {
    const d = sample();
    d.review!.rounds_per_merged_pr_mean = 3.7700000000000005;
    d.review!.p1_per_merged_pr_mean = 2.0399999999999996;
    const b = renderBlock(d, { now: AT(1) });
    expect(b).toContain("(mean 3.77)");
    expect(b).toContain(": mean 2.04,");
  });

  test("the blocking-findings mean is published below the table", () => {
    expect(block).toContain("Blocking findings caught before merge, per merged pull request on the system's own repository from 2026-09-16 to 2026-09-30: mean 2, as of 2026-09-30 14:00 UTC.");
  });
});

describe("what is never published", () => {
  test("a tokens block that WAS read reaches no line at all", () => {
    const d = sample();
    d.tokens = { population: "install", source: "leg_ledger", state: "read", observed_at: "2026-09-30T14:00Z", floor: true, per_merged_pr: 123_456_789, weeks: series(1_000_000) } as never;
    d.unmeasured = [];
    expect(validator()(d)).toEqual([]);
    const block = renderBlock(d, { now: AT(1) });
    expect(block).not.toContain("123,456,789");
    expect(block).not.toContain("123456789");
    expect(block).not.toContain("1,000,011");
    expect(block.split("\n").filter((l) => /token/i.test(l))).toEqual([]);
  });
  test("the totals are not published", () => {
    const block = renderBlock(sample(), { now: AT(1) });
    expect(block).not.toMatch(/\b600\b(?! pull requests)/);
    expect(block).not.toContain("120");
  });
});

describe("the figure's week", () => {
  test("is the newest complete week by date, whatever the row order", () => {
    const d = sample();
    d.cards_completed!.weeks = [...d.cards_completed!.weeks!].reverse();
    d.prs_merged!.operator!.weeks = [...d.prs_merged!.operator!.weeks!].reverse();
    expect(validator()(d)).toEqual([]);
    const figures = renderBlock(d, { now: AT(1) }).split("\n").filter((l) => l.startsWith("- **"));
    expect(figures[0]).toStartWith(`- **311** · pull requests merged in the ISO week of ${MONDAYS[11]},`);
    expect(figures[2]).toStartWith(`- **111** · work items completed in the ISO week of ${MONDAYS[11]} ·`);
  });
  test("an open week is said to be open at this reading", () => {
    const d = sample();
    d.cards_completed!.weeks = [d.cards_completed!.weeks![12]!];
    expect(renderBlock(d, { now: AT(1) })).toContain(`work items completed in the ISO week of ${MONDAYS[12]}, open at this reading ·`);
  });
  test("the company's figure carries its own as-of when read at another hour", () => {
    const d = sample();
    d.prs_merged!.org!.observed_at = "2026-09-30T05:00Z";
    const first = renderBlock(d, { now: AT(1) }).split("\n").find((l) => l.startsWith("- **"))!;
    expect(first).toContain(`mine included: **511** (as of 2026-09-30 05:00 UTC) ·`);
    expect(first).toEndWith("as of 2026-09-30 02:00 UTC");
    const same = renderBlock(sample(), { now: AT(1) }).split("\n").find((l) => l.startsWith("- **"))!;
    expect(same).toContain("mine included: **511** ·");
  });
  test("the company's row still open at its reading says so", () => {
    const d = sample();
    d.prs_merged!.org!.weeks![11]!.partial = true;
    const first = renderBlock(d, { now: AT(1) }).split("\n").find((l) => l.startsWith("- **"))!;
    expect(first).toContain("mine included: **511** (the week open at its reading) ·");
    d.prs_merged!.org!.observed_at = "2026-09-30T05:00Z";
    const both = renderBlock(d, { now: AT(1) }).split("\n").find((l) => l.startsWith("- **"))!;
    expect(both).toContain("mine included: **511** (as of 2026-09-30 05:00 UTC, the week open at its reading) ·");
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
    expect(first).toContain("one search per week by author ·");
  });
  test("a repositories block that was not read says not measured", () => {
    const d = sample();
    d.repos_active_30d = { population: "org", source: "github_search", state: "rate_limited", observed_at: "2026-09-30T02:00Z" } as never;
    expect(validator()(d)).toEqual([]);
    expect(renderBlock(d, { now: AT(1) })).toContain("- **Repositories with a merge in the last 30 days**: not measured; the source turned the query away for its rate limit at this reading, as of 2026-09-30 02:00 UTC.");
  });
});
