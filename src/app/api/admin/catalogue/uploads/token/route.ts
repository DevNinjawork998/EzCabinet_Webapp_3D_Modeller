import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { MESH_PATHNAME } from "@/lib/catalogue/meshBlob";

export const runtime = "nodejs";

/**
 * Issues the short-lived token `@vercel/blob/client`'s `upload()` needs to
 * write straight to Blob from the browser. Auth is handled by middleware
 * (this route sits under `/api/admin/*`) — by the time this runs, the
 * request already carries a valid admin session cookie.
 *
 * The client picks the `importId` (a `crypto.randomUUID()`) and builds the
 * pathname itself before calling `upload()` — `onBeforeGenerateToken` only
 * gets to see the pathname the client already chose, not invent one, so
 * there's no way to hand back a server-generated id here. That's fine: the
 * id is just a path key for namespacing, not a trust boundary. The real
 * integrity check is the finalize route's sha256 dedupe against bytes it
 * fetches back itself.
 *
 * No `onUploadCompleted`: that webhook doesn't fire on localhost without an
 * ngrok tunnel (confirmed against Vercel's own docs), and this is a
 * three-person internal tool with no reason to require one. The client
 * calls `/api/admin/catalogue/imports` itself once `upload()` resolves.
 */
export const POST = withAuth("catalogue:write", async (request) => {
	const body = (await request.json()) as HandleUploadBody;

	try {
		const jsonResponse = await handleUpload({
			body,
			request,
			onBeforeGenerateToken: async (pathname) => {
				if (!MESH_PATHNAME.test(pathname)) {
					throw new Error(`invalid design-import pathname: ${pathname}`);
				}
				return {
					// Content type is not a trust boundary here — browsers report
					// a zip as any of several types depending on how it was made,
					// and the finalize route reads the actual bytes anyway. The
					// pathname check above is what actually scopes the token.
					addRandomSuffix: false,
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
