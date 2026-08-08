import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Replace a file without exposing a partially written JSON or Markdown file. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
