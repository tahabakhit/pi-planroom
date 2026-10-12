import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { boundedText, decodeRevision, makeRevision, type Baseline, type Revision, type Snapshot } from "../core/model.ts";

const MAX_RECORD = 256 * 1024;
function pathParts(path: string): string[] {
  const full = resolve(path); const parts = full.split(sep); let current = full.startsWith(sep) ? sep : parts.shift()!;
  return parts.filter(Boolean).map(part => current = join(current, part));
}
export function rejectSymlinks(path: string): void {
  for (const part of pathParts(path)) {
    try { if (lstatSync(part).isSymbolicLink()) throw new Error("Symlink paths are not supported."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export function privateDirectory(path: string): void {
  rejectSymlinks(path); mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error("Expected a private directory.");
  // Existing shared directories are not silently chmodded.
  if ((lstatSync(path).mode & 0o077) !== 0) throw new Error("Planroom directories must have owner-only permissions (0700).");
}
function requirePrivateDirectory(path: string): void {
  rejectSymlinks(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("Planroom directories must be owner-only (0700).");
}
export function readBounded(path: string, max = MAX_RECORD): string {
  rejectSymlinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error("Expected a bounded regular file.");
    const data = readFileSync(fd);
    if (data.byteLength > max) throw new Error("File exceeded the bound while reading.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return text;
  } finally { closeSync(fd); }
}
export function publishExclusive(path: string, text: string): void {
  rejectSymlinks(path); const parent = dirname(path);
  if (!lstatSync(parent).isDirectory()) throw new Error("Missing parent directory.");
  const temporary = join(parent, `.tmp-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, path);
    const dirfd = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
}
function validId(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid plan identity."); return id;
}
export class PlanStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  directory(id: string): string { return join(this.root, validId(id)); }
  read(id: string, number: number): Revision {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid revision number.");
    requirePrivateDirectory(this.root); requirePrivateDirectory(this.directory(id));
    const revision = decodeRevision(JSON.parse(readBounded(join(this.directory(id), `${number}.json`))));
    if (revision.planId !== id || revision.number !== number) throw new Error("Artifact path and identity disagree.");
    return revision;
  }
  numbers(id: string): number[] {
    rejectSymlinks(this.directory(id));
    try {
      requirePrivateDirectory(this.root); requirePrivateDirectory(this.directory(id));
      const numbers = readdirSync(this.directory(id)).filter(n => /^[1-9]\d*\.json$/.test(n)).map(n => Number(n.slice(0, -5))).sort((a, b) => a - b);
      if (numbers.length > 1000) throw new Error("Revision history bound exceeded; start a new plan instead of extending this history.");
      return numbers;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  write(state: Snapshot, markdown: string, baseline: Baseline[]): Revision {
    if (!state.planId) throw new Error("No plan is active.");
    privateDirectory(this.root); const directory = this.directory(state.planId); privateDirectory(directory);
    const lock = join(directory, ".lock");
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Plan is locked by another writer or an interrupted write. Inspect /plan recover."); throw error; }
    const token = randomUUID(); let ownerWritten = false;
    try {
      publishExclusive(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token })); ownerWritten = true;
      if (state.revision) {
        const original = this.read(state.planId, state.revision);
        if (original.hash !== state.hash) throw new Error("The branch revision failed its integrity check.");
      }
      const numbers = this.numbers(state.planId);
      if (numbers.length >= 1000) throw new Error("Revision history is full; start a new plan.");
      const revision = makeRevision(state, (numbers.at(-1) ?? 0) + 1, markdown, baseline);
      decodeRevision(revision);
      const serialized = JSON.stringify(revision);
      if (Buffer.byteLength(serialized) > MAX_RECORD) throw new Error("Revision record exceeds 256 KiB; reduce the evidence/document payload.");
      publishExclusive(join(directory, `${revision.number}.json`), serialized);
      return revision;
    } finally {
      if (ownerWritten) unlinkSync(join(lock, "owner.json"));
      rmdirSync(lock);
    }
  }
  list(): Revision[] {
    rejectSymlinks(this.root);
    if (!existsSync(this.root)) return [];
    requirePrivateDirectory(this.root);
    const ids = readdirSync(this.root).filter(id => /^[a-f0-9-]{36}$/.test(id));
    if (ids.length > 1000) throw new Error("Plan browser bound exceeded; archive older plan directories outside the active store.");
    return ids.map(id => { const number = this.numbers(id).at(-1); return number ? this.read(id, number) : undefined; })
      .filter((r): r is Revision => !!r).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  inspectLock(id: string): { pid: number; alive: boolean } | null {
    const path = join(this.directory(id), ".lock", "owner.json");
    if (!existsSync(path)) {
      if (existsSync(dirname(path))) throw new Error("Incomplete lock reservation; inspect and archive it manually while all Planroom sessions are stopped.");
      return null;
    }
    const owner = JSON.parse(readBounded(path, 1024));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Malformed lock owner; manual inspection required.");
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    return { pid: owner.pid, alive };
  }
  recoverLock(id: string): string {
    const owner = this.inspectLock(id);
    if (!owner || owner.alive) throw new Error("No recoverable dead-writer lock.");
    const path = join(this.directory(id), ".lock"); rejectSymlinks(path);
    const archived = join(this.directory(id), `.recovered-lock-${randomUUID()}`);
    renameSync(path, archived); return archived;
  }
  export(revision: Revision, path: string, workspace: string): string {
    if (boundedText(path, 4096) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Export path cannot contain controls or outer whitespace.");
    const target = resolve(workspace, path); const root = realpathSync(workspace);
    const rel = relative(root, target);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(root, rel) !== target) throw new Error("Export must target a new file inside the workspace.");
    if (!target.endsWith(".md")) throw new Error("Export requires a .md filename.");
    rejectSymlinks(target); if (!lstatSync(dirname(target)).isDirectory()) throw new Error("Export parent must already exist.");
    publishExclusive(target, revision.markdown + "\n"); return target;
  }
}
