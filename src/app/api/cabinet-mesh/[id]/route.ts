import { NextResponse } from "next/server";
import { prisma } from "@/lib/catalogue/db";
import { fetchRenderMeshFile } from "@/lib/catalogue/meshBlob";

export const runtime = "nodejs";

/**
 * Serves one cabinet's render mesh to the planner.
 *
 * Public on purpose — it sits outside `/api/admin`, so `proxy.ts`'s gate does
 * not apply, and it has to be: this is the geometry a customer's browser draws.
 * The same narrow-hole shape as `/api/site-images/[key]`, and for the same
 * reason: the Blob store is private-access, so the bytes cannot be linked to
 * directly.
 *
 * What stays private is the *source* export. That file carries the client's
 * part naming, layer structure and module standard, and never leaves
 * `/api/admin`. What leaves here is the derived mesh — triangles, classified by
 * role, with the drafter's materials and every name stripped out.
 *
 * Any converted design resolves. The id is an unguessable cuid and the bytes
 * are only triangles, so an unpublished design leaks nothing a live one would
 * not.
 */
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;

	const design = await prisma.cabinetDesign.findUnique({
		where: { id },
		select: { meshPathname: true },
	});
	// No status check: an archived design stays in the live catalogue until the
	// next publish, and until then it must still draw as the model, not a box.
	if (!design?.meshPathname) {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}

	const bytes = await fetchRenderMeshFile(design.meshPathname);

	return new Response(new Uint8Array(bytes), {
		headers: {
			"Content-Type": "application/octet-stream",
			// The pathname carries the source file's sha256, so a given design's
			// bytes never change under the same URL — a re-upload writes a new
			// pathname. Safe to cache for a year.
			"Cache-Control": "public, max-age=31536000, immutable",
		},
	});
}
