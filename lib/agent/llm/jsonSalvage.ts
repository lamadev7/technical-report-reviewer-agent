// Recover a parseable JSON object/array from output that was cut off mid-token.
// Used when an LLM hits max-tokens mid-string. Walks the prefix with a
// brace/bracket depth tracker; truncates at the last safe boundary between
// top-level array items, closes any open structures, and re-parses. Returns
// null if not recoverable (e.g. truncation happens before the first item
// completes).
export function salvageTruncatedJson(text: string): unknown {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let escape = false;
  let lastSafe = -1;
  let arrayDepth = 0;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (ch === "[") arrayDepth++;
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (ch === "]") arrayDepth--;
      stack.pop();
      if (stack.length >= 1 && arrayDepth >= 1) lastSafe = i + 1;
      continue;
    }
    if (ch === "," && stack.length === 1 && arrayDepth === 1) {
      lastSafe = i;
    }
  }

  if (lastSafe < 0) return null;
  const prefix = text.slice(start, lastSafe);
  const closer = computeClosers(prefix);
  if (closer === null) return null;
  try {
    return JSON.parse(prefix + closer);
  } catch {
    return null;
  }
}

function computeClosers(prefix: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let escape = false;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) return null;
  return stack
    .reverse()
    .map((c) => (c === "{" ? "}" : "]"))
    .join("");
}
