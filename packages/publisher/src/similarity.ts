const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const shingles = (t: string, n = 3): Set<string> => {
  const w = words(t);
  const out = new Set<string>();
  if (w.length < n) out.add(w.join(" "));
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
};

/** Jaccard overlap of word trigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  let inter = 0;
  for (const s of x) if (y.has(s)) inter++;
  const union = x.size + y.size - inter;
  return union === 0 ? 0 : inter / union;
}

export const maxSimilarity = (text: string, previous: string[]): number =>
  previous.reduce((m, p) => Math.max(m, similarity(text, p)), 0);
