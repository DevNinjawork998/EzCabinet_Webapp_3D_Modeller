"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HERO_EXPLODED_FRAME, heroFrameSrc } from "@/lib/scroll/sequence";

export default function AdminLoginPage() {
	const router = useRouter();
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function login() {
		setBusy(true);
		setError(null);
		const res = await fetch("/api/admin/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		});
		setBusy(false);
		if (!res.ok) {
			setError("Wrong password");
			return;
		}
		const next = new URLSearchParams(window.location.search).get("next");
		router.push(next || "/admin/cabinet-designs");
	}

	return (
		<main className="flex min-h-screen bg-[#f4f3f1] text-neutral-900">
			<div className="flex flex-1 items-center justify-center p-10">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						login();
					}}
					className="flex w-full max-w-[340px] flex-col gap-5"
				>
					<div className="mb-1 flex flex-col gap-1.5">
						<span className="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-neutral-900">
							<svg
								width="16"
								height="16"
								viewBox="0 0 16 16"
								fill="none"
								aria-hidden="true"
							>
								<path
									d="M2 6 8 2l6 4v8H2V6Z"
									stroke="#fff"
									strokeWidth="1.3"
									strokeLinejoin="round"
								/>
								<path d="M6 14V9h4v5" stroke="#fff" strokeWidth="1.3" />
							</svg>
						</span>
						<h1 className="mt-2 font-semibold text-[19px]">
							EzCabinet · Admin
						</h1>
						<p className="text-neutral-500 text-sm">
							Sign in to manage cabinet designs and the catalogue.
						</p>
					</div>

					<label className="flex flex-col gap-1.5">
						<span className="font-medium text-neutral-700 text-xs">
							Password
						</span>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							placeholder="Enter admin password"
							className="rounded-[9px] border border-neutral-300 px-3.5 py-2.5 text-sm"
						/>
					</label>

					{error && (
						<p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-red-900 text-sm">
							{error}.
						</p>
					)}

					<button
						type="submit"
						disabled={busy || !password}
						className="rounded-[9px] bg-neutral-900 py-2.5 font-medium text-sm text-white disabled:opacity-60"
					>
						{busy ? "Checking…" : "Sign in"}
					</button>

					<Link
						href="/"
						className="text-center text-neutral-500 text-xs hover:text-neutral-900"
					>
						← Back to site
					</Link>

					<p className="text-center text-neutral-400 text-xs">
						Internal tool · EzCabinet staff only
					</p>
				</form>
			</div>

			{/* The panel was an empty grey half-screen. It now carries the same
			    render the homepage scrubs through, stopped on its last frame — the
			    cabinet fully apart. That is the honest picture of what is behind
			    this password: not a kitchen, a catalogue of parts.

			    Static, and one file. There is no sequence here — nothing scrolls
			    on a sign-in screen, and the other seventy-one frames would be
			    1.7 MB spent on a page three people ever see. */}
			<div
				data-cabinet-ground="panel"
				className="relative hidden flex-1 items-center justify-center overflow-hidden md:flex"
			>
				<div
					data-cabinet-stage
					className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute top-1/2 left-1/2 aspect-[16/9] w-[128%] max-w-none"
				>
					{/* biome-ignore lint/performance/noImgElement: ships in the repo,
					    and next/image would only re-encode a JPEG that is already
					    sized for exactly this box */}
					<img
						src={heroFrameSrc(HERO_EXPLODED_FRAME)}
						alt=""
						className="h-full w-full object-contain"
					/>
				</div>

				<div className="absolute bottom-8 left-8 max-w-[320px] rounded-[10px] bg-white/90 px-4 py-3.5">
					<p className="font-semibold text-sm">One catalogue, every planner</p>
					<p className="mt-1 text-[12px] text-neutral-600 leading-[17px]">
						Designs published here appear immediately in the customer planner.
						Archive a design to pull it from view without deleting it.
					</p>
				</div>
			</div>
		</main>
	);
}
