import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(process.cwd(), process.env.STORAGE_DIR || "./storage");

export type StorageKind = "reports" | "templates" | "samples" | "screenshots";

export async function save(kind: StorageKind, originalName: string, data: Buffer): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();
  const id = randomUUID();
  const dir = path.join(ROOT, kind);
  await fs.mkdir(dir, { recursive: true });
  const abs = path.join(dir, `${id}${ext}`);
  await fs.writeFile(abs, data);
  return path.relative(ROOT, abs);
}

export async function load(relPath: string): Promise<Buffer> {
  return fs.readFile(path.join(ROOT, relPath));
}

export async function remove(relPath: string): Promise<void> {
  await fs.unlink(path.join(ROOT, relPath)).catch(() => {});
}

export function absPath(relPath: string): string {
  return path.join(ROOT, relPath);
}
