import { notFound } from "next/navigation";
import { prisma } from "@/lib/catalogue/db";
import { finishSlot, siteImageSrc } from "@/lib/catalogue/siteImages";
import { getPublishedPlannerCatalogue } from "@/lib/catalogue/store";
import { getDictionary } from "@/lib/copy/dictionary";
import { isLocale } from "@/lib/copy/locales";
import type { RoomTypeId } from "@/lib/planner/catalogue";
import { DEFAULT_FINISH_TEXTURES } from "@/lib/planner/finishTextures";
import { PlannerApp } from "./PlannerApp";

export default async function PlannerPage({
	params,
	searchParams,
}: {
	params: Promise<{ lang: string }>;
	searchParams: Promise<{ room?: string }>;
}) {
	const [{ lang }, { room }] = await Promise.all([params, searchParams]);
	if (!isLocale(lang)) notFound();

	const [{ data: catalogue }, siteImages, copy] = await Promise.all([
		getPublishedPlannerCatalogue(),
		prisma.siteImage.findMany(),
		getDictionary(lang),
	]);

	// Validated against the catalogue that is actually about to be rendered: a
	// room with no cabinets yet is coming soon and cannot be planned, so a link
	// to one — or no link at all — opens the first room that can.
	const plannable = catalogue.roomTypes.filter((r) => r.familyIds.length > 0);
	const initialRoomId: RoomTypeId = (
		plannable.find((r) => r.id === room) ??
		plannable[0] ??
		catalogue.roomTypes[0]
	).id;

	// The photo an admin uploaded for each finish, if any. The same slot already
	// feeds the landing page's swatch, so one upload makes the strip and the 3D
	// cabinet show the same board — which is the point: a customer picks a
	// swatch and sees that exact decor on the door.
	const uploaded = new Map(
		siteImages.map((image) => [
			image.key,
			siteImageSrc(image.key, image.updatedAt),
		]),
	);
	// Shipped decor scans first, an admin upload over the top. That order is
	// what lets the client fix a wrong board themselves without a deploy.
	const finishTextures: Record<string, string> = {};
	for (const finish of catalogue.finishes) {
		const url =
			uploaded.get(finishSlot(finish.id)) ?? DEFAULT_FINISH_TEXTURES[finish.id];
		if (url) finishTextures[finish.id] = url;
	}

	return (
		<PlannerApp
			initialRoomId={initialRoomId}
			catalogue={catalogue}
			finishTextures={finishTextures}
			copy={copy}
			locale={lang}
		/>
	);
}
