import type { MeshPart, Vec3 } from "./objRead";

/**
 * Turns whatever the exporter wrote into canonical millimetres, ordered
 * `[along the wall, depth, height]`.
 *
 * OBJ carries no units and no up-axis. Blender writes metres Y-up, SketchUp's
 * own exporter writes inches Z-up, and a drafter can override both. Assuming
 * one of them — which the first version of this did — means a file from any
 * other setup reads as a room-sized cabinet or none at all.
 *
 * Both are inferred from the geometry instead, using facts that hold for every
 * cabinet job regardless of who drew it.
 */

export type Normalised = {
	parts: MeshPart[];
	/** What raw coordinates were multiplied by to reach millimetres. */
	scaleFactor: number;
	/** Which raw axis turned out to be up: 0 = x, 1 = y, 2 = z. */
	upAxis: 0 | 1 | 2;
	/**
	 * Which raw axis ends up in each normalised slot: `[along the wall, depth,
	 * height]`. Returned so a second pass over the same file can put vertices
	 * through the identical permutation — `renderMesh.ts` reads the faces this
	 * one skips, and the two must agree about which way is up or the mesh
	 * arrives lying on its side.
	 */
	order: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
	/** The board thickness the scale was chosen to make sense of. */
	panelThicknessMm: number;
	notes: string[];
};

/** mm, cm, inch, metre. The only units anyone actually draws cabinets in. */
const CANDIDATE_SCALES = [1, 10, 25.4, 1000];

/** Sheet goods. 15, 16 and 18mm are the common boards; the range is generous. */
const BOARD_MIN_MM = 12;
const BOARD_MAX_MM = 25;

const smallest = (part: MeshPart) =>
	Math.min(...part.sizeMm.filter((d) => d > 0));

const largest = (part: MeshPart) => Math.max(...part.sizeMm);

/**
 * A part flat enough for its thin axis to say something about which way is up.
 *
 * Sheet goods are extreme: a 767mm shelf on 16mm board is a ratio of 0.02. A
 * leg leveller is 57 × 57 × 100, a ratio of 0.57 — it is not thin in any
 * meaningful direction, and letting it vote is what tipped the client's base
 * cabinet onto its side once panels were read as solid boxes. Four legs
 * outvoted three horizontal boards.
 */
const PLATE_RATIO = 0.25;

const isPlate = (part: MeshPart) => {
	const big = largest(part);
	return big > 0 && smallest(part) / big <= PLATE_RATIO;
};

/**
 * The modal smallest-dimension across every part, in the units it would have
 * at this scale. That number is the board thickness, and board thickness is a
 * physical constant of the trade — which is what makes it a better detector
 * than the model's overall size. A single tall unit and a ten-metre kitchen
 * run differ by 4x; their board does not.
 */
function modalThickness(parts: MeshPart[], scale: number): number {
	const tally = new Map<number, number>();
	for (const part of parts) {
		const thin = smallest(part);
		if (!Number.isFinite(thin) || thin <= 0) continue;
		const mm = Math.round(thin * scale);
		tally.set(mm, (tally.get(mm) ?? 0) + 1);
	}
	let best = 0;
	let bestCount = 0;
	for (const [mm, count] of tally) {
		if (count > bestCount) {
			best = mm;
			bestCount = count;
		}
	}
	return best;
}

export function inferScale(parts: MeshPart[]): {
	scaleFactor: number;
	panelThicknessMm: number;
	confident: boolean;
} {
	for (const scale of CANDIDATE_SCALES) {
		const thickness = modalThickness(parts, scale);
		if (thickness >= BOARD_MIN_MM && thickness <= BOARD_MAX_MM) {
			return {
				scaleFactor: scale,
				panelThicknessMm: thickness,
				confident: true,
			};
		}
	}

	// Nothing landed on a plausible board. Fall back to millimetres and say so
	// rather than silently picking one — a wrong scale makes every dimension
	// and therefore every price wrong, so it has to reach the reviewer.
	return {
		scaleFactor: 1,
		panelThicknessMm: modalThickness(parts, 1),
		confident: false,
	};
}

const spanOf = (parts: MeshPart[], axis: 0 | 1 | 2) =>
	Math.max(...parts.map((p) => p.minMm[axis] + p.sizeMm[axis])) -
	Math.min(...parts.map((p) => p.minMm[axis]));

/** No kitchen is taller than this. A run can easily be wider. */
const CEILING_MM = 3000;

/**
 * Two extents within this fraction of each other are the same extent.
 *
 * A corner unit's footprint is drawn square on purpose — 900 by 900 — so the
 * two are equal to the drafter's precision. Tight enough that a BC 600 (600
 * wide, 588 deep) still reads as two different sizes.
 */
const SAME_EXTENT = 0.005;

const sameExtent = (a: number, b: number) =>
	Math.abs(a - b) <= Math.max(a, b) * SAME_EXTENT;

/**
 * Which axis points at the ceiling, in two steps that have to happen in this
 * order.
 *
 * **Depth first — usually.** This product plans one wall, so depth is normally
 * the model's smallest extent — a 600mm carcass against a 3.8m run 2.4m tall.
 * Even a lone tall cabinet is deeper-than-nothing but narrower in depth than in
 * width or height.
 *
 * **Except a square footprint.** A corner unit is drawn square on purpose and
 * is often no taller than it is deep, so its smallest extent is its *height*,
 * not its depth — "depth first" would lay it on its back. But a square-*fronted*
 * wall unit (width tied with height, both bigger than depth) ties the same two
 * extents without being a corner at all, and "depth first" is exactly right for
 * it. The two cases are told apart by the same evidence the plate vote below
 * already gathers: a corner's horizontal boards — bottoms, tops, the adjustable
 * shelf — are thin along its short *height* axis, so that axis only wins the
 * plate vote when it genuinely is the up axis. When the smallest axis does not
 * win that vote outright, the tie is a coincidence of the model's proportions
 * — an ordinary square-fronted cabinet — *or* a genuinely ambiguous corner
 * whose named boards do not settle it either way, and there is no way from
 * extents and votes alone to tell those two apart. Depth-first proceeds, but
 * `confident` comes back `false` whenever the footprint was tied and the vote
 * did not win it outright, so the caller is warned rather than shown a
 * guess dressed up as a reading.
 *
 * **Then vote between the two that are left.** The up axis is the one most
 * panels are thin on: shelves, tops and bottoms are horizontal and outnumber
 * the sides. Doing this vote across all three axes — which an earlier version
 * did — gets the wrong answer on a real file, because doors and backs are thin
 * on *depth* and together outvote the shelves. Taking depth out of the running
 * first leaves only sides against horizontals, and horizontals always win.
 */
export function inferUpAxis(
	parts: MeshPart[],
	/** What raw coordinates have to be multiplied by to reach millimetres.
	 * Only the ceiling corroboration needs it, and it needs it badly: without
	 * it a file drawn in metres compares 3.848 against 3000 and clears a
	 * ceiling it is a metre too tall for, so the one check that would have
	 * flagged a run standing on its end silently passed. */
	scaleFactor = 1,
): {
	upAxis: 0 | 1 | 2;
	depthAxis: 0 | 1 | 2;
	confident: boolean;
} {
	const axes = [0, 1, 2] as const;
	const spans = axes.map((axis) => spanOf(parts, axis));
	const [low, mid, high] = [...axes].sort((a, b) => spans[a] - spans[b]);

	// Panels only. Hardware is not a board and has no grain direction to read.
	// Gathered before depth is decided, because telling a corner unit from an
	// ordinary square-fronted cabinet needs this same evidence.
	const plates = parts.filter(isPlate);
	const voters = plates.length > 0 ? plates : parts;

	const thinAxisVotes = [0, 0, 0];
	for (const part of voters) {
		const thin = smallest(part);
		if (!Number.isFinite(thin)) continue;
		const axis = part.sizeMm.indexOf(thin);
		if (axis >= 0) thinAxisVotes[axis] += 1;
	}

	// A corner unit: its footprint is square and it is no taller than it is
	// deep, so the smallest extent could be its *height* — but a square-fronted
	// wall unit ties the same two extents without being a corner. Only trust
	// the corner reading when the smallest axis strictly wins the plate vote:
	// a corner's bottom, top and adjustable shelf are thin along it, and
	// nothing else is, so the vote is lopsided when it really is up.
	const footprintTie =
		sameExtent(spans[mid], spans[high]) && !sameExtent(spans[low], spans[mid]);

	if (
		footprintTie &&
		thinAxisVotes[low] > thinAxisVotes[mid] &&
		thinAxisVotes[low] > thinAxisVotes[high]
	) {
		const second = Math.max(thinAxisVotes[mid], thinAxisVotes[high]);
		return {
			upAxis: low,
			// Of the two equal floor axes, the later one is depth: every exporter
			// seen so far runs along the wall on x, and taking x for depth would
			// turn the axis permutation into a mirror image.
			depthAxis: Math.max(mid, high) as 0 | 1 | 2,
			confident:
				spans[low] * scaleFactor <= CEILING_MM &&
				thinAxisVotes[low] >= Math.max(1, second * 1.5),
		};
	}

	// Width and depth tied (a square wall corner): same rule, later axis is depth.
	const depthAxis = (
		sameExtent(spans[low], spans[mid]) ? Math.max(low, mid) : low
	) as 0 | 1 | 2;

	const candidates = axes.filter((axis) => axis !== depthAxis);
	const [a, b] = candidates;
	const upAxis = thinAxisVotes[a] >= thinAxisVotes[b] ? a : b;
	const other = upAxis === a ? b : a;

	// Two corroborations, both of which have to hold before we stop asking the
	// reviewer to check: the vote was not a near-tie, and the height we picked
	// fits under a ceiling.
	const decisiveVote =
		thinAxisVotes[upAxis] >= Math.max(1, thinAxisVotes[other] * 1.5);
	const fitsARoom = spans[upAxis] * scaleFactor <= CEILING_MM;

	// A tied footprint that the plate vote could not confidently hand to the
	// corner reading above is not confidently anything else either: this
	// depth-first reading might be right (an ordinary square-fronted cabinet)
	// or might be a corner read lying on its back with too few named boards to
	// tell. Flag it instead of asserting either silently — the vote margin
	// below would otherwise happily call a 3-votes-to-2 split "decisive" on a
	// tie it was never entitled to settle.
	return {
		upAxis,
		depthAxis,
		confident: footprintTie ? false : decisiveVote && fitsARoom,
	};
}

export function normalise(parts: MeshPart[]): Normalised {
	const notes: string[] = [];
	if (parts.length === 0) {
		return {
			parts,
			scaleFactor: 1,
			upAxis: 2,
			order: [0, 1, 2],
			panelThicknessMm: 0,
			notes: ["No geometry found in the .obj."],
		};
	}

	const {
		scaleFactor,
		panelThicknessMm,
		confident: scaleOk,
	} = inferScale(parts);
	const {
		upAxis,
		depthAxis,
		confident: axisOk,
	} = inferUpAxis(parts, scaleFactor);

	if (!scaleOk) {
		notes.push(
			`Could not tell what units this file uses — no candidate scale put the board in ${BOARD_MIN_MM}-${BOARD_MAX_MM}mm. Assuming millimetres; check the sizes below.`,
		);
	}
	if (!axisOk) {
		notes.push(
			"Could not confidently tell which axis is up. Check that heights and depths below are not swapped.",
		);
	}

	const wallAxis = ([0, 1, 2] as const).find(
		(axis) => axis !== upAxis && axis !== depthAxis,
	) as 0 | 1 | 2;

	const order = [wallAxis, depthAxis, upAxis] as const;
	const round = (v: number) => Math.round(v * scaleFactor * 10) / 10;
	const permute = (v: Vec3): Vec3 => [
		round(v[order[0]]),
		round(v[order[1]]),
		round(v[order[2]]),
	];

	return {
		parts: parts.map((part) => ({
			name: part.name,
			minMm: permute(part.minMm),
			sizeMm: permute(part.sizeMm),
		})),
		scaleFactor,
		upAxis,
		order,
		panelThicknessMm,
		notes,
	};
}
