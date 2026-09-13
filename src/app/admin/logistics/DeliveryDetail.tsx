"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { fieldClass } from "@/components/admin/styles";
import { CARRIERS, KIND, LABEL } from "@/lib/logistics/carriers";
import { type PinState, pinState } from "@/lib/logistics/coords";
import {
	suggestVehicle,
	totalVolumeM3,
	totalWeightKg,
} from "@/lib/logistics/measure";
import {
	canGoByParcel,
	parcelCandidates,
	splitItems,
} from "@/lib/logistics/split";
import type { DeliveryItem, DeliveryStatusName } from "@/lib/logistics/types";
import { messageFor } from "./errors";
import {
	type DeliveryEventRow,
	type DeliveryRow,
	EDITABLE,
	type QuoteRow,
} from "./form";
import { activityGroups, shortTime, timeLabel } from "./time";
import {
	defaultChoice,
	etaLabel,
	JOURNEY,
	journeySteps,
	quoteTags,
	STATUS_LABEL,
} from "./tracking";

/**
 * One delivery's page: what is on the lorry, the three moves that get it
 * booked, and — once it is — the shipment followed to site. The job's details
 * and its activity sit in a column beside it, so the page stays one screen
 * tall while the arranging happens.
 */

export const BADGE_TONE: Record<DeliveryStatusName, string> = {
	DRAFT: "bg-neutral-100 text-neutral-500",
	QUOTED: "bg-[#f2efe6] text-[#6b5f2e]",
	BOOKED: "bg-[#e8eef5] text-[#27496b]",
	DRIVER_ASSIGNED: "bg-[#e8eef5] text-[#27496b]",
	PICKED_UP: "bg-[#e8eef5] text-[#27496b]",
	IN_TRANSIT: "bg-[#e8eef5] text-[#27496b]",
	DELIVERED: "bg-[#e7f0ea] text-[#1f5138]",
	CANCELLED: "bg-neutral-100 text-neutral-500",
	FAILED: "bg-[#fbf1ee] text-[#7a2c1c]",
};

const STOPPED_TONE: Partial<Record<DeliveryStatusName, string>> = {
	CANCELLED: "border-neutral-200 bg-neutral-50 text-neutral-600",
	FAILED: "border-[#f0d5cd] bg-[#fbf1ee] text-[#7a2c1c]",
};

const ACTIVE: DeliveryStatusName[] = [
	"BOOKED",
	"DRIVER_ASSIGNED",
	"PICKED_UP",
	"IN_TRANSIT",
];

/**
 * How often the page re-reads the job while it is moving.
 *
 * This polls our own database, not the carrier — the cron sweep and the
 * carrier's webhooks are what actually fetch new positions. Calling a partner's
 * API every four seconds per open browser tab would be someone else's rate
 * limit and our bill. "Refresh from carrier" is the button that does that, once.
 */
const POLL_MS = 4000;

/** Long loads and long histories both collapse, so the page stays one screen tall. */
const ITEM_CAP = 4;
const EVENT_CAP = 5;

const FOCUS =
	"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900";
const CHIP = `min-h-9 rounded-full border border-neutral-200 bg-white px-[15px] py-2 font-medium text-[12px] text-neutral-600 transition hover:bg-[#f8f7f4] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const OUTLINE = `inline-flex min-h-9 items-center self-start rounded-full border border-neutral-900 bg-white px-4 py-[9px] font-semibold text-[12px] text-neutral-900 transition hover:bg-[#f8f7f4] active:translate-y-px ${FOCUS}`;
const PRIMARY = `min-h-9 self-start rounded-full bg-[#1f5138] px-[18px] py-2.5 font-semibold text-[12px] text-white transition hover:bg-[#17402c] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const TEXT_BUTTON = `-mx-2 min-h-9 self-start px-2 py-2 font-semibold text-[12px] text-[#1f5138] hover:text-[#17402c] ${FOCUS}`;
const CARD = "flex flex-col rounded-[14px] border border-neutral-200 bg-white";
const EYEBROW =
	"font-semibold text-[12px] text-neutral-600 uppercase tracking-[.06em]";
const WARN =
	"rounded-[10px] bg-[#fef6e7] px-3.5 py-[11px] text-[#7a5a12] text-[13px] leading-[19px]";
const ERROR =
	"rounded-[10px] bg-[#fbf1ee] px-3.5 py-[11px] text-[#7a2c1c] text-[13px] leading-[19px]";
const MAIN =
	"mx-auto flex w-full max-w-[1180px] flex-col gap-[18px] px-7 pt-7 pb-16";

/**
 * Why a stop has no pin, in words an admin can act on.
 *
 * Only one of them is the admin's to fix: a vague address is theirs to sharpen,
 * a geocoder that is switched off is not — no amount of editing gets looked up.
 */
const PIN_TROUBLE: Record<
	Exclude<PinState, "located">,
	{ reason: string; action: string }
> = {
	"geocoder-off": {
		reason:
			"was not looked up — address lookup is switched off on this deployment.",
		action: "Nothing on this job can fix that; the deployment needs a key.",
	},
	"not-found": {
		reason:
			"did not resolve to a map location — the address may be too vague to place.",
		action: "Use Edit job above and give it a street and a postcode.",
	},
};

/** A carrier id as a person says it, and a sentence-safe fallback. */
const carrierLabel = (id: string | null | undefined) =>
	id ? (LABEL[id] ?? id) : "the partner";

/**
 * What the load is and what it needs, as one line. Computed from the items so
 * the split preview can say the same sentence about a half that does not exist
 * yet.
 */
const loadLine = (items: DeliveryItem[]) => {
	const weight = totalWeightKg(items);
	return `${totalVolumeM3(items)} m³${
		weight === null ? ", weight not given" : `, ${weight} kg`
	} — ${suggestVehicle(items).label}`;
};

const partnersOfKind = (kind: "vehicle" | "parcel") =>
	CARRIERS.filter((carrier) => carrier.kind === kind)
		.map((carrier) => carrier.label)
		.join(", ");

/** Which partners could quote this half at all — the reason for splitting. */
const partnerSentence = (items: DeliveryItem[]) => {
	if (items.length === 0) return "";
	return canGoByParcel(items)
		? `Parcel partners can quote this: ${partnersOfKind("parcel")}.`
		: `Vehicle partners only: ${partnersOfKind("vehicle")}.`;
};

const Spinner = () => (
	<span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-[#1f5138] motion-reduce:animate-none" />
);

function Working({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2.5 rounded-[10px] border border-neutral-200 bg-[#faf9f7] px-4 py-[13px]">
			<Spinner />
			<span className="text-[13px] text-neutral-700">{children}</span>
		</div>
	);
}

/** The three moves this page asks for, and which one is being made now. */
const PROCESS = ["Get quotations", "Choose partner", "Book pickup"];

function ProcessSteps({ stage }: { stage: number }) {
	return (
		<ol className="m-0 flex list-none flex-wrap items-center gap-2 p-0">
			{PROCESS.map((label, i) => {
				const done = i < stage;
				const active = i === stage;
				return (
					<li
						key={label}
						className={`flex items-center gap-[7px] rounded-full py-1.5 pr-[13px] pl-2 text-[12px] ${
							active
								? "border border-[#1f5138] bg-[#f2f7f4] font-semibold text-[#17402c]"
								: done
									? "border border-[#bcd0c3] bg-white font-medium text-[#1f5138]"
									: "border border-neutral-200 bg-white font-medium text-neutral-500"
						}`}
					>
						<span
							className={`flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full font-bold text-[11px] ${
								active
									? "bg-[#1f5138] text-white"
									: done
										? "bg-[#dbe8e0] text-[#1f5138]"
										: "bg-[#f0efec] text-[#616161]"
							}`}
						>
							{done ? "✓" : i + 1}
						</span>
						{label}
					</li>
				);
			})}
		</ol>
	);
}

/** A name field recorded on the job. Remembered per browser, not per admin. */
function ActorField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (name: string) => void;
}) {
	return (
		<label className="flex max-w-[280px] flex-col gap-[5px] text-[12px] text-neutral-500">
			{label}
			<input
				className={fieldClass(false, `bg-white text-neutral-900 ${FOCUS}`)}
				placeholder="e.g. Farah"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</label>
	);
}

/** A link with a copy button beside it. */
function CopyRow({
	href,
	children,
	copied,
	onCopy,
	label,
}: {
	href: string;
	children: React.ReactNode;
	copied: boolean;
	onCopy: () => void;
	label: string;
}) {
	return (
		<div className="flex items-center gap-2.5 rounded-[9px] border border-[#ecebe7] bg-[#faf9f7] px-3 py-2.5">
			<a
				className={`min-w-0 flex-1 truncate text-[12px] underline ${FOCUS}`}
				href={href}
				target="_blank"
				rel="noreferrer"
			>
				{children}
			</a>
			<button
				type="button"
				aria-label={label}
				onClick={onCopy}
				className={`min-h-9 shrink-0 rounded-lg border border-[#ecebe7] bg-white px-3 py-2 font-semibold text-[#1f5138] text-[12px] hover:bg-[#f2f7f4] ${FOCUS}`}
			>
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}

type Pickup = {
	reference: string | null;
	status: string | null;
	collectingOn: string | null;
	message: string;
};

export function DeliveryDetail({
	initial,
	geocodingConfigured,
	geocodingFault,
	easyparcel,
}: {
	initial: DeliveryRow & { events: DeliveryEventRow[] };
	geocodingConfigured: boolean;
	/** Why the geocoder is not answering, in Google's own words. Null when it is. */
	geocodingFault: string | null;
	easyparcel: { appConfigured: boolean; connected: boolean };
}) {
	const id = initial.id;
	const [delivery, setDelivery] = useState<DeliveryRow>(initial);
	const [events, setEvents] = useState<DeliveryEventRow[]>(initial.events);
	const [quotes, setQuotes] = useState<QuoteRow[] | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState<"carrier" | "customer" | null>(null);
	// Null until asked. A collection takes a moment to reach GDEX's board, so
	// "not checked yet" and "not there" must not look the same.
	const [pickup, setPickup] = useState<Pickup | null>(null);
	const [actor, setActor] = useState("");
	// Which rows would move to the new job, and whether the preview is up.
	const [ticked, setTicked] = useState<number[]>([]);
	const [splitting, setSplitting] = useState(false);
	// The two jobs a split produced. This job no longer exists once it is set.
	const [halves, setHalves] = useState<DeliveryRow[] | null>(null);
	const [showAllItems, setShowAllItems] = useState(false);
	const [showAllEvents, setShowAllEvents] = useState(false);
	// The note the carrier gave us, as an element we can ask to print itself.
	const labelFrame = useRef<HTMLIFrameElement>(null);

	// Read after mount: `localStorage` does not exist on the server, and a value
	// read during render would not survive hydration.
	useEffect(() => {
		setActor(localStorage.getItem("ic.logistics.actor") ?? "");
	}, []);

	const rememberActor = (name: string) => {
		setActor(name);
		localStorage.setItem("ic.logistics.actor", name);
	};

	const read = useCallback(async () => {
		const res = await fetch(`/api/admin/deliveries/${id}`);
		if (!res.ok) return;
		const body = await res.json();
		const { events: fresh, ...row } = body.delivery;
		setDelivery(row);
		setEvents(fresh ?? []);
	}, [id]);

	// Keyed on the status, not on `delivery`: every poll replaces that object,
	// so depending on it would tear the interval down on each tick.
	const movingStatus = ACTIVE.includes(delivery.status)
		? delivery.status
		: null;
	useEffect(() => {
		if (movingStatus === null) return;
		const timer = setInterval(read, POLL_MS);
		return () => clearInterval(timer);
	}, [movingStatus, read]);

	async function compare() {
		setBusy("compare");
		setError(null);
		const res = await fetch(`/api/admin/deliveries/${id}/quotes`, {
			method: "POST",
		});
		setBusy(null);
		if (!res.ok) {
			setError("Could not reach the logistics partners");
			return;
		}
		const body = await res.json();
		const rows: QuoteRow[] = body.quotes ?? [];
		setQuotes(rows);
		setSelected(defaultChoice(rows));
		await read();
	}

	async function book() {
		const choice = quotes?.find((quote) => quote.carrierId === selected);
		if (!choice) return;
		setBusy("book");
		setError(null);
		const res = await fetch(`/api/admin/deliveries/${id}/book`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				carrierId: choice.carrierId,
				bookedBy: actor,
				quotedPriceRm: choice.priceRm,
			}),
		});
		setBusy(null);
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			if (body?.error === "price_moved") {
				setError(
					`The price moved to RM ${body.currentPriceRm} — compare again before booking.`,
				);
				return;
			}
			// Append rather than replace: an unreadable carrier reply must still
			// leave our own sentence on screen.
			const said = messageFor(body?.error, "Booking failed");
			setError(body?.message ? `${said} (${body.message})` : said);
			return;
		}
		setQuotes(null);
		await read();
	}

	/** Ask GDEX what it has scheduled, rather than trusting our own success. */
	async function checkPickup() {
		setBusy("pickup");
		setError(null);
		const res = await fetch(`/api/admin/deliveries/${id}/pickup`, {
			method: "POST",
		});
		setBusy(null);
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			setError(messageFor(body?.error, "Could not check the collection"));
			return;
		}
		setPickup(body.pickup);
	}

	async function refreshFromCarrier() {
		setBusy("track");
		setError(null);
		const res = await fetch(`/api/admin/deliveries/${id}/track`, {
			method: "POST",
		});
		setBusy(null);
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			setError(messageFor(body?.error, "Could not reach the carrier"));
			return;
		}
		await read();
	}

	/** The endpoint deletes this job and returns the two that replace it. */
	async function commitSplit() {
		setBusy("split");
		setError(null);
		const res = await fetch(`/api/admin/deliveries/${id}/split`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				itemIndexes: ticked,
				actor: actor.trim() === "" ? "Admin" : actor,
			}),
		});
		setBusy(null);
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			setError(messageFor(body?.error, "Could not split this job"));
			return;
		}
		setSplitting(false);
		setHalves(body.deliveries as DeliveryRow[]);
	}

	async function advance(status: DeliveryStatusName) {
		if (actor.trim() === "") {
			setError("Put your name in the field above — it goes on the record.");
			return;
		}
		setBusy(status);
		setError(null);
		const res = await fetch(`/api/admin/deliveries/${id}/advance`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status, actor }),
		});
		setBusy(null);
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			if (body?.error === "carrier_refused_cancel") {
				setError(
					`The carrier would not cancel this job — ring them. (${body.message})`,
				);
				return;
			}
			setError(messageFor(body?.error, "Could not update this job"));
			return;
		}
		await read();
	}

	const copy = async (text: string, which: "carrier" | "customer") => {
		await navigator.clipboard.writeText(text);
		setCopied(which);
		setTimeout(() => setCopied(null), 1500);
	};

	if (halves !== null) {
		return (
			<main className={MAIN}>
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">
						Split into {halves.map((half) => `#${half.number}`).join(" and ")}
					</h1>
					<p className="text-[13px] text-neutral-500">
						Two ordinary jobs now, each quoted and booked on its own. Neither
						has reached a carrier.
					</p>
				</div>
				<ul className="flex flex-col gap-2">
					{halves.map((half) => (
						<li key={half.id}>
							<Link
								href={`/admin/logistics/${half.id}`}
								className={`flex flex-wrap items-center gap-3 rounded-xl border border-[#bcd0c3] bg-[#f2f7f4] px-4 py-3.5 transition hover:bg-[#eaf1ec] ${FOCUS}`}
							>
								<span className="font-medium text-[13px] text-neutral-500 tabular-nums">
									#{half.number}
								</span>
								<span className="min-w-[170px] flex-1">
									<span className="block font-medium text-[14px]">
										{half.customerName}
									</span>
									<span className="mt-0.5 block text-[12px] text-neutral-500">
										{half.items.length}{" "}
										{half.items.length === 1 ? "item" : "items"} ·{" "}
										{loadLine(half.items)}
									</span>
								</span>
								<span className="text-[12px] text-neutral-500">
									Split from #{delivery.number}
								</span>
								<span className="rounded-full bg-white px-3 py-1.5 font-semibold text-[11px] text-neutral-500">
									{STATUS_LABEL[half.status]}
								</span>
								<span className="font-semibold text-[#1f5138] text-[12px]">
									Open →
								</span>
							</Link>
						</li>
					))}
				</ul>
				<Link href="/admin/logistics" className={OUTLINE}>
					Go to deliveries →
				</Link>
			</main>
		);
	}

	const booked = delivery.carrierOrderId !== null;
	// A cancelled or failed job is off the journey, so there is no next stop.
	const onJourney = JOURNEY.indexOf(delivery.status);
	const nextStep = onJourney === -1 ? undefined : JOURNEY[onJourney + 1];
	const stopped =
		delivery.status === "CANCELLED" || delivery.status === "FAILED";
	const stoppedAt =
		events.find((event) => event.status === delivery.status)?.at ?? null;
	const steps = journeySteps(delivery.status, events, delivery.carrierId);
	const tags = quotes === null ? {} : quoteTags(quotes);
	const choice = quotes?.find((q) => q.carrierId === selected) ?? null;
	const actorMissing = actor.trim() === "";

	// A job worth splitting has more than one thing on it and has not been
	// bought yet.
	const splittable = !booked && delivery.items.length > 1;
	const canSplitNow =
		splittable &&
		!splitting &&
		ticked.length > 0 &&
		ticked.length < delivery.items.length;
	const { moved, kept } = splitItems(delivery.items, ticked);
	// Some of the load would go by parcel and some would not — the shape that
	// makes splitting the answer rather than a bigger lorry.
	const mixedLoad =
		splittable &&
		!canGoByParcel(delivery.items) &&
		parcelCandidates(delivery.items).length > 0;
	const parcelRefused =
		mixedLoad &&
		(quotes ?? []).some(
			(quote) =>
				quote.error !== undefined && KIND[quote.carrierId] === "parcel",
		);
	const startSplit = () => {
		// Nothing ticked yet: propose the pieces a parcel network could take.
		if (ticked.length === 0) setTicked(parcelCandidates(delivery.items));
		setSplitting(true);
		setError(null);
	};

	const itemsCollapsible = delivery.items.length > ITEM_CAP && !splitting;
	const shownItems =
		itemsCollapsible && !showAllItems
			? delivery.items.slice(0, ITEM_CAP)
			: delivery.items;

	const eventsCollapsible = events.length > EVENT_CAP;
	const groups = activityGroups(
		eventsCollapsible && !showAllEvents ? events.slice(0, EVENT_CAP) : events,
	);

	// Which of the three moves is being made now — the stepper and the sentence
	// under it read it from one place.
	const stage = booked
		? 3
		: busy === "book"
			? 2
			: quotes === null || busy === "compare"
				? 0
				: 1;

	const guide = stopped
		? delivery.status === "CANCELLED"
			? "This job was cancelled. Nothing will be collected — the tracker below shows how far it got before it stopped."
			: "This job failed with the carrier. Nothing will be collected — the tracker below shows how far it got."
		: booked
			? "Pickup is booked. Follow the shipment below; refresh from the carrier for a fresh position."
			: busy === "compare"
				? "Asking every partner what this job costs. Nothing is booked yet."
				: quotes === null
					? "Start by comparing partners. Nothing reaches a carrier until you book."
					: busy === "book"
						? `Creating the job with ${carrierLabel(choice?.carrierId)}. Stay on this page until it confirms.`
						: parcelRefused
							? "The parcel partners refused on size — the carcasses are over their girth limit. Split the job to send the hardware by parcel, or book a lorry for the whole load."
							: "Compare the prices below, pick a partner, then book the pickup.";

	/**
	 * The page the customer watches, as opposed to `trackingUrl`, which is the
	 * carrier's own. Absolute on copy: a link pasted into WhatsApp needs a host.
	 */
	const customerLink = `/en/track/${delivery.publicToken}`;

	const subhead = [
		delivery.splitFromNumber !== null
			? `Split from #${delivery.splitFromNumber}`
			: null,
		`Created ${shortTime(delivery.createdAt)}`,
		delivery.scheduledAt
			? `scheduled ${shortTime(delivery.scheduledAt)}`
			: "not scheduled",
	]
		.filter(Boolean)
		.join(" · ");

	const details = [
		{ label: "Phone", value: delivery.customerPhone },
		{
			label: "Scheduled",
			value: delivery.scheduledAt
				? shortTime(delivery.scheduledAt)
				: "Not scheduled",
		},
		{ label: "Pickup", value: delivery.pickupAddress },
		{ label: "Access", value: delivery.addressNotes ?? "none given" },
		{
			label: "Site pin",
			value:
				delivery.siteLat === null
					? "not found"
					: `${delivery.siteLat}, ${delivery.siteLng}`,
		},
	];

	return (
		<main className={MAIN}>
			{!geocodingConfigured && (
				<p className={WARN}>
					{geocodingFault ?? "Addresses are not looked up here."} Until that is
					fixed, no job can be quoted by anyone — the vehicle partners price by
					coordinate and the parcel partners by postcode, and both come from the
					lookup.
				</p>
			)}

			{easyparcel.appConfigured && !easyparcel.connected && (
				<p className={WARN}>
					EasyParcel is not connected — parcel jobs cannot be quoted.{" "}
					<a
						href="/api/admin/logistics/easyparcel/connect"
						className={`font-semibold underline ${FOCUS}`}
					>
						Connect EasyParcel account
					</a>
				</p>
			)}

			{error && (
				<p role="alert" className={ERROR}>
					{error}
				</p>
			)}

			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0">
					<h1 className="mb-1 font-semibold text-[22px]">
						Delivery #{delivery.number} — {delivery.customerName}
					</h1>
					<p className="text-[13px] text-neutral-500">{subhead}</p>
				</div>
				<div className="flex shrink-0 items-center gap-2.5">
					{EDITABLE.has(delivery.status) && (
						<Link
							href={`/admin/logistics?edit=${delivery.id}`}
							className={`${CHIP} inline-flex items-center`}
						>
							Edit job
						</Link>
					)}
					<span
						className={`rounded-full px-3 py-1.5 font-semibold text-[11px] ${BADGE_TONE[delivery.status]}`}
					>
						{STATUS_LABEL[delivery.status]}
					</span>
				</div>
			</div>

			<div className="flex flex-wrap items-start gap-[18px]">
				<div className="flex min-w-0 flex-[3_1_440px] flex-col gap-[18px]">
					<section className={`${CARD} gap-0.5 px-5 py-[18px]`}>
						<div className="mb-2 flex items-baseline justify-between gap-3">
							<h2 className={EYEBROW}>On the lorry</h2>
							{splittable && (
								<p className="text-[12px] text-neutral-500">
									Tick what should travel separately
								</p>
							)}
						</div>
						{delivery.items.length === 0 && (
							<p className="text-[13px] text-neutral-500">
								Nothing listed yet.
							</p>
						)}
						{shownItems.map((item, index) => {
							const checked = ticked.includes(index);
							const size = `${item.widthMm} × ${item.heightMm} × ${item.depthMm} mm${
								item.weightKg === null ? "" : ` · ${item.weightKg} kg`
							}`;
							const key = `${item.label}-${item.widthMm}-${item.heightMm}-${item.depthMm}`;
							const text = (
								<>
									<span className="min-w-0 flex-1">
										{item.label}{" "}
										<span className="text-[#8a857c]">× {item.qty}</span>
									</span>
									<span className="shrink-0 text-neutral-500 tabular-nums">
										{size}
									</span>
								</>
							);
							// A label only where there is a box to tick — a booked job's
							// rows are read, not chosen.
							if (!splittable) {
								return (
									<div
										key={key}
										className="-mx-2 flex items-center gap-2.5 px-2 py-[7px] text-[13px]"
									>
										{text}
									</div>
								);
							}
							return (
								<label
									key={key}
									className={`-mx-2 flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-[7px] text-[13px] ${
										checked ? "bg-[#f2f7f4]" : ""
									}`}
								>
									<input
										type="checkbox"
										className={`h-4 w-4 shrink-0 cursor-pointer accent-[#1f5138] ${FOCUS}`}
										checked={checked}
										onChange={() =>
											setTicked(
												checked
													? ticked.filter((i) => i !== index)
													: [...ticked, index],
											)
										}
									/>
									{text}
								</label>
							);
						})}
						{itemsCollapsible && (
							<button
								type="button"
								className={TEXT_BUTTON}
								onClick={() => setShowAllItems(!showAllItems)}
							>
								{showAllItems
									? "Show fewer items"
									: `Show all ${delivery.items.length} items (+${delivery.items.length - ITEM_CAP})`}
							</button>
						)}
						<p className="mt-1.5 border-[#ecebe7] border-t pt-2.5 font-semibold text-[13px]">
							{loadLine(delivery.items)}
						</p>
						{/* `wrap-anywhere`, not `truncate`: this is the line a coordinator
						    reads back to a driver, and a pasted Google Maps link has no
						    break opportunity of its own. */}
						<p className="mt-2.5 wrap-anywhere text-[#5c574e] text-[12px]">
							Deliver to: {delivery.siteAddress}
						</p>
						{canSplitNow && (
							<div className="mt-3.5 flex flex-wrap items-center gap-3 border-[#ecebe7] border-t pt-3.5">
								<button
									type="button"
									className={OUTLINE}
									onClick={startSplit}
									disabled={busy !== null}
								>
									Split this job
								</button>
								<span className="text-[12px] text-neutral-500">
									{ticked.length} of {delivery.items.length} items would move to
									a new job
								</span>
							</div>
						)}
					</section>

					{splitting && (
						<section
							className={`${CARD} gap-4 border-[1.5px] border-[#1f5138] px-[22px] py-5`}
						>
							<div>
								<h2 className="mb-1 font-semibold text-[13px]">
									Split #{delivery.number} into two jobs
								</h2>
								<p className="text-[12px] text-neutral-500 leading-[18px]">
									Each half is quoted and booked on its own. Nothing is sent to
									a carrier by splitting, and #{delivery.number} itself goes
									away — it never reached one.
								</p>
							</div>
							<div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-3">
								{[
									{ title: "Moves to a new job", items: moved },
									{ title: "Stays together", items: kept },
								].map((half) => (
									<div
										key={half.title}
										className="rounded-xl border border-neutral-200 bg-[#faf9f7] px-4 py-3.5"
									>
										<p className="font-semibold text-[13px]">
											{half.title}
											{half.items.length > 0 &&
												` · ${canGoByParcel(half.items) ? "Parcel half" : "Lorry half"}`}
										</p>
										<p className="mt-[3px] mb-2.5 text-[#8a857c] text-[11px]">
											Split from #{delivery.number}
										</p>
										{half.items.map((item) => (
											<p
												key={`${item.label}-${item.widthMm}-${item.heightMm}`}
												className="mb-1 text-[12px] text-neutral-700"
											>
												{item.label}{" "}
												<span className="text-[#8a857c]">× {item.qty}</span>
											</p>
										))}
										{half.items.length === 0 && (
											<p className="mb-1 text-[#7a5a12] text-[12px]">
												Nothing on this half — tick fewer items, or more.
											</p>
										)}
										<p className="mt-2.5 border-[#ecebe7] border-t pt-[9px] font-semibold text-[12px]">
											{half.items.length === 0 ? "—" : loadLine(half.items)}
										</p>
										<p className="mt-1 text-[12px] text-neutral-500 leading-[17px]">
											{partnerSentence(half.items)}
										</p>
									</div>
								))}
							</div>
							<div className="flex flex-wrap items-center gap-2.5">
								<button
									type="button"
									className={PRIMARY}
									disabled={
										moved.length === 0 || kept.length === 0 || busy !== null
									}
									onClick={commitSplit}
								>
									{busy === "split" ? "Splitting…" : "Split into two jobs"}
								</button>
								<button
									type="button"
									className={CHIP}
									onClick={() => setSplitting(false)}
								>
									Cancel
								</button>
							</div>
						</section>
					)}

					{!booked &&
						(["site", "pickup"] as const).map((stop) => {
							const state = pinState(
								stop === "site" ? delivery.siteLat : delivery.pickupLat,
								geocodingConfigured,
							);
							if (state === "located") return null;
							return (
								<p
									key={stop}
									className="text-[#7a5a12] text-[12px] leading-[18px]"
								>
									The {stop} address {PIN_TROUBLE[state].reason} Vehicle
									partners price by coordinate, so only own lorry can be booked.{" "}
									{PIN_TROUBLE[state].action}
								</p>
							);
						})}

					{!splitting && (
						<section className={`${CARD} gap-4 px-[22px] py-5`}>
							{!stopped && <ProcessSteps stage={stage} />}

							<p
								className={`flex items-start gap-2.5 rounded-[10px] border px-3.5 py-[11px] text-[12px] leading-[18px] ${
									stopped
										? STOPPED_TONE[delivery.status]
										: booked
											? "border-[#bcd0c3] bg-[#f2f7f4] text-[#17402c]"
											: "border-neutral-200 bg-[#f8f7f4] text-neutral-700"
								}`}
							>
								<span className="shrink-0 font-bold">
									{stopped
										? STATUS_LABEL[delivery.status]
										: booked
											? "Done"
											: `Step ${stage + 1} of 3`}
								</span>
								<span>{guide}</span>
							</p>

							{!booked && (
								<div className="flex flex-col gap-3">
									<button
										type="button"
										className={`${CHIP} self-start`}
										onClick={compare}
										disabled={busy !== null}
									>
										{quotes === null ? "Compare partners" : "Compare again"}
									</button>

									{busy === "compare" && (
										<Working>Asking every partner what this job costs…</Working>
									)}

									{quotes !== null && quotes.length === 0 && (
										<p className="text-[13px] text-neutral-500">
											No logistics partner is configured yet. Add a partner's
											credentials to compare real prices — until then, book the
											job as own lorry and record it by hand.
										</p>
									)}

									{quotes !== null && quotes.length > 0 && busy === null && (
										<div className="flex flex-col gap-2">
											{quotes.map((quote) => {
												const active = selected === quote.carrierId;
												const failed = quote.error !== undefined;
												const tag = tags[quote.carrierId];
												// This partner could take part of the load but refused
												// the whole of it — the row where splitting is the answer.
												const offerSplit =
													failed &&
													mixedLoad &&
													KIND[quote.carrierId] === "parcel";
												const eta = etaLabel(quote.etaMinutes);
												return (
													<div
														key={quote.carrierId}
														className={`flex flex-col rounded-xl border-[1.5px] ${
															active
																? "border-[#1f5138] bg-[#f2f7f4]"
																: "border-neutral-200 bg-white"
														} ${failed && !offerSplit ? "opacity-70" : ""}`}
													>
														<button
															type="button"
															aria-pressed={active}
															disabled={failed}
															onClick={() => setSelected(quote.carrierId)}
															className={`flex w-full flex-col gap-1 rounded-xl px-4 py-3 text-left disabled:cursor-not-allowed ${FOCUS}`}
														>
															<span className="flex w-full items-center gap-2">
																<span
																	className={`h-2 w-2 shrink-0 rounded-full ${active ? "bg-[#1f5138]" : "bg-[#c7c7c5]"}`}
																/>
																<span className="font-semibold text-[13px]">
																	{carrierLabel(quote.carrierId)}
																</span>
																{tag && (
																	<span
																		className={`shrink-0 rounded-full px-2 py-[3px] font-bold text-[10px] ${
																			tag === "Cheapest"
																				? "bg-[#eef3ef] text-[#1f5138]"
																				: "bg-[#f2efe6] text-[#6b5f2e]"
																		}`}
																	>
																		{tag}
																	</span>
																)}
																<span className="ml-auto shrink-0 font-semibold text-[13px] tabular-nums">
																	{failed
																		? "—"
																		: quote.priceRm === null
																			? "Price agreed by phone"
																			: `RM ${quote.priceRm}`}
																</span>
															</span>
															{quote.notes && (
																<span className="pl-[18px] text-[#8a857c] text-[11px]">
																	{quote.notes}
																</span>
															)}
															{quote.warning && (
																<span className="pl-[18px] text-[#8a6d1f] text-[11px]">
																	{quote.warning}
																</span>
															)}
															<span className="flex items-center gap-2 pl-[18px] text-[11px]">
																{quote.error ? (
																	<span className="text-[#7a2c1c]">
																		{quote.error}
																	</span>
																) : eta !== null ? (
																	<span className="text-[#8a857c]">{eta}</span>
																) : null}
																{active && (
																	<span className="font-semibold text-[#1f5138]">
																		Selected
																	</span>
																)}
															</span>
														</button>
														{offerSplit && (
															<div className="mx-4 mb-3 flex flex-wrap items-center gap-2.5 pl-[18px]">
																<button
																	type="button"
																	className={OUTLINE}
																	onClick={startSplit}
																>
																	Split this job
																</button>
																<span className="text-[#8a857c] text-[11px]">
																	Send the hardware by parcel and keep the
																	carcasses on a lorry.
																</span>
															</div>
														)}
													</div>
												);
											})}
										</div>
									)}

									{busy === "book" && (
										<Working>
											Booking with {carrierLabel(choice?.carrierId)} — creating
											the job…
										</Working>
									)}

									{choice && busy === null && (
										<div className="flex flex-col gap-2.5">
											<ActorField
												label="Your name — recorded against the booking"
												value={actor}
												onChange={rememberActor}
											/>
											<button
												type="button"
												className={`${PRIMARY} min-h-10 px-[22px] py-[11px] text-[13px]`}
												disabled={actorMissing}
												onClick={book}
											>
												Book pickup with {carrierLabel(choice.carrierId)}
												{choice.priceRm === null
													? ""
													: ` — RM ${choice.priceRm}`}{" "}
												→
											</button>
											<p className="text-[12px] text-neutral-500">
												This books a real vehicle with the partner.
											</p>
										</div>
									)}
								</div>
							)}

							{booked && (
								<div className="flex flex-col gap-4 border-[#ecebe7] border-t pt-[18px]">
									<div className="flex flex-wrap items-start justify-between gap-4">
										<div>
											<h2 className={`${EYEBROW} mb-1`}>Shipment tracking</h2>
											<p className="text-[#5c574e] text-[13px]">
												{carrierLabel(delivery.carrierId)} ·{" "}
												<span className="font-mono">
													{delivery.carrierOrderId}
												</span>
											</p>
										</div>
										<div className="text-right">
											<p className="mb-[3px] text-[#8a857c] text-[11px]">
												Scheduled
											</p>
											<p className="font-semibold text-[13px]">
												{delivery.scheduledAt
													? shortTime(delivery.scheduledAt)
													: "—"}
											</p>
										</div>
									</div>

									<div className={`flex ${stopped ? "opacity-60" : ""}`}>
										{steps.map((step, i) => (
											<div
												key={step.status}
												className="flex min-w-0 flex-1 flex-col items-center"
											>
												<div className="flex w-full items-center">
													<div
														className={`h-0.5 flex-1 ${
															i === 0
																? "bg-transparent"
																: step.state === "pending"
																	? "bg-neutral-200"
																	: "bg-[#1f5138]"
														}`}
													/>
													<span
														className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border-2 text-[12px] text-white ${
															step.state === "pending"
																? "border-neutral-300 bg-neutral-300"
																: "border-[#1f5138] bg-[#1f5138]"
														} ${step.state === "active" ? "ring-[3px] ring-[#dbe8e0]" : ""}`}
													>
														{step.state === "done" ? "✓" : ""}
													</span>
													<div
														className={`h-0.5 flex-1 ${
															i === steps.length - 1
																? "bg-transparent"
																: steps[i + 1].state === "pending"
																	? "bg-neutral-200"
																	: "bg-[#1f5138]"
														}`}
													/>
												</div>
												<p
													className={`mt-2.5 mb-0.5 text-center font-semibold text-[12px] ${
														step.state === "pending"
															? "text-[#a3a19b]"
															: "text-neutral-900"
													}`}
												>
													{step.label}
												</p>
												<p className="text-center text-[#8a857c] text-[11px]">
													{step.at ? shortTime(step.at) : "—"}
												</p>
											</div>
										))}
									</div>

									{stopped && (
										<p
											className={`rounded-[9px] border px-3 py-2.5 text-[12px] ${STOPPED_TONE[delivery.status]}`}
										>
											{STATUS_LABEL[delivery.status]}
											{stoppedAt ? ` ${shortTime(stoppedAt)}` : ""} — the stops
											above are where it got to. No further updates will come
											from {carrierLabel(delivery.carrierId)}.
										</p>
									)}

									<div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-neutral-500">
										<span>
											{delivery.quotedPriceRm !== null
												? `RM ${delivery.quotedPriceRm}`
												: "Price agreed by phone"}
										</span>
										<span>Booked by {delivery.bookedBy ?? "—"}</span>
										{/* A parcel network never says who is carrying the parcel,
										    so only a vehicle partner gets a driver line at all. */}
										{KIND[delivery.carrierId ?? ""] === "vehicle" &&
											(delivery.driverName || delivery.vehiclePlate ? (
												<span className="text-neutral-900">
													Driver {delivery.driverName ?? "—"}
													{delivery.driverPhone
														? ` · ${delivery.driverPhone}`
														: ""}
													{delivery.vehiclePlate
														? ` · ${delivery.vehiclePlate}`
														: ""}
												</span>
											) : (
												<span>No driver assigned yet</span>
											))}
										<span>
											{KIND[delivery.carrierId ?? ""] !== "vehicle"
												? "This partner does not report a position."
												: delivery.lastLatitude === null
													? "No position reported yet."
													: `Last seen ${delivery.lastLatitude}, ${delivery.lastLongitude}${
															delivery.lastLocationAt
																? ` at ${timeLabel(delivery.lastLocationAt)}`
																: ""
														}`}
										</span>
									</div>

									{delivery.trackingUrl && (
										<CopyRow
											href={delivery.trackingUrl}
											label="Copy carrier tracking link"
											copied={copied === "carrier"}
											onCopy={() => {
												if (delivery.trackingUrl)
													copy(delivery.trackingUrl, "carrier");
											}}
										>
											{delivery.trackingUrl}
										</CopyRow>
									)}

									<CopyRow
										href={customerLink}
										label="Copy customer tracking link"
										copied={copied === "customer"}
										onCopy={() =>
											copy(
												new URL(
													customerLink,
													window.location.origin,
												).toString(),
												"customer",
											)
										}
									>
										Customer tracking page
									</CopyRow>

									{delivery.carrierId === "gdex" && !stopped && (
										<div className="flex items-center gap-2.5 rounded-[9px] border border-[#cddcd3] bg-[#f2f7f4] px-3 py-2.5">
											<span className="flex-1 text-[#1a4a33] text-[12px]">
												{pickup === null
													? "GDEX schedules the collection on their own board. Check that it landed."
													: pickup.message}
												{pickup?.collectingOn
													? ` · collecting ${pickup.collectingOn}`
													: ""}
											</span>
											<button
												type="button"
												className={`min-h-9 shrink-0 px-2 font-semibold text-[#1f5138] text-[12px] ${FOCUS}`}
												onClick={checkPickup}
												disabled={busy !== null}
											>
												{busy === "pickup"
													? "Checking…"
													: pickup === null
														? "Check collection"
														: "Check again"}
											</button>
										</div>
									)}

									{/* The note has to be on the box before the driver arrives, so
									    it is shown here rather than behind a link. GDEX serves the
									    PDF only while the shipment is pending — this is the copy
									    taken at booking time. */}
									{delivery.labelUrl && (
										<div className="flex flex-col gap-3 rounded-xl border border-[#ecebe7] bg-[#faf9f7] px-4 py-3.5">
											<div className="flex flex-wrap items-baseline justify-between gap-3">
												<h3 className={EYEBROW}>Consignment note</h3>
												<p className="font-mono text-[#8a857c] text-[11px]">
													{delivery.carrierOrderId}.pdf
												</p>
											</div>
											<iframe
												ref={labelFrame}
												title={`Consignment note ${delivery.carrierOrderId}`}
												src={delivery.labelUrl}
												className="h-[230px] w-full rounded-lg border border-neutral-200 bg-white"
											/>
											<div className="flex flex-wrap gap-2">
												<button
													type="button"
													className={PRIMARY}
													onClick={() =>
														labelFrame.current?.contentWindow?.print()
													}
												>
													Print note
												</button>
												<a
													className={`${CHIP} inline-flex items-center`}
													href={delivery.labelUrl}
													target="_blank"
													rel="noreferrer"
												>
													Open in new tab
												</a>
											</div>
										</div>
									)}

									{delivery.carrierId === "gdex" &&
										delivery.labelUrl === null && (
											<p className={`${WARN} text-[12px] leading-[18px]`}>
												The consignment note was not captured when this job was
												booked, so it cannot be shown here. Print it from the
												GDEX portal — GDEX only serves the PDF while the
												shipment is pending.
											</p>
										)}

									<ActorField
										label="Your name — recorded against every update"
										value={actor}
										onChange={rememberActor}
									/>

									<div className="flex flex-wrap gap-2">
										<button
											type="button"
											className={CHIP}
											onClick={refreshFromCarrier}
											disabled={busy === "track"}
										>
											{busy === "track"
												? "Asking carrier…"
												: "Refresh from carrier"}
										</button>
										{nextStep && (
											<button
												type="button"
												className={CHIP}
												onClick={() => advance(nextStep)}
												disabled={actorMissing || busy === nextStep}
											>
												Mark {STATUS_LABEL[nextStep].toLowerCase()}
											</button>
										)}
										{ACTIVE.includes(delivery.status) && (
											<button
												type="button"
												className={CHIP}
												onClick={() => advance("CANCELLED")}
												disabled={actorMissing}
											>
												Cancel job
											</button>
										)}
									</div>
									{actorMissing && (nextStep || !stopped) && (
										<p className="text-[#7a5a12] text-[12px]">
											Put your name in the field above — it goes on the record.
										</p>
									)}
								</div>
							)}
						</section>
					)}
				</div>

				<aside className="flex min-w-0 flex-[1_1_268px] flex-col gap-3.5 self-start lg:sticky lg:top-4">
					<section className={`${CARD} gap-2.5 px-[18px] py-4`}>
						<h2 className={EYEBROW}>Job details</h2>
						{details.map((detail) => (
							<div key={detail.label} className="flex flex-col gap-0.5">
								<span className="text-[#8a857c] text-[11px]">
									{detail.label}
								</span>
								<span className="wrap-anywhere text-[12px] text-neutral-700 leading-[17px]">
									{detail.value}
								</span>
							</div>
						))}
					</section>

					<section className={`${CARD} gap-2.5 px-[18px] py-4`}>
						<div className="flex items-baseline justify-between gap-2.5">
							<h2 className={EYEBROW}>Activity</h2>
							<span className="text-[#8a857c] text-[11px]">
								{events.length} {events.length === 1 ? "update" : "updates"}
							</span>
						</div>
						<p className="rounded-[9px] bg-[#faf9f7] px-[11px] py-[9px] text-[12px] text-neutral-700 leading-[17px]">
							{events.length === 0
								? "No activity yet."
								: `${events[0].message} · ${shortTime(events[0].at)}`}
						</p>
						<div
							className={`flex flex-col gap-3 ${
								showAllEvents ? "max-h-[340px] overflow-y-auto pr-1" : ""
							}`}
						>
							{groups.map((group) => (
								<div key={group.day} className="flex flex-col gap-[9px]">
									<p className="font-bold text-[#a3a19b] text-[10px] uppercase tracking-[.08em]">
										{group.day}
									</p>
									{group.events.map((event) => (
										<div key={event.id} className="flex items-start gap-2.5">
											<span
												className={`mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full ${
													event.source === "ADMIN"
														? "bg-neutral-300"
														: "bg-[#1f5138]"
												}`}
											/>
											<div className="min-w-0 flex-1">
												<p className="mb-0.5 text-[12px] leading-[17px]">
													{event.message}
												</p>
												<p className="text-[#8a857c] text-[11px]">
													{timeLabel(event.at)}
													{event.actor ? ` · ${event.actor}` : ""} ·{" "}
													{event.source.toLowerCase().replace("_", " ")}
												</p>
											</div>
										</div>
									))}
								</div>
							))}
						</div>
						{eventsCollapsible && (
							<button
								type="button"
								className={TEXT_BUTTON}
								onClick={() => setShowAllEvents(!showAllEvents)}
							>
								{showAllEvents
									? "Show recent only"
									: `Show all ${events.length} updates`}
							</button>
						)}
					</section>
				</aside>
			</div>
		</main>
	);
}
