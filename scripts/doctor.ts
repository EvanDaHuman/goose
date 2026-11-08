// Read-only readiness diagnostics. Provider keys and database URLs are never printed.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { createClient } from "@usenaive-sdk/vetta";
import { config } from "../lib/config";
import { naiveStatus } from "../lib/naive/client";
import { availablePrograms, COMMAND_TOOLS } from "../lib/workspaceContract";
import { agentMailInboundStatus } from "../lib/integrations/agentmail";
import { emailStatus } from "../lib/integrations/email";
import { paymentStatus, publicBaseUrl } from "../lib/integrations/stripe";

type Check = { name:string; state:"ready"|"pending"|"failed"; detail:string; missing?:string[]; required?:boolean };
const checks: Check[]=[];
let schemaReady=false,agentsReady=false;
const database=new pg.Client({connectionString:config.databaseUrl,connectionTimeoutMillis:3000,query_timeout:5000});
try {
  if(!config.databaseUrl) throw new Error("Missing database configuration");
  await database.connect();
  checks.push({name:"PostgreSQL",state:"ready",detail:"Connected to the configured company database.",required:true});
  const sql=fs.readdirSync("db/migrations").filter(f=>f.endsWith(".sql")).sort().map(f=>fs.readFileSync(path.join("db/migrations",f),"utf8")).join("\n");
  const expected=[...new Set([...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map(m=>m[1]))];
  const tables=(await database.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1)",[expected])).rows.map(r=>r.table_name);
  const missing=expected.filter(t=>!tables.includes(t));
  const criticalColumns=[['commerce_outbox','purpose'],['commerce_change_requests','starting_at'],['commerce_inquiries','external_event_id'],['commerce_inquiries','payload_sha256']];
  for(const [table,column] of criticalColumns) {
    const found=await database.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",[table,column]);
    if(!found.rowCount)missing.push(`${table}.${column}`);
  }
  schemaReady=missing.length===0;
  checks.push({name:"Database schema",state:schemaReady?"ready":"failed",required:true,detail:schemaReady?`All ${expected.length} expected tables and current commerce columns exist.`:"Run npm run db:migrate.",missing});
  if(tables.includes("naive_resources")) {
    const roles=(await database.query("SELECT role FROM naive_resources")).rows.map(r=>r.role);
    const absent=['coordinator','assessment','implementation','verification','research','qualification','outreach'].filter(role=>!roles.includes(role));
    agentsReady=absent.length===0;
    checks.push({name:"Naive team registry",state:agentsReady?"ready":"pending",detail:agentsReady?"All seven company agent roles are provisioned.":"Run npm run naive:provision after configuring Naive.",missing:absent});
  }
} catch {checks.push({name:"Database readiness",state:"failed",required:true,detail:"Cannot inspect the configured database. Check DATABASE_URL and start PostgreSQL; then run npm run db:migrate."});}
finally {await database.end().catch(()=>{});}
const operatorReady=(process.env.GOOSE_OPERATOR_TOKEN?.length??0)>=24;
checks.push({name:"Operator access",state:operatorReady?"ready":"failed",required:true,detail:operatorReady?"An operator credential of sufficient length is configured.":"Set GOOSE_OPERATOR_TOKEN to at least 24 random characters."});
try {
  const url=publicBaseUrl(), https=url.startsWith("https://");
  checks.push({name:"Public URL",state:"ready",detail:`${url}${https?"":" (local HTTP; live Stripe checkout requires HTTPS)"}`});
} catch {checks.push({name:"Public URL",state:"failed",required:true,detail:"GOOSE_PUBLIC_URL must be a valid HTTP(S) origin without credentials."});}
const native=availablePrograms();
const essential=["python3","node"].filter(name=>!native[name]);
checks.push({name:"Native execution tools",state:essential.length?"failed":"ready",required:true,detail:`Detected: ${Object.keys(native).filter(n=>n!=="goose-ros2").join(", ")}. Job-specific preflight still gates unsupported runtimes.`,missing:COMMAND_TOOLS.filter(n=>n!=="goose-ros2"&&!native[n])});
checks.push({name:"Python engine",state:fs.existsSync(config.python.engine)?"ready":"failed",required:true,detail:fs.existsSync(config.python.engine)?"Engine virtual environment is present.":"Run npm run setup to create the engine environment."});
const sqlite=spawnSync(process.execPath,["--input-type=module","-e","import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.close();"],{timeout:5000,encoding:"utf8"});
checks.push({name:"Node SQLite adapter",state:sqlite.status===0?"ready":"pending",detail:sqlite.status===0?"node:sqlite is available.":"This Node runtime cannot run the SQLite adapter; use a supported Node version or another target."});
const containerRuntime=spawnSync("docker",["version","--format","{{.Server.Os}}"],{timeout:10000,encoding:"utf8"});
const autonomousReady=containerRuntime.status===0&&containerRuntime.stdout.trim()==="linux";
checks.push({name:"Autonomous Linux execution",state:autonomousReady?"ready":"pending",detail:autonomousReady?"Docker Linux backend is reachable; each repository still needs successful discovery and acceptance review.":"Start a Docker Linux backend before accepting autonomous repository jobs. Legacy execution remains separate."});
const image=process.env.GOOSE_ROBOTICS_IMAGE??"goose-robotics:jazzy";
const docker=spawnSync("docker",["image","inspect",image,"--format","{{.Id}}"],{timeout:5000,encoding:"utf8"});
checks.push({name:"Optional ROS image",state:docker.status===0?"ready":"pending",detail:docker.status===0?`${image} is available locally. Simulation still requires its own passing validation.`:`${image} is not reachable locally. Robotics is pending; other job types remain available.`});
let liveNaiveReady=false;
if(!config.naive.apiKey)checks.push({name:"Naive live engineering",state:"pending",detail:"Set VETTA_API_KEY, provision the team, then choose GOOSE_MODE=naive.",missing:["VETTA_API_KEY"]});
else {
  const signal=AbortSignal.timeout(15000);
  const client=createClient({baseUrl:config.naive.baseUrl,apiKey:config.naive.apiKey,idempotencyKey:randomUUID,fetch:(input,init)=>fetch(input,{...init,signal})});
  const status=await naiveStatus(client);
  liveNaiveReady=status.state==="ready"&&agentsReady;
  checks.push({name:"Naive live engineering",state:status.state==="ready"?"ready":"pending",detail:status.state==="ready"?`Read-only account/model checks passed. Runtime mode: ${config.mode}.`:`Naive readiness: ${status.state}. Run npm run naive:status for activation guidance.`});
}
const email=emailStatus(),payments=paymentStatus();
const inbound=agentMailInboundStatus();
checks.push({name:"Native AgentMail intake",state:inbound.ready?"ready":"pending",detail:inbound.ready?`Signature/inbox configuration present; ${inbound.mode} inquiries. Register /api/webhooks/agentmail with AgentMail.`:inbound.issues.length?inbound.issues.join(". "):"Pending AgentMail webhook secret/inbox. Website inquiries remain available; no custom gateway is needed for AgentMail.",missing:inbound.missing});
checks.push({name:"External email",state:email.ready?"ready":"pending",detail:email.ready?`${email.provider} configuration is present. Credentials are not tested; transactional sends still require policy authorization.`:"Pending provider activation. Local test receipts are fully available.",missing:email.missing as string[]});
checks.push({name:"Stripe payments",state:payments.ready?"ready":"pending",detail:payments.ready?`${payments.mode} key configuration is present. Invoice mode must match; no provider request was made.`:payments.issues.length ? payments.issues.join(". ") : "Pending provider activation. TEST invoices support local settlement; real invoices remain unpaid.",missing:payments.missing as string[]});
checks.push({name:"Inbound inquiry gateway",state:process.env.GOOSE_INQUIRY_WEBHOOK_SECRET?"ready":"pending",detail:process.env.GOOSE_INQUIRY_WEBHOOK_SECRET?"Signing secret present; configure your gateway to use the documented schema.":"Optional signed gateway is unconfigured. Website inquiry intake remains available.",missing:process.env.GOOSE_INQUIRY_WEBHOOK_SECRET?[]:["GOOSE_INQUIRY_WEBHOOK_SECRET"]});
const coreReady=schemaReady&&checks.filter(c=>c.required).every(c=>c.state==="ready");
console.log(JSON.stringify({checkedAt:new Date().toISOString(),applicationCoreReady:coreReady,liveEngineeringReady:coreReady&&liveNaiveReady&&config.mode==="naive",autonomousEngineeringReady:coreReady&&liveNaiveReady&&autonomousReady&&config.mode==="naive",naiveAccountReady:liveNaiveReady,mode:config.mode,checks,
  notice:"No secrets printed. No emails, charges, engineering jobs, or model inference were initiated. Optional provider activation is separate from local test functionality."},null,2));
process.exitCode=coreReady?0:1;
