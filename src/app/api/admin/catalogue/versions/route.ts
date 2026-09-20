import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import {
	catalogueSchemaByProduct,
	productSchema,
} from "@/lib/catalogue/schemaByProduct";
import { createDraftVersion } from "@/lib/catalogue/versions";

export const runtime = "nodejs";

export const GET = withAuth("catalogue:read", async (request) => {
	const product = productSchema.safeParse(
		new URL(request.url).searchParams.get("product"),
	);
	if (!product.success) {
		return NextResponse.json({ error: "invalid product" }, { status: 400 });
	}

	const includeData =
		new URL(request.url).searchParams.get("include") === "data";

	const versions = await prisma.catalogueVersion.findMany({
		where: { product: product.data },
		orderBy: { version: "desc" },
		select: {
			id: true,
			product: true,
			version: true,
			status: true,
			note: true,
			createdBy: true,
			createdAt: true,
			publishedAt: true,
			data: includeData,
			import: { select: { filename: true } },
		},
	});
	return NextResponse.json({ versions });
});

/** Create a DRAFT row from reviewed data. Never live — publish is separate. */
export const POST = withAuth("catalogue:write", async (request) => {
	const body = (await request.json()) as {
		product?: string;
		data?: unknown;
		note?: string;
		importId?: string;
	};

	const product = productSchema.safeParse(body.product);
	if (!product.success) {
		return NextResponse.json({ error: "invalid product" }, { status: 400 });
	}

	const parsed = catalogueSchemaByProduct[product.data].safeParse(body.data);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid_catalogue", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const draft = await createDraftVersion({
		product: product.data,
		data: parsed.data,
		note: body.note,
		importId: body.importId,
	});

	return NextResponse.json({ id: draft.id, status: draft.status });
});
