import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { publishVersion } from "@/lib/catalogue/publishVersion";

export const runtime = "nodejs";

/**
 * Publishes a draft: supersedes whatever was PUBLISHED for this product,
 * flips this row live, revalidates the read-path cache.
 *
 * The work lives in `publishVersion`, which the design library's delete path
 * shares — one transaction rather than two, because two would drift and the
 * drift would show up as a catalogue with no live version.
 */
export const POST = withAuth<{ params: Promise<{ id: string }> }>(
	"catalogue:publish",
	async (_request, { params }) => {
		const { id } = await params;
		const result = await publishVersion(id);

		if (!result.ok) {
			return NextResponse.json(
				{
					error: result.error,
					...(result.issues ? { issues: result.issues } : {}),
				},
				{ status: result.status },
			);
		}

		return NextResponse.json({
			id: result.id,
			product: result.product,
			version: result.version,
		});
	},
);
