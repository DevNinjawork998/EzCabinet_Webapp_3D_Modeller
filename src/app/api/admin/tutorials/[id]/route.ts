import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { mux } from "@/lib/mux";
import { tutorialInputSchema } from "@/lib/tutorials";

export const runtime = "nodejs";

/** Edit a tutorial's metadata. The video itself is immutable — re-upload to
 * replace it, which is one more row and one more asset rather than a mutation
 * with two things to keep in step. */
export const PATCH = withAuth<{ params: Promise<{ id: string }> }>(
	"content:write",
	async (request, { params }) => {
		const { id } = await params;
		const parsed = tutorialInputSchema
			.partial()
			.safeParse(await request.json());
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "invalid tutorial", issues: parsed.error.issues },
				{ status: 400 },
			);
		}

		const tutorial = await prisma.tutorial.update({
			where: { id },
			data: parsed.data,
		});
		return NextResponse.json({ tutorial });
	},
);

/**
 * Deletes the tutorial and its Mux asset.
 *
 * Mux first, row second: if the asset delete fails we still hold the id and
 * can retry, whereas dropping the row first would orphan an asset that bills
 * monthly with nothing left pointing at it. A 404 from Mux is treated as
 * success — it means the asset is already gone, which is the state we want.
 */
export const DELETE = withAuth<{ params: Promise<{ id: string }> }>(
	"content:write",
	async (_request, { params }) => {
		const { id } = await params;

		const tutorial = await prisma.tutorial.findUnique({ where: { id } });
		if (!tutorial) {
			return NextResponse.json({ error: "not found" }, { status: 404 });
		}

		if (tutorial.muxAssetId) {
			try {
				await mux.video.assets.delete(tutorial.muxAssetId);
			} catch (error) {
				const status = (error as { status?: number }).status;
				if (status !== 404) {
					return NextResponse.json(
						{
							error: `could not delete the Mux asset: ${(error as Error).message}`,
						},
						{ status: 502 },
					);
				}
			}
		}

		await prisma.tutorial.delete({ where: { id } });
		return NextResponse.json({ ok: true });
	},
);
