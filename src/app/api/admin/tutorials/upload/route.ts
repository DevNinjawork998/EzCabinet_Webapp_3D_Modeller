import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { mux, tutorialAssetSettings } from "@/lib/mux";

export const runtime = "nodejs";

/**
 * Mints a one-shot Mux direct-upload URL for the browser.
 *
 * Same shape and same trust model as
 * `/api/admin/catalogue/uploads/token/route.ts`: this route hands back a
 * short-lived credential, the browser PUTs the bytes **straight to Mux**, and
 * the client then calls the finalize route to record the row. Auth is the
 * middleware's job — by the time this runs the request already carries an
 * admin session cookie, because it sits under `/api/admin/*`.
 *
 * The upload cannot go through us even if we wanted it to: a Vercel function
 * caps request bodies at 100 MB and a ten-minute tutorial is well past that.
 *
 * `cors_origin` is the page allowed to perform the upload. It is scoped to
 * this deployment rather than `*` so a stolen URL can't be driven from
 * somewhere else — the URL is single-use and short-lived anyway, but there is
 * no reason to widen it.
 */
export const POST = withAuth("content:write", async (request) => {
	try {
		const origin = new URL(request.url).origin;
		const upload = await mux.video.uploads.create({
			cors_origin: origin,
			new_asset_settings: tutorialAssetSettings(),
		});

		return NextResponse.json({ id: upload.id, url: upload.url });
	} catch (error) {
		return NextResponse.json(
			{ error: (error as Error).message },
			{ status: 502 },
		);
	}
});
