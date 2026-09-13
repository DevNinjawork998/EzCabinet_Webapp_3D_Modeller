import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/**
 * Draws the one grain texture the whole app uses, to `public/grain.png`.
 *
 * CLAUDE.md's rule: *one* grayscale grain tinted per finish via the material
 * colour, never a PBR set per finish. So this is a single seamless greyscale
 * tile. Every door, carcass, shelf and worktop, and every swatch on the landing
 * page, is that same file multiplied by a different colour.
 *
 * The pattern is the classic procedural wood — Perlin, "An Image Synthesizer",
 * 1985: perturb a coordinate with summed noise octaves, then wrap it.
 *
 *     grain = fract(frequency * across + turbulence(x, y))
 *
 * Concentric rings are end-grain, which is not what a cabinet door is. A door
 * is sawn veneer, so this uses the straight-grain form: bands run *along* the
 * board and vary *across* it, with the noise stretched along the grain so the
 * figure reads as long streaks rather than blobs.
 *
 * Deterministic — fixed seed, so the committed PNG and a regenerated one are
 * byte-identical and a rerun never shows up as a diff.
 *
 * Run with `pnpm generate:grain`.
 */

const SIZE = 512;

/** How many grain lines across the tile. Integer, so the pattern wraps. */
const BANDS = 9;

/** How hard the noise bends those lines. Too much reads as marble, not oak. */
const WARP = 1.15;

/**
 * How wide the dark latewood line is, as a fraction of the gap between lines.
 * This is the number that decides whether the tile reads as wood or as a
 * curtain: real grain is a *narrow* dark line on a wide pale field, not a
 * smooth ramp between the two.
 */
const LINE_WIDTH = 0.11;

/** How dark the lines and the fibre go, below white. */
const LINE_DEPTH = 0.62;
const FIBRE_DEPTH = 0.3;
const TONE_DEPTH = 0.18;

/**
 * Everything is multiplied onto a finish colour, so the tile tops out at white
 * and only ever darkens — a pale finish keeps its colour where the grain is
 * open and picks up the figure where it is not.
 */
const DARKEST = 0.72;

/** The noise lattice wraps at this many cells, which is what makes it tile. */
const PERIOD = 8;

const SEED = 20260822;

// ------------------------------------------------------------------ noise --

/** Deterministic hash of a lattice point. No dependency, no Math.random. */
function hash(ix, iy) {
	let h = SEED + ix * 374761393 + iy * 668265263;
	h = (h ^ (h >>> 13)) * 1274126177;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smoothstep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Value noise on a torus: the lattice indices wrap at `period`, so the left
 * edge of the tile interpolates against the same values as the right edge and
 * `RepeatWrapping` shows no seam.
 */
function noise2d(x, y, period) {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = smoothstep(x - x0);
	const fy = smoothstep(y - y0);

	const wrap = (v) => ((v % period) + period) % period;
	const xa = wrap(x0);
	const xb = wrap(x0 + 1);
	const ya = wrap(y0);
	const yb = wrap(y0 + 1);

	return lerp(
		lerp(hash(xa, ya), hash(xb, ya), fx),
		lerp(hash(xa, yb), hash(xb, yb), fx),
		fy,
	);
}

/**
 * Turbulence: octaves of noise at doubling frequency and halving amplitude.
 * `stretch` squashes the vertical frequency so features elongate along the
 * grain — the difference between wood and cloud.
 */
function fbm(x, y, octaves, period, stretch) {
	let value = 0;
	let amplitude = 1;
	let total = 0;
	let freq = 1;

	for (let i = 0; i < octaves; i++) {
		value += amplitude * noise2d(x * freq, y * freq * stretch, period * freq);
		total += amplitude;
		amplitude *= 0.5;
		freq *= 2;
	}
	return value / total;
}

// ------------------------------------------------------------------- wood --

/**
 * One pixel of grain, in 0..1.
 *
 * `u` runs across the board (bands vary along it), `v` runs along it. Both are
 * scaled to the lattice period rather than to pixels, which is what keeps the
 * tile seamless at any size.
 */
function grain(u, v) {
	const across = u * PERIOD;
	const along = v * PERIOD;

	// Where the grain lines wander to. Two scales: a broad sweep that gives the
	// board its figure, and a tighter one that stops the lines running parallel.
	const warp =
		fbm(across, along, 4, PERIOD, 0.12) -
		0.5 +
		(fbm(across * 3, along * 3, 2, PERIOD * 3, 0.08) - 0.5) * 0.35;

	const band = u * BANDS + warp * WARP;

	// Distance to the nearest line, in band units, wrapped — so the line is a
	// narrow trough rather than the edge of a ramp.
	const t = band - Math.floor(band);
	const distance = Math.min(t, 1 - t) / LINE_WIDTH;
	const line = Math.exp(-distance * distance);

	// Fibre: high frequency, stretched hard along the grain, so it reads as the
	// hairline pores in the surface rather than as noise.
	const fibre = fbm(across * 9, along * 9, 3, PERIOD * 9, 0.035) - 0.5;

	// A slow tonal drift across the board, the way a real sheet is never one
	// even colour.
	const tone = fbm(across * 0.5, along * 0.5, 2, PERIOD, 0.5) - 0.5;

	const darkness =
		line * LINE_DEPTH + (0.5 - fibre) * FIBRE_DEPTH + (0.5 - tone) * TONE_DEPTH;

	return Math.max(0, Math.min(1, darkness));
}

// -------------------------------------------------------------------- png --

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/**
 * A greyscale PNG by hand. `node:zlib` does the only hard part, which is why
 * this needs no image dependency — `pngjs` was removed from the project on
 * purpose and this is not worth bringing it back for.
 */
function greyscalePng(pixels, size) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // colour type: greyscale
	// 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace.

	// One filter byte per scanline. Filter 1 (Sub) predicts each byte from its
	// left neighbour, which on a horizontally smooth image like this deflates
	// far better than storing the raw values.
	const raw = Buffer.alloc(size * (size + 1));
	for (let y = 0; y < size; y++) {
		const row = y * (size + 1);
		raw[row] = 1;
		for (let x = 0; x < size; x++) {
			const here = pixels[y * size + x];
			const left = x === 0 ? 0 : pixels[y * size + x - 1];
			raw[row + 1 + x] = (here - left) & 0xff;
		}
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ------------------------------------------------------------------ floor --

/**
 * The room's SPC floor, as one seamless greyscale tile tinted by the material
 * colour in `Room.tsx`.
 *
 * The floor is room context, not a board EzCabinet sells, so a generated
 * woodgrain is fine here in a way it is not on a front — see `grain.ts`.
 *
 * Laid to a common Malaysian SPC spec: 1220 × 180mm click-lock planks, staggered
 * end joints, a micro-bevel on every edge. The tile is two plank lengths by six
 * plank widths — 2440 × 1080mm — so neighbouring tiles do not repeat the same
 * board end to end. `FLOOR_TILE_MM` in `Room.tsx` must match.
 */
const PLANK_ROWS = 6;
const PLANKS_PER_ROW = 2;

/**
 * Where each row's end joint falls, in plank lengths. Hand-picked so no two
 * neighbouring rows — including the last against the first, across the tile
 * seam — have joints closer than 0.3 of a plank (~370mm); fitters keep at least
 * 200mm between them.
 */
const JOINTS = [0, 0.55, 0.25, 0.8, 0.4, 0.7];

/** The bevel's dark line, in pixels, and how dark it goes. */
const BEVEL_PX = 1.1;
const BEVEL_DEPTH = 0.3;

/** How far one board's tone may sit from the next. */
const PLANK_TONE = 0.08;

/** Grain streaks inside a board: faint, because SPC is a printed decor. */
const STREAK_DEPTH = 0.12;
const PLANK_FIBRE_DEPTH = 0.08;

/** Noise that never needs to wrap: grain is computed per board. */
const UNWRAPPED = 1 << 20;

function floor(u, v) {
	const rowF = v * PLANK_ROWS;
	const row = Math.floor(rowF);
	const t = rowF - row;

	const along = u * PLANKS_PER_ROW - JOINTS[row];
	const wrapped = ((along % PLANKS_PER_ROW) + PLANKS_PER_ROW) % PLANKS_PER_ROW;
	const plank = Math.floor(wrapped);
	const s = wrapped - plank;

	// Each board is its own piece: its own tone, its own grain.
	const id = row * PLANKS_PER_ROW + plank;
	const tone = hash(id, 7) * PLANK_TONE;
	const ox = hash(id, 11) * 1000;
	const oy = hash(id, 13) * 1000;

	// Streaks run along the board: fast across it, slow along it.
	const warp = fbm(t * 4 + ox, s * 6 + oy, 3, UNWRAPPED, 0.25) - 0.5;
	const band = t * 7 + warp * 1.4;
	const bt = band - Math.floor(band);
	const line = Math.exp(-((Math.min(bt, 1 - bt) / 0.14) ** 2));
	const fibre = fbm(t * 40 + ox, s * 60 + oy, 2, UNWRAPPED, 0.05) - 0.5;

	// Distance to the nearest board edge, in pixels, for the bevel.
	const rowPx = SIZE / PLANK_ROWS;
	const plankPx = SIZE / PLANKS_PER_ROW;
	const edgePx = Math.min(
		Math.min(t, 1 - t) * rowPx,
		Math.min(s, 1 - s) * plankPx,
	);
	const bevel = Math.exp(-((edgePx / BEVEL_PX) ** 2));

	const darkness =
		tone +
		line * STREAK_DEPTH +
		(0.5 - fibre) * PLANK_FIBRE_DEPTH +
		bevel * BEVEL_DEPTH;
	return Math.max(0, Math.min(1, darkness));
}

// ------------------------------------------------------------------- main --

function writeTile(name, shade) {
	const pixels = new Uint8Array(SIZE * SIZE);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			const value = shade(x, y);
			pixels[y * SIZE + x] = Math.max(
				0,
				Math.min(255, Math.round(value * 255)),
			);
		}
	}

	const png = greyscalePng(pixels, SIZE);
	writeFileSync(new URL(`../public/${name}`, import.meta.url), png);

	let min = 255;
	let max = 0;
	for (const v of pixels) {
		if (v < min) min = v;
		if (v > max) max = v;
	}
	console.log(
		`${name} — ${SIZE}x${SIZE} greyscale, ${(png.length / 1024).toFixed(1)} KB, values ${min}-${max}`,
	);
}

writeTile("grain.png", (x, y) => 1 - grain(x / SIZE, y / SIZE) * (1 - DARKEST));
// Sampled at pixel centres, so a bevel on the tile edge lands on both sides.
writeTile("floor.png", (x, y) => 1 - floor((x + 0.5) / SIZE, (y + 0.5) / SIZE));
