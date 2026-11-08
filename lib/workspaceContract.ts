import fs from "node:fs";
import path from "node:path";
import { repairEvidence } from "./migrationContract";

export type Command = { argv: string[]; stdin?: string; timeout_seconds?: number };
export type WorkspaceCheck = {
  id: string; title: string; kind: "preserve" | "requirement";
  source?: Command; target: Command; compare: "json" | "text" | "exit";
  expected?: unknown; exit_code?: number;
};
export type WorkspaceContract = {
  version: 1; title: string; source_build: Command[]; target_build: Command[];
  checks: WorkspaceCheck[]; deliverables: string[]; limitations: string[];
};
export const COMMAND_TOOLS = ["python3", "node", "cargo", "rustc", "go", "g++", "clang++", "cmake", "ctest", "make", "goose-ros2"];
export const CONTRACT_SHAPE = `{version:1,title:string,source_build:[{argv:[program,...args],timeout_seconds?:number}],target_build:[{argv:[program,...args]}],checks:[{id:string,title:string,kind:"preserve"|"requirement",source?:{argv:[program,...args],stdin?:string},target:{argv:[program,...args],stdin?:string},compare:"json"|"text"|"exit",expected?:JSONvalue,exit_code?:number}],deliverables:[relativeFilePath],limitations:[string]}`;
export function safeRelative(file: unknown): file is string {
  return typeof file === "string" && file.length > 0 && file.length < 300 && !file.includes("\0") && !file.includes("\\") && !path.isAbsolute(file) && !file.split("/").some(p => p === "..") && file !== ".";
}
export function commandProblems(command: any): string[] {
  if (!command || !Array.isArray(command.argv) || !command.argv.length || command.argv.length > 40 || command.argv.some((x: any) => typeof x !== "string" || x.length > 8000 || x.includes("\0"))) return ["Command must contain a bounded argv array"];
  const program = command.argv[0];
  const errors: string[] = [];
  if (!COMMAND_TOOLS.includes(program) && !(program.startsWith("./") && safeRelative(program.slice(2)))) errors.push(`Unsupported command program: ${program}`);
  if (program === "goose-ros2" && (command.argv.length !== 2 || !["baseline", "build", "verify", "simulate"].includes(command.argv[1]) || command.stdin !== undefined)) errors.push("Robotics commands accept exactly one trusted phase, with no stdin or additional arguments");
  if (command.stdin !== undefined && (typeof command.stdin !== "string" || command.stdin.length > 100_000)) errors.push("Command input must be a string under 100 KB");
  const maxTimeout = program === "goose-ros2" ? 900 : 180;
  if (command.timeout_seconds !== undefined && (!Number.isInteger(command.timeout_seconds) || command.timeout_seconds < 1 || command.timeout_seconds > maxTimeout)) errors.push(`Command timeout must be 1 to ${maxTimeout} seconds`);
  return errors;
}
export function workspaceProblems(value: any): string[] {
  const errors: string[] = [];
  if (!value || value.version !== 1 || typeof value.title !== "string" || !value.title.trim()) return ["A version 1 contract with a title is required"];
  for (const field of ["source_build", "target_build"] as const) {
    if (!Array.isArray(value[field]) || value[field].length > 8) errors.push(`${field} must contain up to 8 commands`);
    else for (const command of value[field]) errors.push(...commandProblems(command));
  }
  if (!Array.isArray(value.checks) || value.checks.length < 2 || value.checks.length > 40) errors.push("Provide 2 to 40 independent checks");
  else {
    const ids = new Set();
    for (const check of value.checks) {
      if (!check || typeof check !== "object" || Array.isArray(check)) { errors.push("Every check must be an executable check object"); continue; }
      if (!/^[a-zA-Z0-9_-]{1,60}$/.test(check?.id ?? "") || ids.has(check.id)) errors.push("Check ids must be unique simple identifiers");
      ids.add(check?.id);
      if (typeof check?.title !== "string" || !check.title.trim()) errors.push("Every check needs a description");
      if (!["preserve", "requirement"].includes(check?.kind)) errors.push("Check kind must be preserve or requirement");
      if (!["json", "text", "exit"].includes(check?.compare)) errors.push("Unknown comparison type");
      errors.push(...commandProblems(check?.target));
      if (check?.kind === "preserve") errors.push(...commandProblems(check.source));
      if (check?.kind === "requirement" && check.compare !== "exit" && !Object.hasOwn(check,"expected")) errors.push("New requirements need an explicit expected result");
      if (check?.exit_code !== undefined && (!Number.isInteger(check.exit_code) || check.exit_code < 0 || check.exit_code > 255)) errors.push("Exit code must be an integer from 0 to 255");
    }
    if (!value.checks.some((c:any)=>c?.kind==="preserve")) errors.push("At least one original behavior must be recorded");
  }
  if (!Array.isArray(value.deliverables) || !value.deliverables.length || value.deliverables.length > 30 || value.deliverables.some((p:any)=>!safeRelative(p))) errors.push("Deliverables must be relative file paths");
  if (!Array.isArray(value.limitations) || value.limitations.some((s:any)=>typeof s!=="string")) errors.push("State the verification limitations");
  return [...new Set(errors)];
}
export function workspaceRepairFeedback(report: { summary: unknown; failed: any[] }) {
  const failures = repairEvidence(report.failed);
  return { summary: report.summary, failed: failures.map((failure, index) => {
    const check = report.failed[index];
    // Compiler/runtime errors originate in the candidate, not the withheld baseline.
    const executionError = ["execution", "build"].includes(check.category) && typeof check.actual === "string" ? check.actual.slice(-3000) : undefined;
    return { ...failure, ...(executionError ? { execution_error: executionError } : {}),
      ...(typeof check.actual?.stderr==="string" ? {candidate_error:check.actual.stderr.slice(-3000)} : {}),
      ...(Number.isInteger(check.actual?.exit) ? { actual_exit_code: check.actual.exit } : {}) };
  }) };
}
export function observedOutput(result: {stdout:string;code:number|null;stdoutTruncated?:boolean}, compare: WorkspaceCheck["compare"]) {
  if (compare === "exit") return result.code;
  if (result.stdoutTruncated) throw new Error("Command output exceeded the capture limit; comparing partial output is not valid evidence");
  if (compare === "json") return JSON.parse(result.stdout.trim());
  return result.stdout.replace(/\r\n/g,"\n");
}
export function availablePrograms() {
  const paths: Record<string,string> = {
    python3: process.env.GOOSE_WORKSPACE_PYTHON || "/opt/homebrew/bin/python3.13", node: process.execPath,
    cargo:"/opt/homebrew/bin/cargo", rustc:"/opt/homebrew/bin/rustc", go:"/opt/homebrew/bin/go",
    "g++":"/usr/bin/g++", "clang++":"/usr/bin/clang++", cmake:"/opt/homebrew/bin/cmake", ctest:"/opt/homebrew/bin/ctest", make:"/usr/bin/make",
    "goose-ros2":path.join(process.cwd(),"robotics","run.py"),
  };
  return Object.fromEntries(Object.entries(paths).filter(([,p])=>fs.existsSync(p)));
}
