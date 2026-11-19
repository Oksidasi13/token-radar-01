// Token Radar's entry program (Node 22, standard library only).
//
// It reads the sealed snapshot at /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the radar-2 model in lib/model.ts, writes the ranked board to
// /output/board.json, and copies this repository's dashboard/ and screenshots/ into /output.
// Last, it writes /output/dossier.json, the summary the judge reads, with the vendored
// make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js read /output/data.js, which this program writes
// from the same board. It covers the watchlist, states the model and gives every protocol a
// farm plan. Change the model, the page or the plan; keep the gate's shape.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadarSet, readSnapshot, renderDataScript, validateBoard } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const DOSSIER_TEXT_LIMIT = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const SHOT_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DASHBOARD_LIMITS = { max_files: 400, max_bytes: 4_194_304 };

/** The value of a --name <value> flag, or `fallback` when the flag is absent. */
function flagValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** The snapshot file to read: a --input file as given, or snapshot.json under a --input directory. */
function resolveSnapshotPath(): string {
  const inputOption = flagValue('input', '/input');
  return inputOption.endsWith('.json') ? inputOption : join(inputOption, 'snapshot.json');
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function mirrorDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/** The screenshots are the gate's row: three or four whole images with dossier-safe names. */
function checkShots(names: string[]): string | null {
  if (names.length < 3) {
    const plural = names.length === 1 ? '' : 's';
    return `token radar: screenshots/ holds ${names.length} image${plural}: hand in 3, the board, a detail view and a filtered view`;
  }
  for (const name of names) {
    if (!SHOT_NAME_PATTERN.test(name)) {
      return `token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`;
    }
  }
  return null;
}

const snapshotPath = resolveSnapshotPath();
if (!existsSync(snapshotPath)) {
  process.stderr.write(`token radar: no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snap = readSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadarSet(snap);
const problem = validateBoard(board, snap);
if (problem !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${problem}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), renderDataScript(radar));

mirrorDir(join(rootDir, 'dashboard'), join(outDir, 'dashboard'));
const shotNames = mirrorDir(join(rootDir, 'screenshots'), join(outDir, 'screenshots'));
const shotProblem = checkShots(shotNames);
if (shotProblem !== null) {
  process.stderr.write(`${shotProblem}\n`);
  process.exit(1);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_LIMIT, screenshots: SHOT_LIMITS, dashboard: DASHBOARD_LIMITS }),
);

process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${shotNames.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
