import { del } from "@vercel/blob";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/route";
import { prisma } from "@/lib/catalogue/db";
import {
	SITE_IMAGE_MAX_BYTES,
	SITE_IMAGE_PATHNAME,
	SLOT_KEY,
} from "@/lib/catalogue/siteImages";

export const runtime = "nodejs";

const upsertSchema = z.object({
	key: z.string().regex(SLOT_KEY, "unknown slot"),
	blobUrl: z.string().min(1),
	blobPathname: z.string().regex(SITE_IMAGE_PATHNAME, "bad pathname"),
	filename: z.string().min(1),
	sizeBytes: z.number().int().positive().max(SITE_IMAGE_MAX_BYTES),
});

export const GET = withAuth("content:write", async () => {
	const images = await prisma.siteImage.findMany();
	return NextResponse.json({ images });
});

/**
 * Records a just-uploaded photo against its slot. No draft/publish step —
 * the homepage shows it immediately, which is what the design promises, so
 * the cache for `/` is purged here rather than waiting for the next ISR
 * revalidation.
 */
export const PUT = withAuth("content:write", async (request) => {
	const parsed = upsertSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}
	const { key, ...data } = parsed.data;
	const uploadedBy = "admin"; // ponytail: see imports/route.ts

	const previous = await prisma.siteImage.findUnique({ where: { key } });

	const image = await prisma.siteImage.upsert({
		where: { key },
		create: { key, ...data, uploadedBy },
		update: { ...data, uploadedBy },
	});

	// Replacing a slot leaves the old object behind unless the pathname
	// happened to collide. Best-effort: a failed cleanup must not fail the
	// request, since the new photo is already live.
	if (previous && previous.blobPathname !== data.blobPathname) {
		await del(previous.blobUrl).catch(() => {});
	}

	revalidatePath("/");
	return NextResponse.json({ image });
});

/** Clears a slot back to its placeholder. */
export const DELETE = withAuth("content:write", async (request) => {
	const key = new URL(request.url).searchParams.get("key") ?? "";
	if (!SLOT_KEY.test(key)) {
		return NextResponse.json({ error: "unknown slot" }, { status: 400 });
	}

	const existing = await prisma.siteImage.findUnique({ where: { key } });
	if (!existing) return NextResponse.json({ ok: true });

	await prisma.siteImage.delete({ where: { key } });
	await del(existing.blobUrl).catch(() => {});

	revalidatePath("/");
	return NextResponse.json({ ok: true });
});
