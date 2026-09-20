import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import { fetchMeshFile } from "@/lib/catalogue/meshBlob";

export const runtime = "nodejs";

/**
 * Streams a stored design file back to an admin, for the preview viewport.
 *
 * The Blob store is private on purpose — a design carries the client's module
 * standard and part naming, so it never gets a public URL. This route is the
 * narrow exception: it sits under `/api/admin`, which `proxy.ts` gates behind
 * the admin session, and it hands back one file the admin picked by id. A
 * customer cannot reach it, and there is no listing to enumerate.
 */
export const GET = withAuth<{ params: Promise<{ id: string }> }>(
	"catalogue:read",
	async (_request, { params }) => {
		const { id } = await params;

		const design = await prisma.cabinetDesign.findUnique({
			where: { id },
			select: { blobPathname: true, filename: true },
		});
		if (!design) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}

		const bytes = await fetchMeshFile(design.blobPathname);

		return new Response(new Uint8Array(bytes), {
			headers: {
				"Content-Type": "model/obj",
				// Inline: the viewer fetches this, nobody downloads it. `private`
				// keeps it out of any shared cache on the way.
				"Content-Disposition": `inline; filename="${design.filename.replace(/"/g, "")}"`,
				"Cache-Control": "private, max-age=300",
			},
		});
	},
);
