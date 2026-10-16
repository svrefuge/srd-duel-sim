export interface TagMatch {
  tag: string;
  body: string;
  index: number;
  end: number;
  raw: string;
}

export function flattenEntries(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenEntries).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return [obj.name, obj.entries, obj.items].map(flattenEntries).filter(Boolean).join(" ");
  }
  return "";
}

export function findTags(text: string, tag?: string): TagMatch[] {
  const out: TagMatch[] = [];
  const re = /\{@([a-zA-Z0-9]+)(?:\s+([^}]*?))?\}/g;
  for (let match; (match = re.exec(text));) {
    if (tag && match[1] !== tag) continue;
    out.push({ tag: match[1], body: match[2] || "", index: match.index, end: re.lastIndex, raw: match[0] });
  }
  return out;
}

export function stripTags(text: string): string {
  return text.replace(/\{@[a-zA-Z0-9]+ ([^}|]+)(?:\|[^}]*)?\}/g, "$1").replace(/\{@[a-zA-Z0-9]+\}/g, "");
}

export function tagName(body: string): string {
  return body.split("|")[0].trim();
}
