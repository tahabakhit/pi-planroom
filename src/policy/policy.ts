import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { boundedText, digest, type Baseline } from "../core/model.ts";
import { readBounded, rejectSymlinks } from "../storage/store.ts";

export interface Policy { allowedTools: string[]; inspectionCommands: string[]; readRoots: string[] }
export const defaultPolicy = (): Policy => ({ allowedTools: [], inspectionCommands: [], readRoots: [] });
const RESERVED = new Set(["edit", "write", "powershell", "codemode", "plan_progress"]);
const SECRET = /(?:^|[\\/])(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|\.npmrc|id_(?:rsa|ed25519)|\.ssh|\.aws)(?:[\\/]|$)/i;
export function workspacePath(path: string, workspace: string, extraRoots: string[] = []): string {
  if (boundedText(path, 4096) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Read paths cannot have outer whitespace or terminal controls.");
  const target = resolve(workspace, path);
  if (boundedText(target, 4096) !== target || /[\x00-\x1f\x7f]/.test(target)) throw new Error("Unsupported canonical read path.");
  rejectSymlinks(target);
  if (SECRET.test(target)) throw new Error("Known credential paths are not planning inputs.");
  const roots = [workspace, ...extraRoots].map(root => realpathSync(root));
  if (!roots.some(root => { const rel = relative(root, target); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); })) throw new Error("Path is outside the admitted read roots.");
  return target;
}
/** A deliberately restricted literal grammar, not a general shell parser. */
export function tokenize(command: string): string[] {
  if (!command.trim() || command.length > 4096 || /[\x00-\x1f\x7f$`\\;&|<>(){}]/.test(command)) throw new Error("Unsupported shell syntax; use native read/search tools.");
  const tokens: string[] = []; let i = 0;
  while (i < command.length) {
    if (/\s/.test(command[i])) { i++; continue; }
    let token = "";
    if (command[i] === "'" || command[i] === '"') {
      const quote = command[i++];
      while (i < command.length && command[i] !== quote) token += command[i++];
      if (i === command.length) throw new Error("Unclosed literal quote.");
      i++;
      if (i < command.length && !/\s/.test(command[i])) throw new Error("Adjacent quoted shell fragments are unsupported.");
    } else {
      while (i < command.length && !/\s/.test(command[i])) {
        if (!/[A-Za-z0-9_./:=,@%+^\-]/.test(command[i])) throw new Error("Unsupported literal token.");
        token += command[i++];
      }
    }
    if (!token || /[*?~\[\]!]/.test(token)) throw new Error("Shell expansion is unsupported.");
    tokens.push(token);
  }
  if (!tokens.length) throw new Error("Missing command."); return tokens;
}
const quote = (token: string): string => "'" + token.replaceAll("'", "'\\''") + "'";
export function inspectionCommand(command: string, workspace: string, policy: Policy, trusted: boolean): string {
  const tokens = tokenize(command), [name, ...args] = tokens;
  const normalized = JSON.stringify(tokens);
  if (policy.inspectionCommands.some(value => JSON.stringify(tokenize(value)) === normalized)) {
    if (!trusted) throw new Error("Configured executable checks require project trust.");
    return tokens.map(quote).join(" ");
  }
  const paths = (values: string[]) => { for (const path of values) workspacePath(path, workspace, policy.readRoots); };
  if (["pwd", "whoami", "hostname"].includes(name) && args.length === 0) return name;
  if (name === "uname" && args.every(a => ["-s", "-r", "-m"].includes(a))) return tokens.map(quote).join(" ");
  if (name === "ls") {
    const positional = args.filter(a => !a.startsWith("-"));
    if (args.some(a => a.startsWith("-") && !["-a", "-l", "-la", "-al", "-lh", "-1", "--"].includes(a))) throw new Error("Unsupported ls option.");
    paths(positional); return tokens.map(quote).join(" ");
  }
  if (["wc", "head", "tail"].includes(name)) {
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-n" && name !== "wc") { const n = Number(args[++i]); if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("Invalid line bound."); }
      else if (a.startsWith("-") && !(name === "wc" && ["-l", "-c", "-w", "--"].includes(a))) throw new Error("Unsupported inspection option.");
      else if (a !== "--") positional.push(a);
    }
    if (!positional.length) throw new Error("Specify bounded input files."); paths(positional);
    if (positional.some(path => { const target = workspacePath(path, workspace, policy.readRoots); return !existsSync(target) || !statSync(target).isFile() || statSync(target).size > 2 * 1024 * 1024; })) throw new Error("Inspect only regular files no larger than 2 MiB.");
    return tokens.map(quote).join(" ");
  }
  if (name === "git") {
    const [subcommand, ...rest] = args;
    const flags: Record<string, string[]> = {
      status: ["--short", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "-sb", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"],
      diff: ["--stat", "--name-only", "--name-status", "--cached", "--staged", "--no-ext-diff", "--no-textconv", "--color=never"],
      log: ["--oneline", "--no-decorate", "--no-ext-diff", "--no-textconv", "--color=never"],
      show: ["--stat", "--name-only", "--name-status", "--no-ext-diff", "--no-textconv", "--color=never"],
      "rev-parse": ["--show-toplevel", "--verify", "--short"],
    };
    if (!flags[subcommand]) throw new Error("Git mutation/global options are not permitted.");
    let afterSeparator = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--") { afterSeparator = true; continue; }
      if (afterSeparator) { paths([a]); continue; }
      if (subcommand === "log" && /^--max-count=(?:[1-9]\d?|100)$/.test(a)) continue;
      if (subcommand === "log" && a === "-n" && /^(?:[1-9]\d?|100)$/.test(rest[++i] ?? "")) continue;
      if (a.startsWith("-") && !flags[subcommand].includes(a)) throw new Error("Unsupported Git inspection option.");
      if (!a.startsWith("-") && !/^(?:HEAD(?:[~^]\d*)?|[a-f0-9]{7,40}|[A-Za-z0-9_.\/-]+)$/.test(a)) throw new Error("Unsupported Git revision.");
    }
    if (subcommand === "log" && !rest.some(a => a === "-n" || a.startsWith("--max-count="))) rest.unshift("--max-count=30");
    const prefix = ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "--no-pager", subcommand];
    if (["diff", "log", "show"].includes(subcommand)) prefix.push("--no-ext-diff", "--no-textconv");
    return [...prefix, ...rest].map(quote).join(" ");
  }
  throw new Error("Command is not in the reviewed inspection grammar.");
}
export function gate(tool: string, input: Record<string, unknown>, workspace: string, policy: Policy, trusted: boolean): { command?: string } {
  if (["plan_question", "plan_submit", "plan_read"].includes(tool)) return {};
  if (RESERVED.has(tool)) throw new Error(`${tool} is unavailable during planning.`);
  if (["read", "grep", "find", "ls"].includes(tool)) {
    if (input.path !== undefined && typeof input.path !== "string") throw new Error("Invalid input path.");
    const target = workspacePath(typeof input.path === "string" ? input.path : ".", workspace, policy.readRoots);
    // Native grep uses --hidden. A directory search could read credential files that
    // are not ignored, so content searches must name a vetted regular file.
    if (tool === "grep" && (!existsSync(target) || !statSync(target).isFile())) throw new Error("Discover files with find/ls, then grep explicit files; directory content searches are not admitted.");
    return {};
  }
  if (tool === "bash") {
    if (typeof input.command !== "string") throw new Error("Missing shell command.");
    return { command: inspectionCommand(input.command, workspace, policy, trusted) };
  }
  if (policy.allowedTools.includes(tool)) return {};
  throw new Error(`Tool '${tool}' has not been admitted to planning. Tool annotations do not grant permission.`);
}
export function capture(path: string, workspace: string, roots: string[] = []): Baseline {
  const target = workspacePath(path, workspace, roots);
  if (!existsSync(target)) return { path: target, hash: null };
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Baseline requires a regular file no larger than 2 MiB.");
  const data = readFileSync(target);
  if (data.byteLength > 2 * 1024 * 1024) throw new Error("Baseline input grew beyond its bound.");
  return { path: target, hash: digest(data) };
}
export function drift(baseline: Baseline[], workspace: string, roots: string[] = []): string[] {
  return baseline.filter(item => {
    try { return capture(item.path, workspace, roots).hash !== item.hash; } catch { return true; }
  }).map(item => item.path);
}
export interface Settings { policy: Policy; shortcut: string | null; reviewerTimeoutMs: number; reviewerMaxTokens: number }
export function settings(agentDir: string, workspace: string, projectTrusted: boolean): Settings {
  const result: Settings = { policy: defaultPolicy(), shortcut: null, reviewerTimeoutMs: 120000, reviewerMaxTokens: 4096 };
  const load = (path: string): Record<string, unknown> => {
    if (!existsSync(path)) return {};
    const value = JSON.parse(readBounded(path, 16384));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object.");
    return value;
  };
  const user = load(resolve(agentDir, "pi-planroom.json"));
  const keys = new Set(["allowedTools", "inspectionCommands", "readRoots", "shortcut", "reviewerTimeoutMs", "reviewerMaxTokens"]);
  if (Object.keys(user).some(key => !keys.has(key))) throw new Error("Unknown user Planroom setting.");
  for (const key of ["allowedTools", "inspectionCommands", "readRoots"] as const) {
    const value = user[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > 40 || !value.every(v => typeof v === "string" && v.length > 0 && v.length <= 4096)) throw new Error(`Invalid ${key}.`);
    result.policy[key] = value;
  }
  if (result.policy.allowedTools.some(tool => RESERVED.has(tool) || tool === "bash")) throw new Error("Reserved tools cannot be admitted by name.");
  result.policy.inspectionCommands.forEach(tokenize);
  if (result.policy.readRoots.some(root => !isAbsolute(root))) throw new Error("Additional read roots must be explicit absolute paths.");
  if (user.shortcut !== undefined && user.shortcut !== null && (typeof user.shortcut !== "string" || !/^f(?:[6-9]|1[0-2])$/.test(user.shortcut))) throw new Error("Shortcut must be an otherwise unbound function key f6–f12.");
  result.shortcut = user.shortcut === undefined ? null : user.shortcut as string | null;
  const project = projectTrusted ? load(resolve(workspace, ".pi", "pi-planroom.json")) : {};
  if (Object.keys(project).some(key => !keys.has(key))) throw new Error("Unknown project Planroom setting.");
  if (["allowedTools", "inspectionCommands", "readRoots", "shortcut"].some(key => key in project)) throw new Error("Project settings cannot widen policy or set global shortcuts.");
  for (const key of ["reviewerTimeoutMs", "reviewerMaxTokens"] as const) {
    const value = project[key] ?? user[key]; if (value === undefined) continue;
    const max = key === "reviewerTimeoutMs" ? 600000 : 8192;
    const min = key === "reviewerTimeoutMs" ? 1000 : 256;
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${key}.`);
    result[key] = Number(value);
  }
  return result;
}
