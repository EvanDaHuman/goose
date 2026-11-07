// Is Naive reachable with the configured key? Prints the state the operator page shows.
import { config } from "../lib/config";
import { naiveStatus } from "../lib/naive/client";

const s = await naiveStatus();
console.log(`mode: ${config.mode}\nNaive: ${s.state}\n${s.message}`);
if (s.organization) console.log(`organization: ${s.organization}, plan: ${s.plan}, balance: ${((s.balanceMicroUsd ?? 0) / 1e6).toFixed(2)} USD`);
process.exitCode = s.state === "ready" ? 0 : 2;
