// Seed settings (the pilot offer) and the researched prospects. Safe to run again.
import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config";
import { pool, q } from "../lib/db";

await q(`INSERT INTO settings (key, value) VALUES ('pilot_offer', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({
  price_usd: config.pilot.priceUsd, cost_limit_usd: config.pilot.costLimitUsd, repair_budget: config.pilot.repairBudget,
  delivery_days: config.pilot.deliveryDays, note: "Pilot price is an experiment to test willingness to pay, not a validated market rate.",
})]);

const file = path.join(process.cwd(), "docs", "research", "prospects.json");
if (fs.existsSync(file)) {
  const list = JSON.parse(fs.readFileSync(file, "utf8")) as any[];
  for (const p of list) {
    await q(`INSERT INTO prospects (name, url, category, summary, evidence, scope_fit, blockers, access_path, contact_channel,
               fit_score, last_activity, researched_on, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'researched')
             ON CONFLICT (url) DO NOTHING`,
      [p.name, p.url, p.category ?? null, p.summary ?? null, JSON.stringify(p.evidence ?? []), p.scope_fit ?? null,
       JSON.stringify(p.blockers ?? []), p.access_path ?? null, p.contact_channel ?? null, p.fit_score ?? null,
       p.last_activity ?? null, p.researched_on ?? null]);
  }
  console.log(`prospects: ${list.length} loaded from docs/research/prospects.json`);
  // the assessment engine's verdict on public code (docs/evidence/public-prospect-assessments.md)
  const verdicts: Record<string, string> = {
    "https://github.com/betheluniversity/classifieds": "Engine on public code: not supported today - Flask-SQLAlchemy, server-rendered pages, sessions.",
    "https://github.com/eddieferrer/sizesquirrel-open": "Engine on public code: not supported today - Flask-SQLAlchemy, server-rendered pages, 9,814 lines.",
  };
  for (const [url, note] of Object.entries(verdicts)) await q("UPDATE prospects SET notes = $2 WHERE url = $1 AND notes IS NULL", [url, note]);
} else {
  console.log("prospects: docs/research/prospects.json not found (skipped)");
}
await pool.end();
