import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { SLOT_KEY } from "@/lib/catalogue/siteImages";

export const runtime = "nodejs";

/**
 * Serves a homepage photo.
 *
 * Public on purpose — it sits outside `/api/admin`, so the middleware gate
 * doesn't apply. It exists because the Blob store is private-access-only
 * (see `siteImageSrc`), so the bytes can't be linked to directly; this is
 * the narrow, read-only hole that lets marketing photos out without making
 * design files reachable too.
 *
 * Only keys that are actually recorded in `SiteImage` resolve, so this can't
 * be used to read an arbitrary path out of the bucket.
 */
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ key: string }> },
) {
	const { key } = await params;
	if (!SLOT_KEY.test(key)) {
		return NextResponse.json({ error: "unknown slot" }, { status: 404 });
	}

	const image = await prisma.siteImage.findUnique({ where: { key } });
	if (!image) {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}

	const result = await get(image.blobPathname, {
		access: "private",
		useCache: false,
	});
	if (result?.statusCode !== 200) {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}

	return new Response(result.stream, {
		headers: {
			"Content-Type": result.blob.contentType ?? "image/jpeg",
			// The URL carries `?v=<updatedAt>`, so a given URL's bytes never
			// change — safe to cache hard and let the query string do the
			// busting when a photo is replaced. `s-maxage` lets Vercel's CDN
			// hold it too (it keys on the query string), so a flood of requests
			// for the hero photo is served from the edge, not a function and a
			// Blob read apiece.
			"Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
		},
	});
}
