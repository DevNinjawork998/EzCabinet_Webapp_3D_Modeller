import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { mux } from "@/lib/mux";

export const runtime = "nodejs";

/**
 * Resolves a `PROCESSING` tutorial against Mux and writes back whatever it has
 * finished doing. The admin page polls this after an upload.
 *
 * **Polling rather than a webhook, on purpose.** Mux's `video.asset.ready`
 * webhook does not reach localhost without a tunnel — the same reason
 * `/api/admin/catalogue/uploads/token` skips Blob's `onUploadCompleted`, and
 * the same three-person internal tool. A webhook is the production upgrade,
 * not a prerequisite: this route is what makes it optional, and it stays
 * correct either way because it reads Mux's state rather than trusting an
 * event to have arrived.
 *
 * Two hops, because ingest happens in two stages: the upload knows its
 * `asset_id` only once the bytes land, and the asset knows its playback id and
 * duration only once encoding finishes.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"content:write",
	async (_request, { params }) => {
		const { id } = await params;

		const tutorial = await prisma.tutorial.findUnique({ where: { id } });
		if (!tutorial) {
			return NextResponse.json({ error: "not found" }, { status: 404 });
		}
		if (tutorial.status === "READY") {
			return NextResponse.json({ tutorial });
		}

		try {
			let assetId = tutorial.muxAssetId;

			if (!assetId) {
				const upload = await mux.video.uploads.retrieve(tutorial.muxUploadId);
				if (upload.status === "cancelled" || upload.status === "errored") {
					const errored = await prisma.tutorial.update({
						where: { id },
						data: { status: "ERRORED" },
					});
					return NextResponse.json({ tutorial: errored });
				}
				assetId = upload.asset_id ?? null;
				// Bytes still arriving — nothing to record yet.
				if (!assetId) return NextResponse.json({ tutorial });
			}

			const asset = await mux.video.assets.retrieve(assetId);

			if (asset.status === "errored") {
				const errored = await prisma.tutorial.update({
					where: { id },
					data: { status: "ERRORED", muxAssetId: assetId },
				});
				return NextResponse.json({ tutorial: errored });
			}

			const playbackId = asset.playback_ids?.[0]?.id ?? null;
			const ready = asset.status === "ready" && playbackId !== null;

			const updated = await prisma.tutorial.update({
				where: { id },
				data: {
					muxAssetId: assetId,
					playbackId,
					durationSec: asset.duration ? Math.round(asset.duration) : null,
					status: ready ? "READY" : tutorial.status,
				},
			});

			return NextResponse.json({ tutorial: updated });
		} catch (error) {
			return NextResponse.json(
				{ error: (error as Error).message },
				{ status: 502 },
			);
		}
	},
);
