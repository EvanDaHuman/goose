import os from "node:os";
import path from "node:path";

const root = process.env.GOOSE_ROOT ?? process.cwd();

function num(v: string | undefined, d: number) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
}

export const config = {
  root,
  // Runtime files live on disk; tracing them would bundle customer data and follow venv symlinks.
  varDir: path.join(/* turbopackIgnore: true */ root, "var"),
  jobsDir: process.env.GOOSE_JOBS_DIR ?? path.join(/* turbopackIgnore: true */ root, "var", "jobs"),
  engineDir: path.join(/* turbopackIgnore: true */ root, "engine"),
  home: os.homedir(),
  python: {
    engine: path.join(/* turbopackIgnore: true */ root, "var", "venvs", "engine", "bin", "python"),
    legacy: path.join(/* turbopackIgnore: true */ root, "var", "venvs", "legacy-py39", "bin", "python"),
    modern: process.env.GOOSE_MODERN_PYTHON ?? "/opt/homebrew/bin/python3.13",
    uv: process.env.GOOSE_UV ?? "/opt/homebrew/bin/uv",
  },
  databaseUrl: process.env.DATABASE_URL ?? "",
  pgAdminUrl: process.env.PG_ADMIN_URL ?? "",
  mode: (process.env.GOOSE_MODE === "naive" ? "naive" : "local") as "local" | "naive",
  publicJobsRequireApproval: process.env.GOOSE_PUBLIC_JOBS_REQUIRE_APPROVAL === "1",
  repositoryJobsOnly: process.env.GOOSE_REPOSITORY_JOBS_ONLY === "1",
  naive: {
    apiKey: process.env.VETTA_API_KEY ?? "",
    baseUrl: process.env.VETTA_API_BASE_URL || "https://api.vetta.sh",
    model: process.env.NAIVE_MODEL || "zai-org/GLM-5.2-FP8",
  },
  // GitHub App for reading customers' private repositories (read-only). See README: "Connecting GitHub".
  github: {
    appId: process.env.GITHUB_APP_ID ?? "",
    slug: process.env.GITHUB_APP_SLUG ?? "",
    clientId: process.env.GITHUB_APP_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? "",
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? "",
  },
  pilot: {
    priceUsd: num(process.env.PILOT_PRICE_USD, 1500),
    costLimitUsd: num(process.env.JOB_COST_LIMIT_USD, 25),
    repairBudget: num(process.env.REPAIR_BUDGET, 2),
    deliveryDays: num(process.env.DELIVERY_DAYS, 10),
  },
  // Naive's published price for an agent's computer is $0.0666 per hour (docs: platform/pricing).
  // Local runs are not billed; this rate only turns measured seconds into a labelled estimate.
  computerMicroUsdPerSecond: 18.5,
};

export function jobDir(jobId: string, ...parts: string[]) {
  return path.join(/* turbopackIgnore: true */ config.jobsDir, jobId, ...parts);
}

export const ROLES = {
  coordinator: {
    name: "Coordinator",
    owns: "Owns each customer job: scope, dependencies, spending, the repair budget, exceptions, billing and follow-up.",
  },
  assessment: {
    name: "Assessment agent",
    owns: "Reads the application and the customer's goal, and proposes a plan the company can carry out and verify.",
  },
  implementation: {
    name: "Implementation agent",
    owns: "Edits the actual repository and prepares data migrations, using the deterministic tools. Cannot read the frozen checks.",
  },
  verification: {
    name: "Verification agent",
    owns: "Records the original behaviour, freezes the acceptance checks, runs them independently and explains failures.",
  },
  // growth: the company finding its own work (lib/growth.ts). Internal only: they fill the prospect pipeline and write
  // drafts; nothing they produce leaves the company.
  research: {
    name: "Research agent",
    owns: "Finds organisations whose public code or announcements show outdated software Goose can upgrade, with a public source for every claim.",
  },
  qualification: {
    name: "Lead qualification agent",
    owns: "Scores each prospect against what Goose can carry out and verify today, and names the recipe that would apply.",
  },
  outreach: {
    name: "Outreach agent",
    owns: "Writes a specific, honest outreach draft for each qualified prospect: what is outdated, how Goose would fix it, and a link to the site. Drafts are sent over AgentMail only with the founder's authorization or the outreach policy.",
  },
  // roles of the first version (jobs before plan-driven delivery); kept so history keeps its original labels
  commercial: {
    name: "Commercial agent",
    owns: "First version: qualified prospects, assessed fit and wrote proposals (a deterministic worker in every recorded run).",
  },
  modernization: {
    name: "Modernization agent",
    owns: "First version: ran the fixed Flask-to-FastAPI conversion (a deterministic worker in every recorded run).",
  },
} as const;
export type Role = keyof typeof ROLES;
export const TEAM: Role[] = ["coordinator", "assessment", "implementation", "verification"];
export const GROWTH_TEAM: Role[] = ["research", "qualification", "outreach"];
