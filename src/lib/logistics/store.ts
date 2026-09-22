import "server-only";
import type { Delivery } from "@/generated/prisma/client";
import { prisma } from "@/lib/catalogue/db";
import { enqueue, flushSoon } from "@/lib/whatsapp/outbox";
import {
	deliveryKindFor,
	draftFor,
	NOTIFY_ORDER_SELECT,
} from "@/lib/whatsapp/templates";
import { isForwardTransition } from "./status";
import type {
	DeliveryItem,
	DeliveryJob,
	DeliveryStatusName,
	TrackingUpdate,
} from "./types";
import { deliveryItemSchema } from "./types";

/**
 * The delivery read and write path, in one place.
 *
 * Two things reach for it: the admin routes, and the two tracking channels
 * (webhook and cron poll). Those last two must write the same fields the same
 * way or the row's meaning depends on which arrived first — hence one
 * `applyTrackingUpdate` rather than a copy in each route.
 */

/**
 * `items` is Json, so what comes back out of Postgres is `unknown` as far as
 * the type system is concerned. Parse rather than cast: the column can hold a
 * shape written by an older version of the form.
 */
export function readItems(value: unknown): DeliveryItem[] {
	const parsed = deliveryItemSchema.array().safeParse(value);
	return parsed.success ? parsed.data : [];
}

/** The narrow view an adapter is handed. */
export function toJob(row: Delivery): DeliveryJob {
	return {
		id: row.id,
		number: row.number,
		customerName: row.customerName,
		customerPhone: row.customerPhone,
		siteAddress: row.siteAddress,
		addressNotes: row.addressNotes,
		pickupAddress: row.pickupAddress,
		siteLat: row.siteLat,
		siteLng: row.siteLng,
		pickupLat: row.pickupLat,
		pickupLng: row.pickupLng,
		sitePostcode: row.sitePostcode,
		siteCity: row.siteCity,
		siteState: row.siteState,
		pickupPostcode: row.pickupPostcode,
		pickupCity: row.pickupCity,
		pickupState: row.pickupState,
		items: readItems(row.items),
		totalWeightKg: row.totalWeightKg,
		totalVolumeM3: row.totalVolumeM3,
		scheduledAt: row.scheduledAt,
	};
}

/**
 * Fold one reading from a carrier into the row, and record it either way.
 *
 * The event is written even when the status does not move: a poll that returns
 * the same state, or a late update that would move the job backwards, is still
 * something that happened, and the raw payload is the first thing anyone asks
 * for when a status looks wrong.
 */
export async function applyTrackingUpdate(
	deliveryId: string,
	update: TrackingUpdate,
	source: "CARRIER_WEBHOOK" | "POLL",
): Promise<Delivery> {
	const current = await prisma.delivery.findUniqueOrThrow({
		where: { id: deliveryId },
		include: { order: { select: NOTIFY_ORDER_SELECT } },
	});

	const next = update.status;
	const moves =
		next !== null &&
		next !== undefined &&
		isForwardTransition(current.status as DeliveryStatusName, next);

	// `moves` already proved `next` is a status; TypeScript cannot see that.
	const kind = moves ? deliveryKindFor(next as DeliveryStatusName) : null;

	const { row, notificationIds } = await prisma.$transaction(async (tx) => {
		const row = await tx.delivery.update({
			where: { id: deliveryId },
			data: {
				...(moves ? { status: next } : {}),
				// Contact and position details are refreshed whenever the carrier
				// sends them, regardless of whether the status moved — a driver can
				// be reassigned inside one state.
				...(update.driverName !== undefined
					? { driverName: update.driverName }
					: {}),
				...(update.driverPhone !== undefined
					? { driverPhone: update.driverPhone }
					: {}),
				...(update.vehiclePlate !== undefined
					? { vehiclePlate: update.vehiclePlate }
					: {}),
				...(update.latitude !== undefined && update.latitude !== null
					? {
							lastLatitude: update.latitude,
							lastLongitude: update.longitude ?? null,
							lastLocationAt: new Date(),
						}
					: {}),
			},
		});
		await tx.deliveryEvent.create({
			data: {
				deliveryId,
				source,
				status: moves ? next : null,
				message:
					update.message ??
					(moves
						? `Status ${current.status} → ${next}`
						: `No change (${current.status})`),
				raw: (update.raw ?? null) as never,
			},
		});
		// A job an admin made by hand has no order, so no consent record and no
		// message. A repeated reading re-uses the dedupe key and inserts nothing.
		const notificationIds =
			kind && current.order
				? await enqueue(tx, [
						draftFor({
							kind,
							order: current.order,
							delivery: { id: deliveryId, publicToken: current.publicToken },
						}),
					])
				: [];
		return { row, notificationIds };
	});
	flushSoon(notificationIds);

	return row;
}
