import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { mux } from "@/lib/mux";

export const runtime = "nodejs";

/**
 * Throws away a video the admin uploaded but never published.
 *
 * The redesign lets the upload finish before any metadata is typed, so
 * "✕ Remove video" can land on bytes that already reached Mux. Without this
 * the abandoned upload becomes an asset that bills monthly with nothing in our
 * database pointing at it — invisible cost, and the whole reason the retainer
 * conversation happened.
 *
 * Cancelling only works while the upload is still `waiting`; once Mux has
 * ingested it there is an asset instead, so that path deletes the asset. Both
 * are treated as success if Mux says the thing is already gone.
 */
export const DELETE = withAuth<{ params: Promise<{ id: string }> }>(
	"content:write",
	async (_request, { params }) => {
		const { id } = await params;

		// Never discard bytes a Tutorial row is already relying on — that row's own
		// DELETE is the way to remove a published tutorial.
		const claimed = await prisma.tutorial.findUnique({
			where: { muxUploadId: id },
			select: { id: true },
		});
		if (claimed) {
			return NextResponse.json(
				{
					error:
						"that upload is already published; delete the tutorial instead",
				},
				{ status: 409 },
			);
		}

		try {
			const upload = await mux.video.uploads.retrieve(id);

			if (upload.status === "waiting" || upload.status === "asset_created") {
				// Cancel is only legal while waiting; once an asset exists the asset
				// is the thing that costs money.
				if (upload.asset_id) {
					await mux.video.assets.delete(upload.asset_id).catch(() => {});
				} else {
					await mux.video.uploads.cancel(id);
				}
			}

			return NextResponse.json({ ok: true });
		} catch (error) {
			const status = (error as { status?: number }).status;
			// Already gone is the state we wanted.
			if (status === 404) return NextResponse.json({ ok: true });
			return NextResponse.json(
				{ error: (error as Error).message },
				{ status: 502 },
			);
		}
	},
);
