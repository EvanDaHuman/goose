// A small line diff (longest common subsequence) for showing code changes on screen.
export type DiffLine = { kind: " " | "+" | "-"; text: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: " ", text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: "-", text: x[i] }); i++; }
    else { out.push({ kind: "+", text: y[j] }); j++; }
  }
  while (i < n) out.push({ kind: "-", text: x[i++] });
  while (j < m) out.push({ kind: "+", text: y[j++] });
  return out;
}

/** Keep changed lines plus `context` lines around them. */
export function hunks(lines: DiffLine[], context = 2) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== " ") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (keep[i]) { out.push(l); gap = false; } else if (!gap) { out.push(null); gap = true; }
  });
  return out;
}

/** The source text of one Python function (top level) by name. */
export function pyFunction(src: string, name: string) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^def ${name}\\(`).test(l) || new RegExp(`^def _${name}\\(`).test(l));
  if (start < 0) return null;
  let s = start;
  while (s > 0 && (lines[s - 1].startsWith("@") || lines[s - 1].startsWith("#"))) s--;
  let e = start + 1;
  while (e < lines.length && (lines[e] === "" || /^\s/.test(lines[e]))) e++;
  while (e > start && lines[e - 1].trim() === "") e--;
  return lines.slice(s, e).join("\n");
}
