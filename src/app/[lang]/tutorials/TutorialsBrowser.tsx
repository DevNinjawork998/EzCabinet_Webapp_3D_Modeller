"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import type { Dictionary } from "@/lib/copy/en";
import { fill } from "@/lib/copy/fill";
import {
	CATEGORIES,
	durationLabel,
	type PublicTutorial,
	posterUrl,
} from "@/lib/tutorials";

/**
 * The player is the heaviest thing on this page and nobody needs it until
 * they click a card, so it is loaded on demand. That is the same reasoning
 * `StudioScreen` uses for the 3D scene, and it matters more here: this is a
 * public page on the mobile budget.
 */
const MuxPlayer = dynamic(() => import("@mux/mux-player-react"), {
	ssr: false,
});

const ALL = "all";

/** `CATEGORIES` in `lib/tutorials.ts` carries English admin-form labels; the
 * public page reads the display copy from the dictionary by id instead, so it
 * stays trilingual without duplicating the id list. A tutorial's level is
 * still recorded by the admin but no longer shown here. */
function categoryLabel(t: Dictionary, id: string): string {
	return (
		t.tutorials.categories[id as keyof typeof t.tutorials.categories] ?? id
	);
}

/** The dark plate a card shows before its video exists, or while Mux is still
 * processing it. The page has to look deliberate with no footage at all. */
function VideoPlaceholder({
	className,
	big = false,
	children,
}: {
	className: string;
	big?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<div
			className={`relative flex items-center justify-center bg-neutral-900 ${className}`}
		>
			<div
				className={`flex items-center justify-center rounded-full bg-white/15 ${big ? "h-16 w-16" : "h-11 w-11"}`}
			>
				<svg
					viewBox="0 0 24 24"
					aria-hidden="true"
					className={`ml-0.5 fill-white ${big ? "h-[26px] w-[26px]" : "h-[18px] w-[18px]"}`}
				>
					<path d="M6 4l14 8-14 8V4z" />
				</svg>
			</div>
			{children}
		</div>
	);
}

export function TutorialsBrowser({
	tutorials,
	copy: t,
}: {
	tutorials: PublicTutorial[];
	/** Resolved server-side and passed as a prop: this route mounts no
	 * `CopyProvider`, unlike the planner tree. */
	copy: Dictionary;
}) {
	const [category, setCategory] = useState<string>(ALL);
	const [activeId, setActiveId] = useState<string | null>(null);
	// `filtered.map((t) => …)` below shadows the dictionary `t` with the
	// tutorial item, so the card-badge lookups need their own binding to it.
	const copyT = t;

	// Esc closes the player — the backdrop click is mouse-only.
	useEffect(() => {
		if (!activeId) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setActiveId(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [activeId]);

	const filtered = tutorials.filter(
		(t) => category === ALL || t.category === category,
	);
	const active = tutorials.find((t) => t.id === activeId) ?? null;

	return (
		<>
			{/* Filters */}
			<div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-6 px-8 pb-5">
				<div className="flex flex-wrap gap-2">
					{[{ id: ALL, label: t.tutorials.allTypes }, ...CATEGORIES].map(
						(c) => (
							<button
								key={c.id}
								type="button"
								onClick={() => setCategory(c.id)}
								aria-pressed={category === c.id}
								className={
									category === c.id
										? "rounded-full bg-[#1f5138] px-[15px] py-2 font-medium text-[13px] text-white"
										: "rounded-full border border-neutral-200 bg-white px-[15px] py-2 text-[13px] text-neutral-600 hover:border-neutral-300"
								}
							>
								{c.id === ALL ? c.label : categoryLabel(t, c.id)}
							</button>
						),
					)}
				</div>
			</div>

			{/* Grid */}
			<div className="mx-auto w-full max-w-[1180px] flex-1 px-8 pt-5 pb-18">
				{tutorials.length === 0 ? (
					<div className="rounded-xl border border-neutral-200 bg-white px-6 py-14 text-center text-[14px] text-neutral-500">
						{t.tutorials.emptyNoTutorials}
					</div>
				) : filtered.length > 0 ? (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6">
						{filtered.map((t) => {
							const duration = durationLabel(t.durationSec);
							return (
								<button
									key={t.id}
									type="button"
									onClick={() => setActiveId(t.id)}
									className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-left"
								>
									{t.playbackId ? (
										<div className="relative h-[150px] w-full overflow-hidden bg-neutral-900">
											{/* biome-ignore lint/performance/noImgElement: Mux's
											    image host isn't configured for next/image, and a
											    remote pattern for it is more moving parts than the
											    optimisation buys on an already-optimised WebP. */}
											<img
												src={posterUrl(t.playbackId, {
													durationSec: t.durationSec,
												})}
												alt=""
												loading="lazy"
												className="h-full w-full object-cover"
											/>
											<span className="absolute inset-0 flex items-center justify-center">
												<span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45">
													<svg
														viewBox="0 0 24 24"
														aria-hidden="true"
														className="ml-0.5 h-[18px] w-[18px] fill-white"
													>
														<path d="M6 4l14 8-14 8V4z" />
													</svg>
												</span>
											</span>
											{duration && (
												<span className="absolute right-2.5 bottom-2 rounded-[5px] bg-black/50 px-[7px] py-0.5 text-[11px] text-white">
													{duration}
												</span>
											)}
										</div>
									) : (
										<VideoPlaceholder className="h-[150px] w-full" />
									)}
									<div className="flex flex-1 flex-col gap-2 px-4.5 py-4">
										<div className="flex gap-1.5">
											<span className="rounded-full bg-neutral-100 px-2.5 py-[3px] font-medium text-[11px] text-neutral-600">
												{categoryLabel(copyT, t.category)}
											</span>
										</div>
										<h3 className="font-semibold text-[15px] leading-5">
											{t.title}
										</h3>
										<p className="text-[13px] text-neutral-500 leading-[19px]">
											{t.description}
										</p>
									</div>
								</button>
							);
						})}
					</div>
				) : (
					<div className="rounded-xl border border-neutral-200 bg-white px-6 py-14 text-center text-[14px] text-neutral-500">
						{t.tutorials.emptyNoMatches}
					</div>
				)}
			</div>

			{/* Footer */}
			<div className="mt-auto bg-neutral-900 text-neutral-200">
				<div className="mx-auto flex max-w-[1180px] items-center justify-between px-8 py-7 text-[12px] text-neutral-400">
					<span>{fill(t.tutorials.copyright, { brand: t.common.brand })}</span>
					<Link href="/" className="text-neutral-400">
						{t.tutorials.backToSite}
					</Link>
				</div>
			</div>

			{/* Player */}
			{active && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
					role="dialog"
					aria-modal="true"
					aria-label={active.title}
				>
					{/* The backdrop is a click target, not a control: the ✕ below is the
					    keyboard/screen-reader way out, so this stays a plain div. */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
					<div className="absolute inset-0" onClick={() => setActiveId(null)} />
					<div className="relative w-full max-w-[720px] overflow-hidden rounded-[14px] bg-white">
						{active.playbackId ? (
							<div className="h-[380px] w-full bg-neutral-900">
								<Suspense
									fallback={
										<div className="flex h-full items-center justify-center bg-neutral-900 text-[13px] text-white/60">
											{t.tutorials.loadingPlayer}
										</div>
									}
								>
									<MuxPlayer
										playbackId={active.playbackId}
										streamType="on-demand"
										autoPlay
										accentColor="#2c5f47"
										metadata={{ video_title: active.title }}
										style={{ height: "100%", width: "100%" }}
									/>
								</Suspense>
							</div>
						) : (
							<VideoPlaceholder className="h-[380px] w-full" big />
						)}
						<button
							type="button"
							onClick={() => setActiveId(null)}
							aria-label={t.common.close}
							className="absolute top-3.5 right-3.5 z-10 h-8 w-8 rounded-full bg-black/50 text-[16px] text-white"
						>
							✕
						</button>
						<div className="px-6 py-5">
							<h3 className="mb-1.5 font-semibold text-[17px]">
								{active.title}
							</h3>
							<p className="text-[13px] text-neutral-500 leading-5">
								{active.description}
							</p>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
