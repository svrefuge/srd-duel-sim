#!/usr/bin/env node
// Freezes the published results: copies the sweep outputs from out/ into results/, and derives the
// single-file rankings, the plots and the manifest from them.
//   node tools/make-results.mjs [--scenarios max30,max120,max600]
// Everything written here is a function of the files in out/, so rerunning it changes nothing.
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");
const dest = path.join(root, "results");
const plotDir = path.join(dest, "plots");
const scenarioArg = process.argv.indexOf("--scenarios");
const SCENARIOS = (scenarioArg > 0 ? process.argv[scenarioArg + 1] : "max30,max120,max600").split(",");
const CAP = { max30: 30, max120: 120, max600: 600 };
// The sweep settings the frozen files were produced with; printed in the manifest.
const SWEEP = "--iters 800 --adaptive --pilot 70 --target-se 0.02 --workers 9 --seed 1";

// ---------- reading ----------

function parseCsvLine(line) {
  const cols = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cols.push(cur); cur = ""; }
    else cur += ch;
  }
  cols.push(cur);
  return cols;
}

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(parseCsvLine(line).map((v, i) => [header[i], v])));
}

const csvCell = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
const crLabel = (cr) => ({ 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" })[cr] ?? String(cr);

const rankings = {}; // scenario -> Map(name -> {rank, cr, elo, win})
const pairStats = {}; // scenario -> {pairs, fights}
const wins = new Map(); // name -> fights won, all scenarios
for (const scenario of SCENARIOS) {
  rankings[scenario] = new Map(readCsv(path.join(outDir, `ranking-${scenario}.csv`)).map((r) =>
    [r.name, { rank: Number(r.rank), cr: Number(r.cr), elo: Number(r.elo), win: Number(r.meanWinRate) }]));
  const pairs = readCsv(path.join(outDir, `pairs-${scenario}.csv`));
  let fights = 0;
  for (const p of pairs) {
    fights += Number(p.iters);
    wins.set(p.a, (wins.get(p.a) ?? 0) + Number(p.winsA));
    wins.set(p.b, (wins.get(p.b) ?? 0) + Number(p.winsB));
  }
  pairStats[scenario] = { pairs: pairs.length, fights };
}
const names = [...rankings[SCENARIOS[0]].keys()];
for (const scenario of SCENARIOS) {
  if (rankings[scenario].size !== names.length) throw new Error(`ranking-${scenario}.csv has ${rankings[scenario].size} creatures, expected ${names.length}`);
  const expected = names.length * (names.length - 1) / 2;
  if (pairStats[scenario].pairs !== expected) throw new Error(`pairs-${scenario}.csv has ${pairStats[scenario].pairs} pairs, expected ${expected}`);
}
// Creatures that never won a fight in any scenario have no way to deal damage. Their Elo is a floor
// value, not a measurement, so the plots leave them out and say so.
const inert = new Set(names.filter((name) => !wins.get(name)));

const meanRank = (name) => SCENARIOS.reduce((sum, s) => sum + rankings[s].get(name).rank, 0) / SCENARIOS.length;
const ordered = names.slice().sort((a, b) => meanRank(a) - meanRank(b) || a.localeCompare(b));
const crOf = (name) => rankings[SCENARIOS[0]].get(name).cr;

function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" }).trim(); } catch { return ""; }
}
const commit = git("rev-parse HEAD");
const dirty = git("status --porcelain -- src data").split("\n").filter(Boolean);
const sweepDate = (scenario) => fs.statSync(path.join(outDir, `pairs-${scenario}.csv`)).mtime.toISOString().slice(0, 10);

// ---------- statistics ----------

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

/** Quantile by linear interpolation between the sorted values. */
function quantile(values, q) {
  const v = values.slice().sort((a, b) => a - b), pos = (v.length - 1) * q, lo = Math.floor(pos);
  return v[lo] + (pos - lo) * ((v[Math.min(lo + 1, v.length - 1)]) - v[lo]);
}

function averageRanks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return ranks;
}

function spearman(xs, ys) {
  const rx = averageRanks(xs), ry = averageRanks(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / rx.length, my = ry.reduce((s, v) => s + v, 0) / ry.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/** Elo of each plotted creature against the median Elo of the creatures that share its CR. */
function crResiduals(scenario) {
  const rows = names.filter((n) => !inert.has(n)).map((name) => ({ name, ...rankings[scenario].get(name) }));
  const byCr = new Map();
  for (const r of rows) byCr.set(r.cr, [...(byCr.get(r.cr) ?? []), r.elo]);
  const medians = [...byCr].map(([cr, elos]) => ({ cr, median: median(elos), n: elos.length })).sort((a, b) => a.cr - b.cr);
  const medianOf = new Map(medians.map((m) => [m.cr, m]));
  for (const r of rows) {
    r.tier = medianOf.get(r.cr).n;
    r.residual = r.elo - medianOf.get(r.cr).median;
  }
  return { rows, medians };
}

// ---------- SVG ----------

const C = {
  surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7",
  blue: "#2a78d6", orange: "#eb6834",
};
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const textWidth = (s, size) => s.length * size * 0.56;
const f1 = (v) => v.toFixed(1);

function svgOpen(w, h, title, subtitle) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}" role="img" aria-label="${esc(title)}">`,
    `<rect width="${w}" height="${h}" fill="${C.surface}"/>`,
    `<text x="24" y="30" font-size="17" font-weight="600" fill="${C.ink}">${esc(title)}</text>`,
    `<text x="24" y="50" font-size="12" fill="${C.ink2}">${esc(subtitle)}</text>`,
  ];
}

/**
 * Places labels beside points: right, left, above, then below. A label that would cover another
 * point, a label already placed or the line tries the next position. If only the line is in the way
 * of every position, the first position that clears the rest is used, with a halo so the text stays
 * legible over the line; otherwise the label is dropped. `line` is a polyline as [[x, y], ...].
 */
function placeLabels(candidates, bounds, points, { size = 11, line = [] } = {}) {
  const placed = [], out = [];
  const hit = (box, p) => box.x0 < p.x1 && p.x0 < box.x1 && box.y0 < p.y1 && p.y0 < box.y1;
  const dots = points.map((p) => ({ x0: p.px - 4, x1: p.px + 4, y0: p.py - 4, y1: p.py + 4 }));
  const lineBoxes = [];
  // The line sampled every pixel, each sample a small box.
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let k = 0; k <= steps; k++) {
      const px = ax + ((bx - ax) * k) / steps, py = ay + ((by - ay) * k) / steps;
      lineBoxes.push({ x0: px - 2, x1: px + 2, y0: py - 2, y1: py + 2 });
    }
  }
  for (const c of candidates) {
    const w = textWidth(c.text, size);
    const spots = [
      { x: c.x + 7, y: c.y + 3.5, anchor: "start", x0: c.x + 7 },
      { x: c.x - 7, y: c.y + 3.5, anchor: "end", x0: c.x - 7 - w },
      { x: c.x, y: c.y - 8, anchor: "middle", x0: c.x - w / 2 },
      { x: c.x, y: c.y + 15, anchor: "middle", x0: c.x - w / 2 },
    ];
    const free = spots.map((spot) => {
      const box = { x0: spot.x0, x1: spot.x0 + w, y0: spot.y - size * 0.85, y1: spot.y + size * 0.25 };
      if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) return null;
      if (placed.some((p) => hit(box, p)) || dots.some((p) => hit(box, p))) return null;
      return { spot, box, onLine: lineBoxes.some((p) => hit(box, p)) };
    }).filter(Boolean);
    const pick = free.find((f) => !f.onLine) ?? free[0];
    if (!pick) continue;
    const { spot, box, onLine } = pick;
    placed.push(box);
    const halo = onLine ? ` stroke="${C.surface}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"` : "";
    out.push(`<text x="${f1(spot.x)}" y="${f1(spot.y)}" font-size="${size}" fill="${C.ink2}"${halo} text-anchor="${spot.anchor}">${esc(c.text)}</text>`);
  }
  return out;
}

// Small deterministic sideways offset, so creatures of one CR do not sit on a single pixel column.
function jitter(name) {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) / 4294967295 - 0.5) * 9;
}

function eloVsCrSvg(scenario) {
  const { rows, medians } = crResiduals(scenario);
  const W = 900, H = 540, m = { l: 62, r: 26, t: 70, b: 54 };
  const rho = spearman(rows.map((r) => r.cr), rows.map((r) => r.elo));
  const lo = Math.floor(Math.min(...rows.map((r) => r.elo)) / 500) * 500;
  const hi = Math.ceil(Math.max(...rows.map((r) => r.elo)) / 500) * 500;
  // Square-root CR axis: a third of the creatures are below CR 1 and would pile up on a linear one.
  const x = (cr) => m.l + 12 + Math.sqrt(cr / 30) * (W - m.l - m.r - 24);
  const y = (elo) => H - m.b - (elo - lo) / (hi - lo) * (H - m.t - m.b);
  const s = svgOpen(W, H, `Duel strength against Challenge Rating, ${CAP[scenario]} ft separation cap`,
    `${rows.length} creatures. Line: median Elo of each CR. Spearman rank correlation of Elo with CR: ${rho.toFixed(3)}.`);
  for (let v = lo; v <= hi; v += 500) {
    s.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${f1(y(v))}" y2="${f1(y(v))}" stroke="${C.grid}" stroke-width="1"/>`);
    s.push(`<text x="${m.l - 8}" y="${f1(y(v) + 4)}" font-size="11" fill="${C.muted}" text-anchor="end">${v}</text>`);
  }
  s.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="${C.axis}" stroke-width="1"/>`);
  for (const cr of [0, 0.125, 0.25, 0.5, 1, 2, 3, 5, 10, 15, 20, 25, 30]) {
    s.push(`<line x1="${f1(x(cr))}" x2="${f1(x(cr))}" y1="${H - m.b}" y2="${H - m.b + 4}" stroke="${C.axis}" stroke-width="1"/>`);
    s.push(`<text x="${f1(x(cr))}" y="${H - m.b + 17}" font-size="11" fill="${C.muted}" text-anchor="middle">${crLabel(cr)}</text>`);
  }
  s.push(`<text x="${(m.l + W - m.r) / 2}" y="${H - 12}" font-size="12" fill="${C.ink2}" text-anchor="middle">Challenge Rating (square-root scale)</text>`);
  s.push(`<text transform="translate(16 ${(m.t + H - m.b) / 2}) rotate(-90)" font-size="12" fill="${C.ink2}" text-anchor="middle">Elo (median CR 1 creature = 1000)</text>`);
  const pts = rows.map((r) => ({ ...r, px: x(r.cr) + jitter(r.name), py: y(r.elo) }));
  for (const p of pts) {
    s.push(`<circle cx="${f1(p.px)}" cy="${f1(p.py)}" r="3.6" fill="${C.blue}" fill-opacity="0.8" stroke="${C.surface}" stroke-width="1"><title>${esc(p.name)}: CR ${crLabel(p.cr)}, Elo ${p.elo}, rank ${p.rank}</title></circle>`);
  }
  const medianLine = medians.map((mm) => [x(mm.cr), y(mm.median)]);
  s.push(`<polyline fill="none" stroke="${C.ink2}" stroke-width="2" stroke-linejoin="round" points="${medianLine.map(([px, py]) => `${f1(px)},${f1(py)}`).join(" ")}"/>`);
  const outliers = pts.filter((p) => p.tier >= 3).sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual)).slice(0, 30);
  s.push(...placeLabels(outliers.map((p) => ({ x: p.px, y: p.py, text: p.name })), { x0: m.l, x1: W - m.r, y0: m.t, y1: H - m.b }, pts, { line: medianLine }));
  s.push("</svg>");
  return s.join("\n") + "\n";
}

function crVsRankSvg(scenario) {
  const rows = names.map((name) => ({ name, ...rankings[scenario].get(name) }));
  const crs = [...new Set(rows.map((r) => r.cr))].sort((a, b) => b - a);
  const n = names.length, rowH = 21, W = 900, m = { l: 62, r: 26, t: 70, b: 54 }, H = m.t + crs.length * rowH + m.b;
  // Rank 1 is at the right, so stronger tiers sit further right.
  const x = (rank) => m.l + (n - rank) / (n - 1) * (W - m.l - m.r);
  const yMid = (cr) => m.t + crs.indexOf(cr) * rowH + rowH / 2;
  const s = svgOpen(W, H, `Challenge Rating against duel rank, ${CAP[scenario]} ft separation cap`,
    `${rows.length} creatures, one point each. Shaded band: the middle half of each CR (interquartile range). Black mark: its median.`);
  for (const rank of [n, 300, 250, 200, 150, 100, 50, 1]) {
    s.push(`<line x1="${f1(x(rank))}" x2="${f1(x(rank))}" y1="${m.t}" y2="${H - m.b}" stroke="${C.grid}" stroke-width="1"/>`);
    s.push(`<text x="${f1(x(rank))}" y="${H - m.b + 17}" font-size="11" fill="${C.muted}" text-anchor="middle">${rank}</text>`);
  }
  s.push(`<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}" stroke="${C.axis}" stroke-width="1"/>`);
  s.push(`<text x="${(m.l + W - m.r) / 2}" y="${H - 12}" font-size="12" fill="${C.ink2}" text-anchor="middle">Rank (1 is strongest)</text>`);
  s.push(`<text transform="translate(16 ${(m.t + H - m.b) / 2}) rotate(-90)" font-size="12" fill="${C.ink2}" text-anchor="middle">Challenge Rating</text>`);
  const medianRank = new Map(), medianMarks = [];
  for (const cr of crs) {
    const ranks = rows.filter((r) => r.cr === cr).map((r) => r.rank);
    const med = median(ranks), q1 = quantile(ranks, 0.25), q3 = quantile(ranks, 0.75), y0 = yMid(cr) - 8;
    medianRank.set(cr, { med, n: ranks.length });
    s.push(`<text x="${m.l - 8}" y="${f1(yMid(cr) + 4)}" font-size="11" fill="${C.muted}" text-anchor="end">${crLabel(cr)}</text>`);
    const tip = `CR ${crLabel(cr)}: median rank ${med}, middle half ${q1} to ${q3}, ${ranks.length} creature${ranks.length === 1 ? "" : "s"}`;
    if (q3 > q1) s.push(`<rect x="${f1(x(q3))}" y="${f1(y0)}" width="${f1(x(q1) - x(q3))}" height="16" rx="3" fill="${C.blue}" fill-opacity="0.2"><title>${tip}</title></rect>`);
    medianMarks.push(`<line x1="${f1(x(med))}" x2="${f1(x(med))}" y1="${f1(y0 - 1)}" y2="${f1(y0 + 17)}" stroke="${C.ink}" stroke-width="2.5" stroke-linecap="round"><title>${tip}</title></line>`);
  }
  const pts = rows.map((r) => ({ ...r, px: x(r.rank), py: yMid(r.cr) + jitter(r.name) * 0.9, shift: r.rank - medianRank.get(r.cr).med, tier: medianRank.get(r.cr).n }));
  for (const p of pts) {
    s.push(`<circle cx="${f1(p.px)}" cy="${f1(p.py)}" r="3.4" fill="${C.blue}" stroke="${C.surface}" stroke-width="1"><title>${esc(p.name)}: CR ${crLabel(p.cr)}, rank ${p.rank}, Elo ${p.elo}</title></circle>`);
  }
  s.push(...medianMarks);
  const outliers = pts.filter((p) => p.tier >= 3).sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)).slice(0, 30);
  s.push(...placeLabels(outliers.map((p) => ({ x: p.px, y: p.py, text: p.name })), { x0: m.l, x1: W - m.r, y0: m.t, y1: H - m.b }, pts));
  s.push("</svg>");
  return s.join("\n") + "\n";
}

function overUnderSvg(scenario, count = 15) {
  const rows = crResiduals(scenario).rows.filter((r) => r.tier >= 3).sort((a, b) => b.residual - a.residual);
  const over = rows.slice(0, count), under = rows.slice(-count);
  const rowH = 21, W = 900, top = 92, gap = 44, H = top + (over.length + under.length) * rowH + gap + 24;
  const labelX = 268, zero = 580, scale = 270 / Math.max(...rows.map((r) => Math.abs(r.residual)));
  const s = svgOpen(W, H, `Furthest above and below their Challenge Rating, ${CAP[scenario]} ft separation cap`,
    "Elo minus the median Elo of the creatures with the same CR. CRs with fewer than three creatures are left out.");
  const bar = (r, i, y0, color) => {
    const yy = y0 + i * rowH, len = Math.abs(r.residual) * scale, dir = Math.sign(r.residual) || 1, end = zero + dir * len;
    const rad = Math.min(4, len);
    // Square at the zero line, rounded at the data end.
    const d = `M${zero},${yy} H${f1(end - dir * rad)} Q${f1(end)},${yy} ${f1(end)},${yy + rad} V${yy + 14 - rad} Q${f1(end)},${yy + 14} ${f1(end - dir * rad)},${yy + 14} H${zero} Z`;
    s.push(`<text x="${labelX}" y="${yy + 11}" font-size="12" fill="${C.ink}" text-anchor="end">${esc(r.name)} <tspan fill="${C.muted}">CR ${crLabel(r.cr)}</tspan></text>`);
    s.push(`<path d="${d}" fill="${color}"><title>${esc(r.name)}: Elo ${r.elo}, ${r.residual >= 0 ? "+" : ""}${Math.round(r.residual)} against the CR ${crLabel(r.cr)} median</title></path>`);
    s.push(`<text x="${f1(end + dir * 6)}" y="${yy + 11}" font-size="11" fill="${C.ink2}" text-anchor="${dir > 0 ? "start" : "end"}">${r.residual >= 0 ? "+" : "−"}${Math.abs(Math.round(r.residual))}</text>`);
  };
  const underTop = top + over.length * rowH + gap;
  s.push(`<text x="${labelX}" y="${top - 12}" font-size="12" font-weight="600" fill="${C.ink2}" text-anchor="end">Stronger than its CR</text>`);
  s.push(`<text x="${labelX}" y="${underTop - 12}" font-size="12" font-weight="600" fill="${C.ink2}" text-anchor="end">Weaker than its CR</text>`);
  s.push(`<line x1="${zero}" x2="${zero}" y1="${top - 6}" y2="${H - 20}" stroke="${C.axis}" stroke-width="1"/>`);
  over.forEach((r, i) => bar(r, i, top, C.blue));
  under.forEach((r, i) => bar(r, i, underTop, C.orange));
  s.push("</svg>");
  return s.join("\n") + "\n";
}

function rankShiftSvg(from, to) {
  const n = names.length, W = 720, H = 700, m = { l: 62, r: 26, t: 70, b: 54 };
  const x = (rank) => m.l + (rank - 1) / (n - 1) * (W - m.l - m.r);
  const y = (rank) => m.t + (rank - 1) / (n - 1) * (H - m.t - m.b);
  const s = svgOpen(W, H, `Rank with a ${CAP[from]} ft cap against rank with a ${CAP[to]} ft cap`,
    `Above the line: ranks higher with ${CAP[to]} ft of room. Below it: ranks higher when held within ${CAP[from]} ft.`);
  for (const rank of [1, 50, 100, 150, 200, 250, 300, n]) {
    s.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${f1(y(rank))}" y2="${f1(y(rank))}" stroke="${C.grid}" stroke-width="1"/>`);
    s.push(`<text x="${m.l - 8}" y="${f1(y(rank) + 4)}" font-size="11" fill="${C.muted}" text-anchor="end">${rank}</text>`);
    s.push(`<text x="${f1(x(rank))}" y="${H - m.b + 17}" font-size="11" fill="${C.muted}" text-anchor="middle">${rank}</text>`);
  }
  s.push(`<line x1="${x(1)}" y1="${y(1)}" x2="${x(n)}" y2="${y(n)}" stroke="${C.axis}" stroke-width="1.5"/>`);
  s.push(`<text x="${(m.l + W - m.r) / 2}" y="${H - 12}" font-size="12" fill="${C.ink2}" text-anchor="middle">Rank, ${CAP[from]} ft cap</text>`);
  s.push(`<text transform="translate(16 ${(m.t + H - m.b) / 2}) rotate(-90)" font-size="12" fill="${C.ink2}" text-anchor="middle">Rank, ${CAP[to]} ft cap</text>`);
  const pts = names.map((name) => {
    const a = rankings[from].get(name).rank, b = rankings[to].get(name).rank;
    return { name, a, b, px: x(a), py: y(b), shift: a - b };
  });
  for (const p of pts) {
    s.push(`<circle cx="${f1(p.px)}" cy="${f1(p.py)}" r="3.2" fill="${C.blue}" fill-opacity="0.8" stroke="${C.surface}" stroke-width="1"><title>${esc(p.name)}: rank ${p.a} (${CAP[from]} ft), rank ${p.b} (${CAP[to]} ft)</title></circle>`);
  }
  const movers = pts.slice().sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)).slice(0, 24);
  s.push(...placeLabels(movers.map((p) => ({ x: p.px, y: p.py, text: p.name })), { x0: m.l, x1: W - m.r, y0: m.t, y1: H - m.b }, pts));
  s.push("</svg>");
  return s.join("\n") + "\n";
}

// ---------- writing ----------

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(plotDir, { recursive: true });
const written = [];
function write(rel, content) {
  fs.writeFileSync(path.join(dest, rel), content);
  written.push(rel);
}
function copy(from, rel = from) {
  fs.copyFileSync(path.join(outDir, from), path.join(dest, rel));
  written.push(rel);
}

// rankings.csv: one row per creature, every scenario side by side.
{
  const header = ["name", "cr", "meanRank", ...SCENARIOS.flatMap((s) => [`${s}_rank`, `${s}_elo`, `${s}_meanWinRate`])];
  const lines = [header.join(",")];
  for (const name of ordered) {
    lines.push([csvCell(name), crOf(name), meanRank(name).toFixed(2),
      ...SCENARIOS.flatMap((s) => { const r = rankings[s].get(name); return [r.rank, r.elo.toFixed(1), r.win.toFixed(4)]; })].join(","));
  }
  write("rankings.csv", lines.join("\n") + "\n");
}

// RANKINGS.md: the same table for reading.
{
  const md = [
    "# Rankings",
    "",
    `${names.length} SRD 5.2.1 monsters, every one fought against every other (${(names.length * (names.length - 1) / 2).toLocaleString("en-US")} pairings) in ${SCENARIOS.length} scenarios.`,
    `Results of ${SCENARIOS.map(sweepDate).sort().at(-1)}, code at commit \`${commit.slice(0, 7)}\`.`,
    "",
    "- **Scenario**: both creatures start 30 feet apart. The name is the furthest apart they may get: " + SCENARIOS.map((s) => `\`${s}\` ${CAP[s]} ft`).join(", ") + ".",
    "- **Rank**: position by Elo within the scenario, 1 is strongest.",
    "- **Elo**: strength fitted to all pairings at once, scaled so the median CR 1 creature is 1000. A 400-point gap is 10 to 1 odds.",
    "- **Win**: the creature's average score over its " + (names.length - 1) + " opponents, each opponent counting equally.",
    "- Rows are ordered by the mean of the " + SCENARIOS.length + " ranks. `README.md` in this folder defines every column exactly.",
    "",
    `| # | Creature | CR | ${SCENARIOS.map((s) => `${s} rank | Elo | Win`).join(" | ")} |`,
    `|---:|---|---:|${SCENARIOS.map(() => "---:|---:|---:|").join("")}`,
  ];
  ordered.forEach((name, i) => {
    md.push(`| ${i + 1} | ${name} | ${crLabel(crOf(name))} | ${SCENARIOS.map((s) => {
      const r = rankings[s].get(name);
      return `${r.rank} | ${Math.round(r.elo)} | ${(r.win * 100).toFixed(1)}%`;
    }).join(" | ")} |`);
  });
  write("RANKINGS.md", md.join("\n") + "\n");
}

for (const scenario of SCENARIOS) {
  copy(`pairs-${scenario}.csv`);
  copy(`matrix-${scenario}.csv`);
  write(`plots/elo-vs-cr-${scenario}.svg`, eloVsCrSvg(scenario));
  write(`plots/cr-vs-rank-${scenario}.svg`, crVsRankSvg(scenario));
}
const mid = SCENARIOS.includes("max120") ? "max120" : SCENARIOS[0];
write("plots/over-under-cr.svg", overUnderSvg(mid));
if (SCENARIOS.length > 1) write("plots/rank-shift.svg", rankShiftSvg(SCENARIOS[0], SCENARIOS.at(-1)));
copy("statblocks.json");
copy("coverage.md");

write("README.md", `# Results

A frozen copy of one full run of the simulator. Everything here can be analyzed without running any code.
\`MANIFEST.md\` records the commit, the commands and a checksum for each file.

| File | Contents |
|---|---|
| \`RANKINGS.md\` | Every creature's rank, Elo and win rate in each scenario, in one table |
| \`rankings.csv\` | The same table as data |
| \`pairs-<scenario>.csv\` | The raw result of every pairing |
| \`matrix-<scenario>.csv\` | The score of every creature against every other, as a square table |
| \`statblocks.json\` | The stat blocks as the simulator compiled them: what each creature actually fought with |
| \`coverage.md\` | What the compiler modelled and what it skipped, with reasons |
| \`plots/\` | Charts drawn from \`rankings.csv\` |

## Scenarios

A fight is one creature against one other on open, flat ground, starting 30 feet apart. The scenario sets how far
apart they may get: ${SCENARIOS.map((s) => `\`${s}\` is ${CAP[s]} feet`).join(", ")}. A fight that reaches 100 rounds
is a draw.

## Columns

**\`pairs-<scenario>.csv\`**: one row per unordered pair.

| Column | Meaning |
|---|---|
| \`a\`, \`b\` | The two creatures |
| \`iters\` | Fights run for this pair. Lopsided pairs stop early, so this varies from 70 to 800 |
| \`winsA\`, \`winsB\`, \`draws\` | Outcomes; they sum to \`iters\` |
| \`avgRounds\` | Mean length of a fight in rounds |
| \`avgWinnerHpPct\` | Mean share of its hit points the winner had left, over the decided fights |
| \`drawHpA\`, \`drawHpB\` | Mean share of hit points each side had left, over the drawn fights |

**Score.** A win is 1 and a loss is 0. A draw is split by hit points left: \`a\` takes
\`0.5 + (drawHpA - drawHpB) / 2\` and \`b\` takes the rest, so an even draw is half each. A pair's score for \`a\` is
\`(winsA + draws * that share) / iters\`.

**\`matrix-<scenario>.csv\`**: the cell in row R, column C is R's score against C. The diagonal is 0.5.

**\`rankings.csv\`**

| Column | Meaning |
|---|---|
| \`name\`, \`cr\` | The creature and its Challenge Rating (0.125 is CR 1/8) |
| \`meanRank\` | Mean of its ranks across the scenarios; the file is sorted by it |
| \`<scenario>_rank\` | Position by Elo in that scenario, 1 is strongest |
| \`<scenario>_elo\` | Bradley-Terry strength fitted to every pair's score, each pair weighted equally, on the Elo scale (400 points is 10 to 1 odds) with the median CR 1 creature at 1000 |
| \`<scenario>_meanWinRate\` | Mean of the creature's score over all its opponents |

${inert.size ? `${[...inert].sort().join(" and ")} never won a fight: ${inert.size === 1 ? "it has" : "they have"} no way to deal damage. ${inert.size === 1 ? "Its" : "Their"} Elo is a floor value, and the plots leave ${inert.size === 1 ? "it" : "them"} out.\n\n` : ""}## Plots

- \`plots/elo-vs-cr-<scenario>.svg\`: Elo against Challenge Rating, with the median Elo of each CR as a line.
- \`plots/cr-vs-rank-<scenario>.svg\`: the same comparison turned on its side. One row per Challenge Rating, every creature at its rank, a shaded band over the middle half of the row (its interquartile range) and a black mark at its median.
- \`plots/over-under-cr.svg\`: the creatures furthest above and below the median Elo of their own CR.
- \`plots/rank-shift.svg\`: each creature's rank in the tightest scenario against its rank in the widest.

Opened on their own, the SVG files show a creature's name and numbers when the pointer rests on a point.

## Reproducing

\`node tools/make-results.mjs\` rebuilds this folder from the sweep outputs in \`out/\`. \`MANIFEST.md\` has the sweep commands.
`);

// MANIFEST.md last, so it can checksum everything else.
{
  const rowsOf = (rel) => (rel.endsWith(".csv") ? String(fs.readFileSync(path.join(dest, rel), "utf8").trim().split("\n").length - 1) : "");
  const md = [
    "# Manifest",
    "",
    `- Commit: \`${commit}\`${dirty.length ? ` plus uncommitted changes under src/ or data/: ${dirty.map((d) => `\`${d.trim()}\``).join(", ")}` : ""}`,
    `- Node: ${process.version}`,
    `- Creatures: ${names.length}; pairings per scenario: ${(names.length * (names.length - 1) / 2).toLocaleString("en-US")}`,
    "",
    "## Sweeps",
    "",
    "| Scenario | Separation cap | Run on | Fights |",
    "|---|---:|---|---:|",
    ...SCENARIOS.map((s) => `| ${s} | ${CAP[s]} ft | ${sweepDate(s)} | ${pairStats[s].fights.toLocaleString("en-US")} |`),
    "",
    "```",
    "npm run compile",
    ...SCENARIOS.flatMap((s) => [`node src/cli.ts run --scenario ${s} ${SWEEP}`, `node src/cli.ts rank --scenario ${s}`]),
    "node tools/make-results.mjs",
    "```",
    "",
    "## Files",
    "",
    "| File | Bytes | Rows | SHA-256 |",
    "|---|---:|---:|---|",
    ...written.slice().sort().map((rel) => {
      const buf = fs.readFileSync(path.join(dest, rel));
      return `| \`${rel}\` | ${buf.length.toLocaleString("en-US")} | ${rowsOf(rel)} | \`${crypto.createHash("sha256").update(buf).digest("hex")}\` |`;
    }),
  ];
  fs.writeFileSync(path.join(dest, "MANIFEST.md"), md.join("\n") + "\n");
}

console.log(`Wrote ${written.length + 1} files to results/ (${SCENARIOS.join(", ")}); ${inert.size} creature(s) left out of the plots: ${[...inert].join(", ") || "none"}`);
