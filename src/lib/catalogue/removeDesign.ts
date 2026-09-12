import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";

/**
 * Taking a cabinet back out of the planner catalogue.
 *
 * The mirror of `mergeIntoCatalogue`, and deliberately not part of it: the merge
 * is additive by design — it never overwrites a price, never removes anything —
 * and folding a destructive path into it would put the two opposite intents
 * behind one function.
 *
 * Dropping the rung is the easy half. What breaks a customer's share link is
 * everything that *points* at the rung: a room's `familyIds`, a starter layout
 * placing that exact width. Both are cleaned here, and the two cases where
 * cleaning them cannot produce a valid catalogue — a room left with no families,
 * a catalogue left with none — refuse rather than write a document that will
 * not parse on the way back out.
 *
 * Pure, so the route can show the admin what will happen before it happens.
 */

type Removable = {
	/** The family this design was pushed into; null means it never was. */
	familyId: string | null;
	widthMm: number;
};

export type RemoveResult =
	| {
			ok: true;
			/** False when the design was never in the catalogue — nothing to publish. */
			changed: boolean;
			catalogue: PlannerCatalogue;
			changes: string[];
	  }
	| { ok: false; message: string };

export function removeDesign(
	catalogue: PlannerCatalogue,
	design: Removable,
): RemoveResult {
	const unchanged: RemoveResult = {
		ok: true,
		changed: false,
		catalogue,
		changes: [],
	};

	if (!design.familyId) return unchanged;
	const family = catalogue.families.find((f) => f.id === design.familyId);
	if (!family) return unchanged;

	const sizes = family.sizes.filter((s) => s.widthMm !== design.widthMm);
	if (sizes.length === family.sizes.length) return unchanged;

	// A family with no rungs left is not a family — `sizes` is `min(1)` — so the
	// last rung takes the family with it.
	const dropFamily = sizes.length === 0;

	if (dropFamily) {
		if (catalogue.families.length === 1) {
			return {
				ok: false,
				message: `"${family.label}" is the only cabinet in the catalogue. Removing it would leave the planner with nothing to place — add another cabinet first.`,
			};
		}
		const orphaned = catalogue.roomTypes.find(
			(room) =>
				room.familyIds.includes(family.id) && room.familyIds.length === 1,
		);
		if (orphaned) {
			return {
				ok: false,
				message: `"${family.label}" is the only cabinet the ${orphaned.label} room offers. Give that room another cabinet at /admin/catalogue first, or it opens empty.`,
			};
		}
	}

	const changes = [
		dropFamily
			? `Removed "${family.label}" from the catalogue`
			: `Removed the ${design.widthMm}mm rung from "${family.label}"`,
	];

	const next: PlannerCatalogue = {
		...catalogue,
		families: dropFamily
			? catalogue.families.filter((f) => f.id !== family.id)
			: catalogue.families.map((f) =>
					f.id === family.id ? { ...f, sizes } : f,
				),
		roomTypes: catalogue.roomTypes.map((room) => {
			// A starter placing a width that no longer exists is an off-ladder
			// module, which is exactly what the engine rejects server-side.
			const starter = room.starter.filter(
				(m) =>
					m.familyId !== family.id ||
					(!dropFamily && m.widthMm !== design.widthMm),
			);
			const familyIds = dropFamily
				? room.familyIds.filter((id) => id !== family.id)
				: room.familyIds;
			const dropped =
				room.starter.length - starter.length > 0 ||
				familyIds.length !== room.familyIds.length;
			if (dropped && room.starter.length !== starter.length) {
				changes.push(`Dropped it from the ${room.label} starter layout`);
			}
			return { ...room, starter, familyIds };
		}),
	};

	return { ok: true, changed: true, catalogue: next, changes };
}
