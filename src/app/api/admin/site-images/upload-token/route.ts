import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import {
	SITE_IMAGE_CONTENT_TYPES,
	SITE_IMAGE_MAX_BYTES,
	SITE_IMAGE_PATHNAME,
} from "@/lib/catalogue/siteImages";

export const runtime = "nodejs";

/**
 * Token route for dropping a homepage photo straight to Blob from the
 * browser, same shape as the design-import one — Vercel Functions cap request
 * bodies at 4.5MB, so the file never passes through a route handler.
 *
 * Public access, unlike a design file: these render on the public homepage, so a
 * private blob would be useless. Auth on *writing* is still enforced — this
 * route's own `withAuth("content:write", ...)` below is the gate, so an
 * anonymous or under-permissioned caller never gets a token in the first
 * place.
 */
export const POST = withAuth("content:write", async (request) => {
	const body = (await request.json()) as HandleUploadBody;

	try {
		const jsonResponse = await handleUpload({
			body,
			request,
			onBeforeGenerateToken: async (pathname) => {
				if (!SITE_IMAGE_PATHNAME.test(pathname)) {
					throw new Error(`invalid site image pathname: ${pathname}`);
				}
				// No `access` here — it isn't part of what this callback may
				// return (see `onBeforeGenerateToken`'s Pick<> in
				// @vercel/blob/client), and setting it anyway produces a token the
				// Blob API rejects with a 503. Access is chosen by the client's own
				// `upload({ access: "public" })` call.
				return {
					allowedContentTypes: SITE_IMAGE_CONTENT_TYPES,
					maximumSizeInBytes: SITE_IMAGE_MAX_BYTES,
					// Overwriting a slot's photo should replace it, not accumulate
					// orphans under randomised names.
					addRandomSuffix: false,
					allowOverwrite: true,
				};
			},
		});
		return NextResponse.json(jsonResponse);
	} catch (error) {
		return NextResponse.json(
			{ error: (error as Error).message },
			{ status: 400 },
		);
	}
});
