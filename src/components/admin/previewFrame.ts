/**
 * Where the admin preview's camera sits for one cabinet.
 *
 * A `MeshGroup`'s frame is already x centred on the width, z centred on the
 * depth and y up from the underside (see `renderMesh.ts`), so nothing needs
 * centring — only the camera has to back off far enough to see the whole
 * thing. The direction is the three-quarter view the old viewer used.
 */
export type PreviewFrame = {
	/** Orbit target, metres: the cabinet's mid-height on the origin. */
	target: [number, number, number];
	/** Camera position, metres: in front of (+z), above and to the right. */
	camera: [number, number, number];
};

const DIRECTION = (() => {
	const v: [number, number, number] = [2.8, 2, 3.4];
	const length = Math.hypot(...v);
	return v.map((n) => n / length) as [number, number, number];
})();

/** Camera distance per metre of the cabinet's largest dimension. Fits a 40°
 * field of view with a margin. */
const DISTANCE_PER_M = 2.2;

/** `sizeMm` is `RenderMesh.sizeMm`: `[width, depth, height]`. */
export function previewFrame(sizeMm: [number, number, number]): PreviewFrame {
	const [, , heightMm] = sizeMm;
	const target: [number, number, number] = [0, heightMm / 2000, 0];
	const distance = (Math.max(...sizeMm) / 1000) * DISTANCE_PER_M;
	return {
		target,
		camera: [
			target[0] + DIRECTION[0] * distance,
			target[1] + DIRECTION[1] * distance,
			target[2] + DIRECTION[2] * distance,
		],
	};
}
