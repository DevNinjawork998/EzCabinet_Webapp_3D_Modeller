import { useFrame } from "@react-three/fiber";
import type { ReactNode } from "react";
import { useRef } from "react";
import type { Group } from "three";
import { MathUtils } from "three";
import { markShadowsDirty } from "./lightingRig";

/**
 * A drawer that runs out of its carcass.
 *
 * The counterpart to `Hinge`, and deliberately its twin: same damped easing,
 * same settle-exactly-once rule, driven by the same `openIds` set. A door that
 * swings while the drawer bank beside it stays shut is the thing that reads as
 * broken — a run either opens or it does not.
 *
 * Straight translation along +z, because a drawer has no pivot to derive. How
 * far is `drawerTravelMm` in `lib/planner/parts.ts`, so the number is testable
 * arithmetic rather than a constant buried in a component.
 *
 * Children stay in the cabinet's own frame: this group starts at the origin and
 * moves, so a caller passes the same absolutely-positioned mesh it drew before.
 */

/** Close enough to stop writing to the transform. Half a millimetre, in metres. */
const SETTLED_M = 0.0005;

export function Slide({
	/** How far out, in metres — the scene's unit. */
	travel,
	open,
	children,
}: {
	travel: number;
	open: boolean;
	children: ReactNode;
}) {
	const runner = useRef<Group>(null);
	const target = open ? travel : 0;

	useFrame((_, delta) => {
		const group = runner.current;
		if (!group) return;
		const current = group.position.z;
		if (Math.abs(current - target) < SETTLED_M) {
			// Land exactly on the target once rather than easing at it forever.
			if (current !== target) {
				group.position.z = target;
				markShadowsDirty();
			}
			return;
		}
		group.position.z = MathUtils.damp(current, target, 8, delta);
		markShadowsDirty();
	});

	return <group ref={runner}>{children}</group>;
}
