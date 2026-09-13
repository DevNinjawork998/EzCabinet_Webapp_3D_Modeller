"use client";

import { useEffect, useId, useState } from "react";
import { ImageSlot } from "@/components/admin/ImageSlot";
import { fieldClass } from "@/components/admin/styles";
import { finishSlot } from "@/lib/catalogue/siteImages";
import { constructionOf, ratesOf } from "@/lib/planner/catalogue";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";
import { DEFAULT_FINISH_TEXTURES } from "@/lib/planner/finishTextures";

/**
 * Everything in the planner catalogue that is not a cabinet: door styles and
 * their surcharges, finishes, rates, build standards and room walls.
 *
 * Cabinets come from the design library rows; these come from the published
 * catalogue and are edited in place on `draft`, which the design library page
 * holds until the admin publishes. Moved here from the old `/admin/catalogue`
 * editor so there is one screen for the whole catalogue.
 */

export type SettingsTab = "doors" | "finishes" | "standards";

type Edit = (mutate: (next: PlannerCatalogue) => void) => void;

function Num({
	label,
	value,
	onChange,
	width = "w-24",
	min = 0,
}: {
	label?: string;
	value: number;
	onChange: (n: number) => void;
	width?: string;
	min?: number;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1">
			{label && (
				<label htmlFor={id} className="text-[11px] text-neutral-500">
					{label}
				</label>
			)}
			<input
				id={id}
				type="number"
				value={Number.isFinite(value) ? value : ""}
				min={min}
				onChange={(e) => onChange(Number(e.target.value))}
				className={fieldClass(
					!Number.isFinite(value) || value < min,
					`${width} tabular-nums`,
				)}
			/>
		</div>
	);
}

function Text({
	label,
	value,
	onChange,
	width = "w-48",
	placeholder,
}: {
	label?: string;
	value: string;
	onChange: (v: string) => void;
	width?: string;
	placeholder?: string;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1">
			{label && (
				<label htmlFor={id} className="text-[11px] text-neutral-500">
					{label}
				</label>
			)}
			<input
				id={id}
				value={value}
				placeholder={placeholder}
				aria-label={label ? undefined : placeholder}
				onChange={(e) => onChange(e.target.value)}
				className={fieldClass(!value.trim(), width)}
			/>
		</div>
	);
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The finish colour as something you can paste into.
 *
 * `<input type="color">` alone can only be *picked*. A supplier gives the
 * colour as a number — Max World's MW 13526 NW is #cc9168 — and this takes a
 * pasted "cc9168" without the hash because that is how they arrive.
 *
 * Typing is held locally so a half-finished "#cc9" never reaches the draft —
 * only a complete hex commits. The draft can still change underneath, so the
 * local copy follows it back.
 */
function HexField({
	value,
	label,
	onChange,
}: {
	value: string;
	label: string;
	onChange: (hex: string) => void;
}) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	const valid = HEX.test(text);
	return (
		<input
			value={text}
			aria-label={`${label} hex colour`}
			spellCheck={false}
			placeholder="#cc9168"
			onChange={(e) => {
				const typed = e.target.value.trim();
				const hex = typed === "" || typed.startsWith("#") ? typed : `#${typed}`;
				setText(hex);
				if (HEX.test(hex)) onChange(hex.toLowerCase());
			}}
			// Red rather than silently ignored: the colour on screen is still the
			// last good one, so without this the field looks accepted and is not.
			className={`w-24 rounded border px-2 py-1.5 font-mono text-[12px] ${
				valid
					? "border-neutral-300 text-neutral-500"
					: "border-red-400 text-red-600"
			}`}
		/>
	);
}

function SectionCard({
	title,
	subtitle,
	children,
	onRemove,
}: {
	title: string;
	subtitle?: string;
	children: React.ReactNode;
	onRemove?: () => void;
}) {
	return (
		<div className="rounded-lg border border-neutral-200 bg-white p-4">
			<div className="mb-3 flex items-start justify-between gap-3">
				<div>
					<p className="font-medium text-sm">{title}</p>
					{subtitle && (
						<p className="mt-0.5 text-[12px] text-neutral-500">{subtitle}</p>
					)}
				</div>
				{onRemove && (
					<button
						type="button"
						onClick={onRemove}
						className="shrink-0 text-[12px] text-red-600 hover:underline"
					>
						Remove
					</button>
				)}
			</div>
			{children}
		</div>
	);
}

export function CatalogueSettings({
	tab,
	draft,
	editAction: edit,
	finishPhotos,
	onPhotosChangeAction,
}: {
	tab: SettingsTab;
	draft: PlannerCatalogue;
	/** Applies a change to `draft`; the page owns the state. */
	editAction: Edit;
	/** `finish:<id>` → uploaded photo URL. Live the moment it is dropped, so it
	 * is not part of `draft`. */
	finishPhotos: Record<string, string>;
	onPhotosChangeAction: () => void;
}) {
	if (tab === "doors") {
		return (
			<div className="flex flex-col gap-3">
				<p className="text-[12px] text-neutral-500">
					A cabinet&rsquo;s price already includes its door. These are what a
					customer pays <em>on top</em> for each front — set the base look to RM
					0. A cabinet between two widths is charged at the next width up.
				</p>
				<SectionCard
					title="Door width ladder"
					subtitle="Surcharges round up to the next width on this ladder."
				>
					<div className="flex flex-wrap items-center gap-2">
						{draft.doorWidthLadderMm.map((mm, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: a ladder rung is a bare number with no id; the input is fully controlled from `draft`, so index keys can't strand stale state here.
								key={`rung-${mm}-${i}`}
								className="flex items-center gap-1"
							>
								<Num
									value={mm}
									min={1}
									width="w-20"
									onChange={(v) =>
										edit((n) => {
											n.doorWidthLadderMm[i] = v;
										})
									}
								/>
								{draft.doorWidthLadderMm.length > 1 && (
									<button
										type="button"
										onClick={() =>
											edit((n) => {
												n.doorWidthLadderMm.splice(i, 1);
											})
										}
										className="text-[12px] text-neutral-400 hover:text-red-600"
									>
										Remove
									</button>
								)}
							</div>
						))}
						<button
							type="button"
							onClick={() =>
								edit((n) => {
									n.doorWidthLadderMm.push(
										(n.doorWidthLadderMm.at(-1) ?? 600) + 100,
									);
								})
							}
							className="text-[12px] text-[#2b6cb0] hover:underline"
						>
							+ Add
						</button>
					</div>
				</SectionCard>

				{draft.doorStyles.map((style, di) => (
					<SectionCard
						key={style.id}
						title={style.label || "Untitled door"}
						subtitle={`Drawn as ${style.look}${di === 0 ? " · placed cabinets start with this one" : ""}`}
						onRemove={
							draft.doorStyles.length > 1
								? () =>
										edit((n) => {
											n.doorStyles.splice(di, 1);
										})
								: undefined
						}
					>
						<div className="flex flex-wrap items-end gap-3">
							<Text
								label="Name"
								width="w-40"
								value={style.label}
								onChange={(v) =>
									edit((n) => {
										n.doorStyles[di].label = v;
									})
								}
							/>
							<div className="flex flex-col gap-1">
								<label
									htmlFor={`look-${style.id}`}
									className="text-[11px] text-neutral-500"
								>
									Look
								</label>
								<select
									id={`look-${style.id}`}
									value={style.look}
									onChange={(e) =>
										edit((n) => {
											n.doorStyles[di].look = e.target.value as
												| "slab"
												| "shaker"
												| "glass";
										})
									}
									className={fieldClass(false, "bg-white")}
								>
									<option value="slab">Slab</option>
									<option value="shaker">Shaker</option>
									<option value="glass">Glass</option>
								</select>
							</div>
						</div>
						<div className="mt-3 border-neutral-100 border-t pt-3">
							<p className="mb-2 text-[11px] text-neutral-500 uppercase tracking-wide">
								Surcharge per width (RM)
							</p>
							<div className="flex flex-wrap gap-3">
								{draft.doorWidthLadderMm.map((mm) => (
									<Num
										key={`${style.id}-${mm}`}
										label={`${mm}mm`}
										width="w-20"
										value={style.priceRmBySizeMm[String(mm)] ?? 0}
										onChange={(v) =>
											edit((n) => {
												n.doorStyles[di].priceRmBySizeMm[String(mm)] = v;
											})
										}
									/>
								))}
							</div>
						</div>
					</SectionCard>
				))}
				<button
					type="button"
					onClick={() =>
						edit((n) => {
							n.doorStyles.push({
								id: `door-${Date.now()}`,
								label: "New door",
								look: "slab",
								priceRmBySizeMm: Object.fromEntries(
									n.doorWidthLadderMm.map((mm) => [String(mm), 0]),
								),
							});
						})
					}
					className="self-start rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm hover:border-neutral-500"
				>
					+ Add door style
				</button>
			</div>
		);
	}

	if (tab === "finishes") {
		return (
			<SectionCard
				title="Finishes"
				subtitle="One colour applies to a whole room, which is how they're sold."
			>
				{/* The photo and the colour are two answers to the same question, but
				    they do not travel together: finish edits wait for Publish, a
				    dropped photo is live at once. */}
				<p className="mb-3 text-[12px] text-neutral-500">
					Drop the supplier&rsquo;s board scan on a swatch to use the real
					material: it becomes the door and end-panel surface in 3D, the chip in
					the planner&rsquo;s finish picker, and the swatch on the homepage.
					Without one the finish is drawn as its flat colour everywhere. Photos
					go live immediately — they are not held for publish.
				</p>
				<div className="flex flex-col gap-2">
					{draft.finishes.map((finish, i) => {
						const board =
							finishPhotos[finishSlot(finish.id)] ??
							DEFAULT_FINISH_TEXTURES[finish.id] ??
							null;
						return (
							<div key={finish.id} className="flex items-center gap-2">
								<div className="w-[54px] shrink-0">
									<ImageSlot
										slotKey={finishSlot(finish.id)}
										placeholder="Board"
										url={board}
										height={40}
										radius={6}
										onChangeAction={onPhotosChangeAction}
									/>
								</div>
								<input
									type="color"
									aria-label={`${finish.label} colour`}
									value={finish.hex}
									onChange={(e) =>
										edit((n) => {
											n.finishes[i].hex = e.target.value;
										})
									}
									className="h-9 w-12 cursor-pointer rounded border border-neutral-300"
								/>
								<Text
									width="w-52"
									placeholder="Name"
									value={finish.label}
									onChange={(v) =>
										edit((n) => {
											n.finishes[i].label = v;
										})
									}
								/>
								<HexField
									value={finish.hex}
									label={finish.label}
									onChange={(hex) =>
										edit((n) => {
											n.finishes[i].hex = hex;
										})
									}
								/>
								{!board && (
									<span className="text-[11px] text-neutral-400">
										no board · flat colour
									</span>
								)}
								{draft.finishes.length > 1 && (
									<button
										type="button"
										onClick={() =>
											edit((n) => {
												n.finishes.splice(i, 1);
											})
										}
										className="text-[12px] text-neutral-400 hover:text-red-600"
									>
										Remove
									</button>
								)}
							</div>
						);
					})}
					<button
						type="button"
						onClick={() =>
							edit((n) => {
								n.finishes.push({
									id: `finish-${Date.now()}`,
									label: "New finish",
									hex: "#cccccc",
								});
							})
						}
						className="self-start text-[12px] text-[#2b6cb0] hover:underline"
					>
						+ Add finish
					</button>
				</div>
			</SectionCard>
		);
	}

	const construction = constructionOf(draft);
	return (
		<div className="flex flex-col gap-3">
			<SectionCard
				title="Rates"
				subtitle="Charged on top of the per-cabinet prices."
			>
				<div className="flex flex-wrap gap-4">
					<Num
						label="Worktop RM per running foot"
						value={ratesOf(draft).worktopRmPerFt}
						onChange={(v) =>
							edit((n) => {
								n.rates = { ...n.rates, worktopRmPerFt: v };
							})
						}
					/>
					<Num
						label="Delivery RM per order"
						value={ratesOf(draft).deliveryFlatRm}
						onChange={(v) =>
							edit((n) => {
								n.rates = {
									worktopRmPerFt: ratesOf(n).worktopRmPerFt,
									...n.rates,
									deliveryFlatRm: v,
								};
							})
						}
					/>
				</div>
			</SectionCard>

			<SectionCard
				title="Build standards"
				subtitle="Workshop defaults — these change how cabinets without a drawn model are drawn."
			>
				<div className="flex flex-wrap gap-4">
					{(
						[
							["panelThicknessMm", "Board thickness mm"],
							["plinthHeightMm", "Plinth height mm"],
							["worktopThicknessMm", "Worktop thickness mm"],
							["doorLeavesThresholdMm", "Two doors above mm"],
						] as const
					).map(([key, label]) => (
						<Num
							key={key}
							label={label}
							value={construction[key]}
							min={key === "plinthHeightMm" ? 0 : 1}
							onChange={(v) =>
								edit((n) => {
									n.construction = { ...constructionOf(n), [key]: v };
								})
							}
						/>
					))}
				</div>
			</SectionCard>

			<SectionCard
				title="Room walls"
				subtitle="How wide each room's wall is when a customer opens it."
			>
				<div className="flex flex-wrap gap-4">
					{draft.roomTypes.map((room, ri) => (
						<Num
							key={room.id}
							label={`${room.label} mm`}
							value={room.defaultWallWidthMm}
							min={1}
							onChange={(v) =>
								edit((n) => {
									n.roomTypes[ri].defaultWallWidthMm = v;
								})
							}
						/>
					))}
				</div>
			</SectionCard>
		</div>
	);
}
