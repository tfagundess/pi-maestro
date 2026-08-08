import { isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && IDENTIFIER.test(value);
}

export function assertIdentifier(value: string, label: string): void {
  if (!validIdentifier(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)} (letters, digits, - and _ only)`);
  }
}

/** Resolve a user-supplied relative path without lexical traversal. */
export function safeRelativePath(root: string, input: string, label: string): string {
  if (!input || input.includes("\0") || input.length > 1024) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(input)}`);
  }
  const normalized = input.replaceAll("\\", "/");
  if (isAbsolute(input) || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`${label} must be relative: ${input}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must not contain traversal: ${input}`);
  }
  const base = resolve(root);
  const candidate = resolve(base, ...parts);
  const rel = relative(base, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} escapes its directory: ${input}`);
  }
  return candidate;
}

/** Reject an existing symlink that resolves outside its intended directory. */
export async function assertRealPathInside(root: string, candidate: string, label: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const [realRoot, realCandidate] = await Promise.all([realpath(absoluteRoot), realpath(candidate)]);
  const rootRel = relative(absoluteRoot, realRoot);
  const rel = relative(realRoot, realCandidate);
  if (rootRel.startsWith("..") || isAbsolute(rootRel) || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} escapes its directory: ${candidate}`);
  }
  return realCandidate;
}
