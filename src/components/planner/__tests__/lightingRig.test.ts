import {
	BoxGeometry,
	Group,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
} from "three";
import { describe, expect, it } from "vitest";

import {
	keyLightRig,
	markShadowsDirty,
	qualityFromSearch,
	syncShadowFlags,
	takeShadowFrame,
} from "../lightingRig";

describe("keyLightRig", () => {
	const plan = { template: "rect", widthMm: 4000, depthMm: 3000 } as const;
	const rig = keyLightRig(plan, 2600);

	it("aims at the middle of the room, half way up", () => {
		expect(rig.target).toEqual([0, 1.3, 0]);
	});

	it("sits high above the room, tilted toward the front", () => {
		expect(rig.position[1]).toBeGreaterThan(rig.target[1] + 5);
		expect(rig.position[2]).toBeGreaterThan(0);
	});

	it("covers the whole room box from any light direction", () => {
		// Half the room box's diagonal: 4 × 3 × 2.6 m.
		expect(rig.halfExtent).toBeCloseTo(Math.hypot(4, 3, 2.6) / 2, 6);
		const distance = Math.hypot(
			rig.position[0] - rig.target[0],
			rig.position[1] - rig.target[1],
			rig.position[2] - rig.target[2],
		);
		expect(rig.near).toBeLessThanOrEqual(distance - rig.halfExtent);
		expect(rig.near).toBeGreaterThan(0);
		expect(rig.far).toBeGreaterThanOrEqual(distance + rig.halfExtent);
	});

	it("an L room is bounded by its own width and depth", () => {
		const l = keyLightRig(
			{
				template: "l",
				widthMm: 4000,
				depthMm: 3000,
				notchWidthMm: 1500,
				notchDepthMm: 1000,
				mirror: false,
			},
			2600,
		);
		expect(l.halfExtent).toBeCloseTo(rig.halfExtent, 6);
	});
});

describe("shadow dirty counter", () => {
	it("hands out exactly as many frames as were asked for", () => {
		const drain = () => {
			while (takeShadowFrame());
		};
		drain();
		markShadowsDirty(3);
		expect([takeShadowFrame(), takeShadowFrame(), takeShadowFrame()]).toEqual([
			true,
			true,
			true,
		]);
		expect(takeShadowFrame()).toBe(false);
	});

	it("never shortens a longer pending request", () => {
		const drain = () => {
			while (takeShadowFrame());
		};
		drain();
		markShadowsDirty(5);
		markShadowsDirty(1);
		let taken = 0;
		while (takeShadowFrame()) taken++;
		expect(taken).toBe(5);
	});

	it("defaults to two frames", () => {
		const drain = () => {
			while (takeShadowFrame());
		};
		drain();
		markShadowsDirty();
		let taken = 0;
		while (takeShadowFrame()) taken++;
		expect(taken).toBe(2);
	});
});

describe("syncShadowFlags", () => {
	const box = new BoxGeometry();

	it("lit meshes cast and receive", () => {
		const lit = new Mesh(box, new MeshStandardMaterial());
		const glass = new Mesh(box, new MeshPhysicalMaterial());
		const root = new Group().add(lit, glass);
		syncShadowFlags(root);
		expect([lit.castShadow, lit.receiveShadow]).toEqual([true, true]);
		expect([glass.castShadow, glass.receiveShadow]).toEqual([true, true]);
	});

	it("UI and fake-shadow meshes do neither", () => {
		const ui = new Mesh(box, new MeshBasicMaterial());
		syncShadowFlags(new Group().add(ui));
		expect([ui.castShadow, ui.receiveShadow]).toEqual([false, false]);
	});

	it("receive-only meshes never cast", () => {
		const wall = new Mesh(box, new MeshStandardMaterial());
		wall.userData.shadow = "receive";
		syncShadowFlags(new Group().add(wall));
		expect([wall.castShadow, wall.receiveShadow]).toEqual([false, true]);
	});

	it("looks inside nested groups", () => {
		const deep = new Mesh(box, new MeshStandardMaterial());
		syncShadowFlags(new Group().add(new Group().add(deep)));
		expect(deep.castShadow).toBe(true);
	});
});

describe("qualityFromSearch", () => {
	it("reads a forced tier in development", () => {
		expect(qualityFromSearch("?quality=high", true)).toBe("high");
		expect(qualityFromSearch("?x=1&quality=low", true)).toBe("low");
	});

	it("ignores anything else", () => {
		expect(qualityFromSearch("?quality=ultra", true)).toBeNull();
		expect(qualityFromSearch("", true)).toBeNull();
	});

	it("is ignored in production", () => {
		expect(qualityFromSearch("?quality=high", false)).toBeNull();
	});
});
