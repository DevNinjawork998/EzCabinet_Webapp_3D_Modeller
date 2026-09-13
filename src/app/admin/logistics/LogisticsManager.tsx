"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { chipClass, fieldClass } from "@/components/admin/styles";
import { LABEL } from "@/lib/logistics/carriers";
import { pinState } from "@/lib/logistics/coords";
import {
	suggestVehicle,
	totalVolumeM3,
	totalWeightKg,
} from "@/lib/logistics/measure";
import { BADGE_TONE } from "./DeliveryDetail";
import { messageFor } from "./errors";
import type { DeliveryRow } from "./form";
import {
	blankForm,
	EDITABLE,
	emptyItem,
	type FormItem,
	type FormState,
	formFrom,
	toPayload,
} from "./form";
import { STATUS_LABEL } from "./tracking";

export type { DeliveryEventRow, DeliveryRow, QuoteRow } from "./form";

/**
 * The deliveries list and the job form. Each job opens on its own page —
 * `DeliveryDetail` — where partners are compared, one is booked, and the job is
 * then followed.
 */
export function LogisticsManager({
	initial,
	workshopAddress,
	geocodingConfigured,
	geocodingFault,
	easyparcel,
}: {
	initial: DeliveryRow[];
	workshopAddress: string;
	geocodingConfigured: boolean;
	/** Why the geocoder is not answering, in Google's own words. Null when it is. */
	geocodingFault: string | null;
	easyparcel: { appConfigured: boolean; connected: boolean };
}) {
	const router = useRouter();
	const [rows, setRows] = useState<DeliveryRow[]>(initial);
	const [form, setForm] = useState<FormState | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Read after mount, not during render: both come from a redirect's query
	// string — the OAuth callback, or a job page's "Edit job" — and
	// `location.search` doesn't exist on the server.
	const [easyparcelResult, setEasyparcelResult] = useState<string | null>(null);
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setEasyparcelResult(params.get("easyparcel"));
		const editing = initial.find((row) => row.id === params.get("edit"));
		if (editing && EDITABLE.has(editing.status)) setForm(formFrom(editing));
	}, [initial]);

	const load = useCallback(async () => {
		const res = await fetch("/api/admin/deliveries");
		if (res.status === 401) {
			router.push("/admin/login");
			return;
		}
		if (!res.ok) {
			setError("Could not load deliveries");
			return;
		}
		const body = await res.json();
		setRows(body.deliveries ?? []);
	}, [router]);

	async function save(state: FormState) {
		setError(null);
		const res = await fetch(
			state.id === null
				? "/api/admin/deliveries"
				: `/api/admin/deliveries/${state.id}`,
			{
				method: state.id === null ? "POST" : "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(toPayload(state)),
			},
		);
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			setError(messageFor(body?.error, "Could not save this delivery"));
			return;
		}
		setForm(null);
		// Straight to the job: comparing partners is the next thing anyone does
		// with a delivery they have just typed in or corrected.
		if (body?.delivery?.id) {
			router.push(`/admin/logistics/${body.delivery.id}`);
			return;
		}
		await load();
	}

	async function remove(row: DeliveryRow) {
		if (!confirm(`Delete delivery ${row.number} for ${row.customerName}?`))
			return;
		const res = await fetch(`/api/admin/deliveries/${row.id}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			setError(messageFor(body?.error, "Could not delete this delivery"));
			return;
		}
		await load();
	}

	return (
		<div className="flex flex-col gap-6">
			{error && (
				<p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
					{error}
				</p>
			)}

			{!geocodingConfigured && (
				<p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
					{/* Named rather than implied: a missing key and a key Google refuses
					    are fixed differently, and the admin cannot tell which they have
					    without being told. */}
					{geocodingFault ?? "Addresses are not looked up here."} Until that is
					fixed, no job can be quoted by anyone — the vehicle partners price by
					coordinate and the parcel partners by postcode, and both come from the
					lookup.
				</p>
			)}

			{!easyparcel.appConfigured && (
				<p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
					EasyParcel is not set up on this deployment.
				</p>
			)}

			{easyparcel.appConfigured && !easyparcel.connected && (
				<p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
					EasyParcel is not connected — parcel jobs cannot be quoted.{" "}
					<a
						href="/api/admin/logistics/easyparcel/connect"
						className="font-semibold underline"
					>
						Connect EasyParcel account
					</a>
				</p>
			)}

			{easyparcelResult === "connected" && (
				<p className="rounded-lg bg-[#e7f0ea] px-3 py-2 text-[13px] text-[#1f5138]">
					EasyParcel account connected.
				</p>
			)}

			{easyparcelResult === "failed" && (
				<p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
					Connecting the EasyParcel account failed — try again.
				</p>
			)}

			<div className="flex items-center justify-between">
				<p className="text-[13px] text-neutral-500">
					{rows.length} {rows.length === 1 ? "delivery" : "deliveries"}
				</p>
				<button
					type="button"
					className={chipClass(form !== null)}
					onClick={() =>
						setForm(form === null ? blankForm(workshopAddress) : null)
					}
				>
					{form === null ? "New delivery" : "Cancel"}
				</button>
			</div>

			{form !== null && (
				<DeliveryForm
					state={form}
					onChange={setForm}
					onSubmit={() => save(form)}
				/>
			)}

			{rows.length === 0 ? (
				<p className="rounded-xl border border-neutral-200 bg-white px-4 py-8 text-center text-[13px] text-neutral-500">
					No deliveries yet. Create one to compare logistics partners.
				</p>
			) : (
				<ul className="flex flex-col gap-2">
					{rows.map((row) => (
						<li
							key={row.id}
							className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3"
						>
							<span className="font-medium text-[13px] text-neutral-400 tabular-nums">
								#{row.number}
							</span>
							<div className="min-w-[160px] flex-1">
								<p className="font-medium text-[14px]">{row.customerName}</p>
								<p className="truncate text-[12px] text-neutral-500">
									{row.siteAddress}
								</p>
							</div>
							{row.splitFromNumber !== null && (
								<span className="text-[12px] text-neutral-500">
									Split from #{row.splitFromNumber}
								</span>
							)}
							<span className="text-[12px] text-neutral-500">
								{row.carrierId ? LABEL[row.carrierId] : "No partner yet"}
							</span>
							<span
								className={`rounded-full px-2.5 py-1 font-medium text-[11px] ${BADGE_TONE[row.status]}`}
							>
								{STATUS_LABEL[row.status]}
							</span>
							{!row.carrierOrderId &&
								(pinState(row.siteLat, geocodingConfigured) !== "located" ||
									pinState(row.pickupLat, geocodingConfigured) !==
										"located") && (
									<span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-[11px] text-amber-800">
										No map pin
									</span>
								)}
							<Link
								href={`/admin/logistics/${row.id}`}
								className={chipClass(false)}
							>
								Open
							</Link>
							{EDITABLE.has(row.status) && (
								<button
									type="button"
									className="text-[12px] text-neutral-400 underline"
									onClick={() => {
										setForm(formFrom(row));
										window.scrollTo({ top: 0, behavior: "smooth" });
									}}
								>
									Edit
								</button>
							)}
							{!row.carrierOrderId && (
								<button
									type="button"
									className="text-[12px] text-neutral-400 underline"
									onClick={() => remove(row)}
								>
									Delete
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function DeliveryForm({
	state,
	onChange,
	onSubmit,
}: {
	state: FormState;
	onChange: (next: FormState) => void;
	onSubmit: () => void;
}) {
	const items = state.items.filter((i) => i.label.trim() !== "");
	const suggestion = suggestVehicle(items);
	const weight = totalWeightKg(items);

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		onChange({ ...state, [key]: value });

	const setItem = (index: number, next: Partial<FormItem>) =>
		onChange({
			...state,
			items: state.items.map((item, i) =>
				i === index ? { ...item, ...next } : item,
			),
		});

	return (
		<form
			className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-4"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
		>
			{state.id !== null && (
				<p className="text-[13px] text-neutral-500">
					Editing <span className="text-neutral-900">{state.customerName}</span>
					. Saving re-checks the address, so a corrected line gets a fresh map
					pin.
				</p>
			)}
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<label className="flex flex-col gap-1 text-[12px] text-neutral-500">
					Customer
					<input
						required
						className={fieldClass(false)}
						value={state.customerName}
						onChange={(e) => set("customerName", e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1 text-[12px] text-neutral-500">
					Phone
					<input
						required
						className={fieldClass(false)}
						value={state.customerPhone}
						onChange={(e) => set("customerPhone", e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1 text-[12px] text-neutral-500 sm:col-span-2">
					Site address
					<input
						required
						className={fieldClass(false)}
						value={state.siteAddress}
						onChange={(e) => set("siteAddress", e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1 text-[12px] text-neutral-500 sm:col-span-2">
					Access notes — gate codes, unit number, who to call
					<input
						className={fieldClass(false)}
						value={state.addressNotes}
						onChange={(e) => set("addressNotes", e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1 text-[12px] text-neutral-500">
					Pickup from
					<input
						required
						className={fieldClass(false)}
						value={state.pickupAddress}
						onChange={(e) => set("pickupAddress", e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1 text-[12px] text-neutral-500">
					Scheduled
					<input
						type="datetime-local"
						className={fieldClass(false)}
						value={state.scheduledAt}
						onChange={(e) => set("scheduledAt", e.target.value)}
					/>
				</label>
			</div>

			<div className="flex flex-col gap-2">
				<p className="font-medium text-[13px]">What is going on the lorry</p>
				{state.items.map((item, i) => (
					<div key={item.uid} className="flex flex-wrap items-end gap-2">
						<label className="flex min-w-[150px] flex-1 flex-col gap-1 text-[11px] text-neutral-500">
							Item
							<input
								className={fieldClass(false)}
								value={item.label}
								onChange={(e) => setItem(i, { label: e.target.value })}
							/>
						</label>
						{(["qty", "widthMm", "heightMm", "depthMm"] as const).map(
							(field) => (
								<label
									key={field}
									className="flex w-[74px] flex-col gap-1 text-[11px] text-neutral-500"
								>
									{field === "qty" ? "Qty" : field.replace("Mm", " mm")}
									<input
										type="number"
										min={1}
										className={fieldClass(false)}
										value={item[field]}
										onChange={(e) =>
											setItem(i, { [field]: Number(e.target.value) })
										}
									/>
								</label>
							),
						)}
						<label className="flex w-[86px] flex-col gap-1 text-[11px] text-neutral-500">
							Weight kg
							<input
								type="number"
								min={0}
								step="0.1"
								placeholder="—"
								className={fieldClass(false)}
								value={item.weightKg ?? ""}
								onChange={(e) =>
									setItem(i, {
										weightKg:
											e.target.value === "" ? null : Number(e.target.value),
									})
								}
							/>
						</label>
						<button
							type="button"
							className="pb-2 text-[12px] text-neutral-400 underline"
							onClick={() =>
								onChange({
									...state,
									items: state.items.filter((_, j) => j !== i),
								})
							}
						>
							Remove
						</button>
					</div>
				))}
				<button
					type="button"
					className={`${chipClass(false)} self-start`}
					onClick={() =>
						onChange({ ...state, items: [...state.items, emptyItem()] })
					}
				>
					Add item
				</button>
			</div>

			<p className="text-[12px] text-neutral-500">
				{totalVolumeM3(items)} m³
				{weight === null ? ", weight not given" : `, ${weight} kg`} —{" "}
				<span className="text-neutral-900">{suggestion.label}</span>. The
				vehicle partners price by distance and do not need a weight. The parcel
				partners price by the kilogram and cannot quote without one.
			</p>

			<button
				type="submit"
				className="self-start rounded-full bg-neutral-900 px-4 py-2 text-[13px] text-white"
			>
				{state.id === null ? "Save delivery" : "Save changes"}
			</button>
		</form>
	);
}
