import { useFrame } from "@react-three/fiber";
import type { ReactNode } from "react";
import { useRef } from "react";
import type { Group } from "three";
import { MathUtils } from "three";
import type { HingeSide } from "@/lib/planner/layout";
import type { SwingSpec } from "@/lib/planner/swing";
import { markShadowsDirty } from "./lightingRig";

/**
 * A door leaf that swings on its stile.
 *
 * Shared by both render paths — `Cabinet.tsx` draws procedural leaves and
 * `DesignedCabinet.tsx` draws the drafted mesh, and `Cabinet.tsx` already
 * imports from `DesignedCabinet.tsx`, so this cannot live in either without a
 * cycle.
 *
 * This component decides nothing about geometry. Where the axis sits, how far
 * the leaf opens, and whether it should open at all are worked out by `swingOf`
 * in `lib/planner/swing.ts` from the leaf's own box and the carcass it hangs
 * on — so they are checkable by reading arithmetic rather than pixels. What is
 * left here is the easing.
 *
 * Children stay in the cabinet's own frame: the outer group pivots at the
 * hinge, the inner one undoes that offset. So a caller passes the same
 * absolutely-positioned mesh it drew before and nothing about its coordinates
 * changes.
 *
 * The angle is damped rather than sprung. One eased number does not justify
 * `@react-spring/three` as a dependency, and `MathUtils.damp` is framerate
 * independent — which matters on the mid-range Android this is built for, where
 * a fixed per-frame lerp would swing visibly slower than on a desktop.
 */

/** Close enough to stop writing to the transform. */
const SETTLED_RAD = 0.001;

/** Which stile each leaf hangs on. A lone leaf takes the customer's choice; a
 * pair always hinges outward from the middle, so their handles meet — which is
 * both how a pair is really hung and where the handles already sat. */
export const hingeOf = (
	index: number,
	leaves: number,
	chosen: HingeSide,
): HingeSide => (leaves === 1 ? chosen : index === 0 ? "left" : "right");

export function Hinge({
	spec,
	open,
	children,
}: {
	/**
	 * Where this leaf turns and how far, derived from its own geometry.
	 *
	 * The axis being a *derived* value rather than a constant is the whole
	 * point: the pivot used to sit at the carcass's depth centre, ~290mm behind
	 * a leaf that lives at the front face, so the leaf orbited instead of
	 * swinging and its hinge edge travelled 438mm. `swingOf` reads the depths
	 * off the design, which is what makes an uploaded carcass with its doors
	 * somewhere else still hinge correctly.
	 */
	spec: SwingSpec;
	open: boolean;
	children: ReactNode;
}) {
	const pivot = useRef<Group>(null);

	const x = spec.pivotXMm / 1000;
	const z = spec.pivotZMm / 1000;

	// Sideways, away from the stile it hangs on, as it opens.
	//
	// Two leaves hinged on a shared stile sit a reveal apart while each one's
	// own thickness projects toward the other, so their bodies merge by the
	// same amount at every angle — the overlap is set by the hinge spacing, not
	// the swing. `swingOf` measures how far to move off the two boxes; the sign
	// is the only part that belongs here, because it depends on which way the
	// leaf turns. Scaled by the sine so it is exactly zero when shut and the
	// closed run is untouched.
	const clear = ((spec.side === "left" ? 1 : -1) * spec.clearMm) / 1000;

	// Hinged left, the leaf extends toward +x, and a *negative* rotation about y
	// is what brings its free edge forward to the customer. Hinged right it
	// extends toward -x and the sign flips with it.
	//
	// A leaf shaped like a lift-up flap stays shut: swinging it about a vertical
	// stile would send it sideways through the neighbouring cabinet, and drawing
	// it closed is the honest failure. `/admin/cabinet-designs` reports it.
	const target =
		open && !spec.suspectFlap
			? spec.maxRad * (spec.side === "left" ? -1 : 1)
			: 0;

	useFrame((_, delta) => {
		const group = pivot.current;
		if (!group) return;
		const current = group.rotation.y;
		if (Math.abs(current - target) < SETTLED_RAD) {
			// Land exactly on the target once rather than easing at it forever.
			if (current !== target) {
				group.rotation.y = target;
				group.position.x = x + clear * Math.abs(Math.sin(target));
				markShadowsDirty();
			}
			return;
		}
		group.rotation.y = MathUtils.damp(current, target, 8, delta);
		group.position.x = x + clear * Math.abs(Math.sin(group.rotation.y));
		markShadowsDirty();
	});

	return (
		<group ref={pivot} position={[x, 0, z]}>
			<group position={[-x, 0, -z]}>{children}</group>
		</group>
	);
}
