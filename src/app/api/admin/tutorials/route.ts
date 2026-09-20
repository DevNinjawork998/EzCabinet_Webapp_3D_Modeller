import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { tutorialCreateSchema } from "@/lib/tutorials";

export const runtime = "nodejs";

/** Every tutorial, newest ordering first, for the admin list. */
export const GET = withAuth("content:write", async () => {
	const tutorials = await prisma.tutorial.findMany({
		orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
	});
	return NextResponse.json({ tutorials });
});

/**
 * Records a tutorial once the browser's upload to Mux has resolved.
 *
 * The row is created at `PROCESSING` and keyed by `muxUploadId`, which is the
 * only id that exists at this point — Mux mints the asset asynchronously after
 * ingesting, so `muxAssetId`, `playbackId` and `durationSec` are filled in
 * later by `[id]/status`.
 *
 * Zod parses the payload rather than trusting it: this is an admin route, but
 * a malformed category here would file a tutorial the public page can't filter
 * to, and the vocabulary lives in one place precisely so both ends agree.
 */
export const POST = withAuth("content:write", async (request) => {
	const parsed = tutorialCreateSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid tutorial", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { muxUploadId, ...input } = parsed.data;
	const uploadedBy = "admin"; // ponytail: shared-secret auth, no per-user identity yet

	const tutorial = await prisma.tutorial.upsert({
		where: { muxUploadId },
		// Idempotent on the upload id so a double-submit or a retried finalize
		// edits the row it already made instead of failing on the unique index.
		create: { ...input, muxUploadId, uploadedBy },
		update: { ...input },
	});

	return NextResponse.json({ tutorial }, { status: 201 });
});
