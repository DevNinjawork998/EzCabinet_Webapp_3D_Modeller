"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import {
	CatalogueSettings,
	type SettingsTab,
} from "@/components/admin/CatalogueSettings";
import { chipClass, fieldClass } from "@/components/admin/styles";
import { buildCatalogue } from "@/lib/catalogue/buildCatalogue";
import {
	CATEGORIES,
	CATEGORY_LABELS,
	CATEGORY_SWATCH,
	type Category,
	ROOM_LABELS,
	ROOMS,
	type Room,
} from "@/lib/catalogue/cabinetDesignLabels";
import { summariseCatalogueChanges } from "@/lib/catalogue/diff";
import { siteImageSrc } from "@/lib/catalogue/siteImages";
import type { DesignMeasurement } from "@/lib/mesh/measureDesign";
import type { PlannerCatalogue } from "@/lib/planner/catalogueSchema";

/**
 * The whole planner catalogue, on one screen.
 *
 * Every uploaded design is one cabinet a customer can place — its own name,
 * all-in price, size and drawn model — filed under the rooms that offer it.
 * The room tabs show exactly what each room sells; the settings tabs hold the
 * rest of the catalogue (door surcharges, finishes, rates). Nothing reaches a
 * customer until Publish, which rebuilds the catalogue from these rows.
 *
 * This replaced a two-screen flow — push a design into a draft here, then
 * review and publish that draft at `/admin/catalogue` — where uploads were
 * folded into families by shape, so three widths of one cabinet appeared as one
 * card carrying another cabinet's prices.
 */

type Status = "PUBLISHED" | "ARCHIVED";

type CabinetDesign = {
	id: string;
	name: string;
	filename: string;
	blobUrl: string;
	blobPathname: string;
	category: Category;
	rooms: Room[];
	widthMm: number;
	heightMm: number;
	depthMm: number;
	priceRm: number;
	weightKg: number | null;
	sku: string;
	description: string | null;
	tags: string | null;
	finishes: string[];
	status: Status;
	/** What the file holds, written on conversion. Null means the file has not
	 * been converted yet — it will be at the next publish. */
	geometry: unknown;
	/** The derived render mesh. Null means the conversion found nothing
	 * drawable, so the planner falls back to procedural geometry. */
	meshPathname: string | null;
	meshBytes: number | null;
	meshGroups:
		| {
				role: string;
				triangles: number;
				/** Doors only: how the leaf will actually behave when a customer
				 * opens it, decided at intake so a wrong reading shows up here
				 * rather than in front of a customer. */
				hingeSide?: "left" | "right" | null;
				fit?: "overlay" | "inset";
		  }[]
		| null;
	updatedAt: string;
};

type Tab = Room | SettingsTab;

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
	{ id: "doors", label: "Door styles" },
	{ id: "finishes", label: "Finishes" },
	{ id: "standards", label: "Rates & build" },
];

const isRoom = (tab: string | null): tab is Room =>
	(ROOMS as string[]).includes(tab ?? "");
const isTab = (tab: string | null): tab is Tab =>
	isRoom(tab) || SETTINGS_TABS.some((t) => t.id === tab);

/** What the planner will draw for this design, in one line. */
function meshSummary(d: CabinetDesign): string {
	if (d.geometry === null) return "converts at next publish";
	if (!d.meshGroups?.length) return "no mesh — drawn procedurally";
	const triangles = d.meshGroups.reduce((n, g) => n + g.triangles, 0);
	const size = d.meshBytes ? ` · ${Math.round(d.meshBytes / 1024)} KB` : "";
	// An inset door hinges on its outer front arris rather than its back face,
	// and opens less far before it binds — worth seeing before publish, because
	// every design so far has been an overlay and a stray inset reading is far
	// more likely a mis-read front side than a real inset cabinet.
	const door = d.meshGroups.find((g) => g.role === "door");
	const swing = door?.fit
		? ` · ${door.fit}${door.hingeSide ? ` · hinged ${door.hingeSide}` : ""}`
		: "";
	return `${triangles.toLocaleString()} tris${size}${swing}`;
}

/**
 * Where a design is, relative to what customers can place right now.
 *
 * Derived by comparing the live catalogue against the one Publish would build,
 * so it can never disagree with the change list in the publish bar.
 */
type Reach = "pending" | "live" | "changed" | "leaving" | "archived";

const REACH_LABEL: Record<Reach, string> = {
	pending: "Not live",
	live: "Live",
	changed: "Live · edited",
	leaving: "Leaves at publish",
	archived: "Archived",
};

const REACH_HINT: Record<Reach, string> = {
	pending: "Customers cannot place this yet. Publish to put it in the planner.",
	live: "Customers can place this cabinet exactly as shown.",
	changed:
		"Live, but your edits to its price, size or rooms reach customers only when you publish.",
	leaving: "Archived, but still in the planner until you publish.",
	archived: "Archived and not in the planner.",
};

const REACH_TONE: Record<Reach, string> = {
	pending: "bg-amber-50 text-amber-700",
	live: "bg-green-50 text-green-700",
	changed: "bg-amber-50 text-amber-700",
	leaving: "bg-amber-50 text-amber-700",
	archived: "bg-neutral-100 text-neutral-500",
};

const FINISH_OPTIONS = ["Slab", "Shaker", "Glass"];

/** What the API's zod schema actually requires, mirrored here so the form
 * can flag missing fields before a round trip — same rules, human labels. */
const REQUIRED_FIELDS: {
	key: "name" | "w" | "h" | "d" | "price" | "sku";
	label: string;
	valid: (value: string) => boolean;
}[] = [
	{ key: "name", label: "Cabinet name", valid: (v) => v.trim().length > 0 },
	{ key: "w", label: "Width", valid: (v) => Number(v) > 0 },
	{ key: "h", label: "Height", valid: (v) => Number(v) > 0 },
	{ key: "d", label: "Depth", valid: (v) => Number(v) > 0 },
	{
		key: "price",
		label: "Price",
		valid: (v) => v.trim() !== "" && Number(v) >= 0,
	},
	{ key: "sku", label: "SKU", valid: (v) => v.trim().length > 0 },
];

type Form = {
	name: string;
	category: Category;
	rooms: Room[];
	w: string;
	h: string;
	d: string;
	price: string;
	/** Blank means not weighed — sent as null, never 0. */
	weight: string;
	sku: string;
	description: string;
	tags: string;
	finishes: string[];
};

function emptyForm(room: Room): Form {
	return {
		name: "",
		category: "BASE_CABINET",
		rooms: [room],
		w: "",
		h: "",
		d: "",
		price: "",
		weight: "",
		sku: "",
		description: "",
		tags: "",
		finishes: ["Slab"],
	};
}

/**
 * Admin-only, and loaded on demand — this is the one component in the app that
 * loads a mesh, and it must never reach a customer's bundle.
 */
const DesignViewer = dynamic(
	() => import("@/components/admin/DesignViewer").then((m) => m.DesignViewer),
	{ ssr: false },
);

/**
 * One file in a multi-file upload.
 *
 * Each file becomes its own cabinet — BC 600, BC 800 and BC 900 are three
 * things a customer can place, each with its own SKU and price. What they
 * share (category, rooms, description) is filled once for the batch.
 */
type BatchRow = {
	file: File;
	measured: DesignMeasurement | null;
	measureError: string | null;
	name: string;
	sku: string;
	price: string;
	/** Filled once the row has been through the API. */
	result: "pending" | "saved" | string;
};

/** A publish offer: what just happened, and anything the conversion noted. */
type Confirm = { title: string; notes: string[] };

const LABEL_CLASS =
	"mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide";
const SELECT_CLASS =
	"w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-sm";

/** Every room a design is offered in. At least one: a cabinet in no room is a
 * cabinet no customer can reach. */
function RoomPicker({
	rooms,
	onChange,
}: {
	rooms: Room[];
	onChange: (rooms: Room[]) => void;
}) {
	return (
		<div>
			<p className={LABEL_CLASS}>Offered in</p>
			<div className="flex flex-wrap gap-1.5">
				{ROOMS.map((room) => {
					const on = rooms.includes(room);
					return (
						<button
							key={room}
							type="button"
							aria-pressed={on}
							onClick={() =>
								onChange(
									on ? rooms.filter((r) => r !== room) : [...rooms, room],
								)
							}
							className={chipClass(on)}
						>
							{ROOM_LABELS[room]}
						</button>
					);
				})}
			</div>
			{rooms.length === 0 && (
				<p className="mt-1 text-[11px] text-red-600">Pick at least one room</p>
			)}
		</div>
	);
}

/**
 * The per-file half of a multi-file upload.
 *
 * Only SKU and price are per row, because only SKU and price genuinely differ
 * between BC 600, BC 800 and BC 900. Dimensions are shown but not editable:
 * they were read off the geometry, and a batch is the wrong place to
 * second-guess a measurement. Upload a file on its own if a number needs
 * correcting.
 */
function BatchFields({
	batch,
	setBatch,
	form,
	setField,
}: {
	batch: BatchRow[];
	setBatch: (rows: BatchRow[]) => void;
	form: Form;
	setField: <K extends keyof Form>(key: K, value: Form[K]) => void;
}) {
	const update = (i: number, patch: Partial<BatchRow>) =>
		setBatch(batch.map((row, n) => (n === i ? { ...row, ...patch } : row)));

	return (
		<>
			<div className="flex flex-col gap-2">
				<p className={LABEL_CLASS}>
					{batch.length} designs — each one its own cabinet
				</p>
				{batch.map((row, i) => (
					<div
						key={row.file.name}
						className="rounded-lg border border-neutral-200 p-2.5"
					>
						<div className="flex items-baseline justify-between gap-2">
							<p className="truncate font-medium text-[13px]">
								{row.file.name}
							</p>
							<p className="shrink-0 text-[11px] text-neutral-500 tabular-nums">
								{row.measured
									? `${row.measured.widthMm} × ${row.measured.heightMm} × ${row.measured.depthMm} mm`
									: (row.measureError ?? "not read")}
							</p>
						</div>
						<div className="mt-1.5 flex gap-2">
							<input
								value={row.sku}
								onChange={(e) => update(i, { sku: e.target.value })}
								placeholder="SKU"
								className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
							/>
							<input
								value={row.price}
								onChange={(e) => update(i, { price: e.target.value })}
								placeholder="RM"
								inputMode="decimal"
								className="w-24 rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
							/>
						</div>
						{row.result !== "pending" && (
							<p
								className={`mt-1.5 text-[11px] ${
									row.result === "saved" ? "text-green-700" : "text-amber-700"
								}`}
							>
								{row.result === "saved" ? "saved" : row.result}
							</p>
						)}
					</div>
				))}
			</div>

			<div>
				<p className={LABEL_CLASS}>Category</p>
				<select
					value={form.category}
					onChange={(e) => setField("category", e.target.value as Category)}
					className={SELECT_CLASS}
				>
					{CATEGORIES.map((c) => (
						<option key={c} value={c}>
							{CATEGORY_LABELS[c]}
						</option>
					))}
				</select>
			</div>

			<RoomPicker
				rooms={form.rooms}
				onChange={(rooms) => setField("rooms", rooms)}
			/>

			<div>
				<p className={LABEL_CLASS}>Description</p>
				<textarea
					value={form.description}
					onChange={(e) => setField("description", e.target.value)}
					rows={2}
					className="w-full rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
				/>
			</div>

			<div>
				<p className={LABEL_CLASS}>Tags</p>
				<input
					value={form.tags}
					onChange={(e) => setField("tags", e.target.value)}
					className="w-full rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
				/>
			</div>
		</>
	);
}

/** The catalogue's settings with the cabinets taken out, for telling whether
 * the admin has unpublished settings edits that a reload would lose. */
const settingsOf = (catalogue: PlannerCatalogue) =>
	JSON.stringify({
		...catalogue,
		families: [],
		roomTypes: catalogue.roomTypes.map((room) => ({ ...room, familyIds: [] })),
	});

/**
 * `useSearchParams` opts the tree out of prerendering, so the boundary is
 * required — without it the build fails on this route.
 */
export function CabinetDesignsClient() {
	return (
		<Suspense fallback={null}>
			<CabinetDesigns />
		</Suspense>
	);
}

function CabinetDesigns() {
	const router = useRouter();
	const params = useSearchParams();
	const wantedTab = params.get("tab");
	const [tab, setTab] = useState<Tab>(isTab(wantedTab) ? wantedTab : "KITCHEN");

	const [designs, setDesigns] = useState<CabinetDesign[]>([]);
	/** What customers can place right now. */
	const [published, setPublished] = useState<{
		version: number;
		data: PlannerCatalogue;
	} | null>(null);
	/**
	 * The published catalogue with this admin's unpublished settings edits —
	 * door styles, finishes, rates. Cabinets are never read from it: Publish
	 * rebuilds those from the design rows.
	 */
	const [base, setBase] = useState<PlannerCatalogue | null>(null);
	/** `finish:<id>` → photo. Live on drop, so never part of `base`. */
	const [finishPhotos, setFinishPhotos] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(true);
	const [search, setSearch] = useState("");
	const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");

	const [panelOpen, setPanelOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<Form>(emptyForm("KITCHEN"));
	const [formStatus, setFormStatus] = useState<Status>("PUBLISHED");
	const [file, setFile] = useState<File | null>(null);
	const [existingFilename, setExistingFilename] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [missing, setMissing] = useState<Set<string>>(new Set());
	/** What the design file said, once it has been read. */
	const [measured, setMeasured] = useState<DesignMeasurement | null>(null);
	const [measureError, setMeasureError] = useState<string | null>(null);
	/** Non-null while several files are being described at once. */
	const [batch, setBatch] = useState<BatchRow[] | null>(null);
	/** Id of the row whose Delete is armed, so only one row is ever primed. */
	const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

	/** The last thing that happened, shown until the next action. */
	const [notice, setNotice] = useState<string | null>(null);
	/**
	 * The offer to publish, made right after an upload or an edit — so the admin
	 * is asked while they are still looking at what they changed, instead of
	 * having to know a draft exists somewhere.
	 */
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const [publishing, setPublishing] = useState(false);

	/** Returns the fresh rows, so a caller can judge what they changed without
	 * waiting for a render. */
	async function load(resetBase = false): Promise<CabinetDesign[] | null> {
		setLoading(true);
		const res = await fetch("/api/admin/cabinet-designs");
		if (res.status === 401) {
			router.push("/admin/login");
			return null;
		}
		if (!res.ok) {
			setError("Failed to load designs");
			setLoading(false);
			return null;
		}
		const body = await res.json();
		const rows: CabinetDesign[] = body.designs ?? [];
		setDesigns(rows);
		setPublished(body.published);
		// Settings edits live only in `base`; reloading the rows after an upload
		// must not throw them away. Only a publish — which made them live — resets.
		setBase((prev) =>
			resetBase || !prev ? structuredClone(body.published.data) : prev,
		);
		setLoading(false);
		return rows;
	}

	const loadFinishPhotos = useCallback(async () => {
		const res = await fetch("/api/admin/site-images");
		if (!res.ok) return;
		const body = await res.json();
		const next: Record<string, string> = {};
		for (const image of body.images ?? []) {
			next[image.key] = siteImageSrc(image.key, image.updatedAt);
		}
		setFinishPhotos(next);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: load on mount only
	useEffect(() => {
		load();
		loadFinishPhotos();
	}, []);

	const edit = useCallback((mutate: (next: PlannerCatalogue) => void) => {
		setBase((prev) => {
			if (!prev) return prev;
			const next = structuredClone(prev);
			mutate(next);
			return next;
		});
	}, []);

	const built = useMemo(
		() => (base ? buildCatalogue(designs, base) : null),
		[designs, base],
	);
	const changes = useMemo(
		() =>
			published && built
				? summariseCatalogueChanges(published.data, built)
				: [],
		[published, built],
	);

	const liveById = useMemo(
		() =>
			new Map(
				(published?.data.families ?? []).map((f) => [f.id, JSON.stringify(f)]),
			),
		[published],
	);
	const nextById = useMemo(
		() =>
			new Map((built?.families ?? []).map((f) => [f.id, JSON.stringify(f)])),
		[built],
	);
	const reachOf = (d: CabinetDesign): Reach => {
		const live = liveById.get(d.id);
		const next = nextById.get(d.id);
		if (!live) return next ? "pending" : "archived";
		if (!next) return "leaving";
		return live === next ? "live" : "changed";
	};

	// Settings edits are the one thing on this page held only in memory — a
	// design edit is already a saved row. Warn before a reload loses them.
	const settingsDirty =
		!!base && !!published && settingsOf(base) !== settingsOf(published.data);
	useEffect(() => {
		if (!settingsDirty) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [settingsDirty]);

	function selectTab(next: Tab) {
		setTab(next);
		window.history.replaceState(null, "", `?tab=${next}`);
	}

	/**
	 * After an upload or edit: ask to publish if it changed anything a customer
	 * would see, otherwise just say it was saved. Judged on the rows `load` just
	 * returned, because state from this render is still the old list.
	 */
	function offerPublish(
		title: string,
		notes: string[],
		fresh: CabinetDesign[] | null,
	) {
		if (!fresh || !base || !published) return;
		const pending = summariseCatalogueChanges(
			published.data,
			buildCatalogue(fresh, base),
		);
		if (pending.length === 0) {
			setNotice(
				[`${title}. Nothing customers see has changed.`, ...notes].join(" "),
			);
			return;
		}
		setConfirm({ title, notes });
	}

	async function publish() {
		if (!base) return;
		setPublishing(true);
		setError(null);
		try {
			const res = await fetch("/api/admin/cabinet-designs/publish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ base }),
			});
			const body = await res.json().catch(() => null);
			// Designs whose file was refused at publish stay out of the catalogue;
			// say which, so the admin can replace or archive them.
			const refused: string[] = (body?.failures ?? []).map(
				(failure: { message: string }) => failure.message,
			);
			if (!res.ok) {
				setConfirm(null);
				setError(
					[
						body?.message ??
							`Could not publish (${body?.error ?? res.status}).`,
						...refused,
					].join(" "),
				);
				return;
			}
			setConfirm(null);
			setNotice(
				[
					body.status === "published"
						? `Live in the planner — catalogue v${body.version}.`
						: "Nothing to publish — the planner already matches.",
					...refused,
				].join(" "),
			);
			await load(true);
		} finally {
			setPublishing(false);
		}
	}

	function openUpload(room: Room) {
		setEditingId(null);
		setForm(emptyForm(room));
		setFormStatus("PUBLISHED");
		setFile(null);
		setExistingFilename(null);
		setMeasured(null);
		setMeasureError(null);
		setError(null);
		setMissing(new Set());
		setBatch(null);
		setPanelOpen(true);
	}

	/** A SKU that is at least unique among the files in this batch. The admin
	 * still owns it — this only saves typing three near-identical codes. */
	const skuFrom = (name: string) =>
		name
			.replace(/\.[^.]+$/, "")
			.toUpperCase()
			.replace(/[^A-Z0-9]+/g, "-")
			.replace(/^-|-$/g, "");

	/**
	 * The entry point for the file input, which takes several.
	 *
	 * One file keeps the single-design form, with the 3D preview and the edit
	 * path. Two or more switch to the batch table.
	 */
	async function acceptFiles(files: File[]) {
		if (files.length === 0) return;
		if (files.length === 1) {
			setBatch(null);
			await acceptFile(files[0]);
			return;
		}

		setFile(null);
		setMeasured(null);
		setMeasureError(null);
		setError(null);

		const { measureDesign } = await import("@/lib/mesh/measureDesign");
		const rows: BatchRow[] = [];
		for (const file of files) {
			let measured: DesignMeasurement | null = null;
			let measureError: string | null = null;
			if (file.name.toLowerCase().endsWith(".obj")) {
				try {
					measured = measureDesign(await file.text());
					if (!measured) measureError = "no geometry found";
				} catch (error) {
					measureError = error instanceof Error ? error.message : String(error);
				}
			} else {
				// The library stores a design; unzipping in the browser to measure
				// is work this form does not need.
				measureError = "zip — dimensions not read";
			}
			rows.push({
				file,
				measured,
				measureError,
				name: file.name.replace(/\.[^.]+$/, ""),
				sku: skuFrom(file.name),
				price: "",
				result: "pending",
			});
		}

		rows.sort(
			(a, b) => (a.measured?.widthMm ?? 0) - (b.measured?.widthMm ?? 0),
		);
		setBatch(rows);
		// The category is shared, so take it from the first file that had one.
		const read = rows.find((row) => row.measured)?.measured;
		if (read) setForm((prev) => ({ ...prev, category: read.category }));
	}

	/**
	 * Takes the chosen file and reads its dimensions straight out of the
	 * geometry, so the admin confirms numbers rather than typing them off a
	 * drawing. Only fills fields that are still empty — re-attaching a file to
	 * an existing design must not quietly overwrite a size someone corrected.
	 */
	async function acceptFile(f: File) {
		setFile(f);
		setMeasured(null);
		setMeasureError(null);

		if (!f.name.toLowerCase().endsWith(".obj")) return;

		try {
			// Loaded on demand: the reader must never be in the bundle a customer
			// downloads.
			const { measureDesign } = await import("@/lib/mesh/measureDesign");
			const result = measureDesign(await f.text());
			if (!result) {
				setMeasureError(
					"Could not find any geometry in that .obj, so the dimensions are yours to fill in.",
				);
				return;
			}
			setMeasured(result);
			setForm((prev) => ({
				...prev,
				name: prev.name || f.name.replace(/\.[^.]+$/, ""),
				category:
					prev.category === "BASE_CABINET" ? result.category : prev.category,
				w: prev.w || String(result.widthMm),
				h: prev.h || String(result.heightMm),
				d: prev.d || String(result.depthMm),
			}));
			setMissing(new Set());
		} catch (error) {
			setMeasureError(
				`Could not read that .obj: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	function editItem(d: CabinetDesign) {
		setEditingId(d.id);
		setForm({
			name: d.name,
			category: d.category,
			rooms: d.rooms,
			w: String(d.widthMm),
			h: String(d.heightMm),
			d: String(d.depthMm),
			price: String(d.priceRm),
			weight: d.weightKg === null ? "" : String(d.weightKg),
			sku: d.sku,
			description: d.description ?? "",
			tags: d.tags ?? "",
			finishes: d.finishes,
		});
		setFormStatus(d.status);
		setFile(null);
		setExistingFilename(d.filename);
		setBatch(null);
		setError(null);
		setMissing(new Set());
		setPanelOpen(true);
	}

	function setField<K extends keyof Form>(key: K, value: Form[K]) {
		setForm((f) => ({ ...f, [key]: value }));
		setMissing((m) => {
			if (!m.has(key)) return m;
			const next = new Set(m);
			next.delete(key);
			return next;
		});
	}

	function toggleFinish(label: string) {
		setForm((f) => ({
			...f,
			finishes: f.finishes.includes(label)
				? f.finishes.filter((v) => v !== label)
				: [...f.finishes, label],
		}));
	}

	async function toggleArchive(d: CabinetDesign) {
		const status: Status = d.status === "PUBLISHED" ? "ARCHIVED" : "PUBLISHED";
		setNotice(null);
		await fetch(`/api/admin/cabinet-designs/${d.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status }),
		});
		const fresh = await load();
		offerPublish(
			`${d.name} ${status === "ARCHIVED" ? "archived" : "restored"}`,
			[],
			fresh,
		);
	}

	/**
	 * Deletes for good — the row and the file behind it.
	 *
	 * Two clicks, the first armed for a single row only. A design customers can
	 * still place is refused by the server with the reason, which lands in the
	 * error line: archive it and publish first.
	 */
	async function removeItem(d: CabinetDesign) {
		setConfirmingDelete(null);
		setNotice(null);
		setError(null);
		const res = await fetch(`/api/admin/cabinet-designs/${d.id}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			setError(body?.message ?? `Could not delete ${d.name}.`);
			return;
		}
		setNotice(`${d.name} deleted.`);
		load();
	}

	/** Uploads one file and creates its row. Per row, because one bad file in a
	 * batch of three must not lose the other two. */
	async function createOne(
		row: BatchRow,
	): Promise<{ id: string; meshNote: string | null } | { error: string }> {
		const { upload } = await import("@vercel/blob/client");
		const importId = crypto.randomUUID();
		// Must match MESH_PATHNAME in lib/catalogue/meshBlob.ts, which the shared
		// token route enforces. That module is server-only, so the shape is
		// repeated here rather than imported. Keep the two in step.
		const pathname = `mesh/${importId}/${row.file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

		let blob: { url: string; pathname: string };
		try {
			const result = await upload(pathname, row.file, {
				access: "private",
				handleUploadUrl: "/api/admin/catalogue/uploads/token",
			});
			blob = { url: result.url, pathname: result.pathname };
		} catch (error) {
			return {
				error: `upload failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const res = await fetch("/api/admin/cabinet-designs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				blobUrl: blob.url,
				blobPathname: blob.pathname,
				filename: row.file.name,
				name: row.name,
				category: form.category,
				rooms: form.rooms,
				widthMm: row.measured?.widthMm ?? 0,
				heightMm: row.measured?.heightMm ?? 0,
				depthMm: row.measured?.depthMm ?? 0,
				priceRm: Number(row.price) || 0,
				sku: row.sku,
				description: form.description || undefined,
				tags: form.tags || undefined,
				finishes: [],
				status: "PUBLISHED",
			}),
		});

		const body = await res.json().catch(() => null);
		if (!res.ok) {
			return {
				error:
					body?.error === "duplicate"
						? "this exact file is already in the library"
						: body?.error === "sku_taken"
							? "that SKU is already taken"
							: (body?.message ?? `could not save (${res.status})`),
			};
		}
		return { id: body.design.id, meshNote: body.meshNote ?? null };
	}

	async function saveBatch() {
		if (!batch) return;

		const missingPrice = batch.some((row) => !row.price.trim());
		const missingSku = batch.some((row) => !row.sku.trim());
		if (missingPrice || missingSku || form.rooms.length === 0) {
			setError(
				"Every design needs its own SKU and price, and the batch needs at least one room.",
			);
			return;
		}

		setSaving(true);
		setError(null);
		setNotice(null);

		const rows = [...batch];
		const notes: string[] = [];
		let saved = 0;
		for (const [i, row] of rows.entries()) {
			if (row.result === "saved") continue;
			const result = await createOne(row);
			if ("error" in result) {
				rows[i] = { ...row, result: result.error };
			} else {
				rows[i] = { ...row, result: "saved" };
				saved++;
				if (result.meshNote) notes.push(result.meshNote);
			}
			setBatch([...rows]);
		}

		const fresh = await load();
		setSaving(false);

		const failed = rows.filter((row) => row.result !== "saved").length;
		if (failed > 0) {
			// Keep the panel open on the rows that need attention. What did save
			// is already in the publish bar.
			setError(
				saved === 0
					? "None of those files could be saved — see the rows above."
					: `${saved} saved, ${failed} could not be — see the rows above.`,
			);
			return;
		}

		setPanelOpen(false);
		setBatch(null);
		offerPublish(`${saved} designs uploaded ✓`, notes, fresh);
	}

	async function save() {
		const failed = REQUIRED_FIELDS.filter((f) => !f.valid(form[f.key]));
		if (failed.length > 0 || form.rooms.length === 0) {
			setMissing(new Set(failed.map((f) => f.key)));
			setError(
				`Missing: ${[
					...failed.map((f) => f.label),
					...(form.rooms.length === 0 ? ["Room"] : []),
				].join(", ")}`,
			);
			return;
		}
		setMissing(new Set());
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			let blob: { url: string; pathname: string; filename: string } | null =
				null;
			if (file) {
				const { upload } = await import("@vercel/blob/client");
				const importId = crypto.randomUUID();
				// Must match MESH_PATHNAME in lib/catalogue/meshBlob.ts, which the
				// shared token route enforces. Keep the two in step.
				const pathname = `mesh/${importId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
				const result = await upload(pathname, file, {
					access: "private",
					handleUploadUrl: "/api/admin/catalogue/uploads/token",
				});
				blob = {
					url: result.url,
					pathname: result.pathname,
					filename: file.name,
				};
			}

			if (!editingId && !blob) {
				setError("Choose a design file first");
				setSaving(false);
				return;
			}

			const payload = {
				...(blob
					? {
							blobUrl: blob.url,
							blobPathname: blob.pathname,
							filename: blob.filename,
						}
					: {}),
				name: form.name,
				category: form.category,
				rooms: form.rooms,
				widthMm: Number(form.w),
				heightMm: Number(form.h),
				depthMm: Number(form.d),
				priceRm: Number(form.price),
				weightKg:
					form.weight.trim() === "" || !(Number(form.weight) > 0)
						? null
						: Number(form.weight),
				sku: form.sku,
				description: form.description || undefined,
				tags: form.tags || undefined,
				finishes: form.finishes,
				status: formStatus,
			};

			const res = await fetch(
				editingId
					? `/api/admin/cabinet-designs/${editingId}`
					: "/api/admin/cabinet-designs",
				{
					method: editingId ? "PATCH" : "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				},
			);
			const body = await res.json();
			if (!res.ok) {
				setError(
					body.error === "duplicate"
						? "This exact file is already uploaded."
						: body.error === "sku_taken"
							? "That SKU is already in use."
							: body.error === "invalid_body"
								? "Some fields are invalid — check the highlighted ones."
								: (body.message ?? body.error ?? "Could not save"),
				);
				setSaving(false);
				return;
			}

			const fresh = await load();
			setPanelOpen(false);
			offerPublish(
				`${form.name} ${editingId ? "saved" : "uploaded"} ✓`,
				body.meshNote ? [body.meshNote] : [],
				fresh,
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}

	const inRoom = useMemo(() => {
		if (!isRoom(tab)) return [];
		const q = search.trim().toLowerCase();
		return designs.filter((d) => {
			if (!d.rooms.includes(tab)) return false;
			if (statusFilter !== "all" && d.status !== statusFilter) return false;
			if (
				q &&
				!(
					d.name.toLowerCase().includes(q) ||
					d.sku.toLowerCase().includes(q) ||
					(d.tags ?? "").toLowerCase().includes(q)
				)
			)
				return false;
			return true;
		});
	}, [designs, tab, search, statusFilter]);

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
			<AdminHeader />
			<main className="mx-auto flex w-full max-w-[1320px] flex-1 flex-col gap-5 p-7">
				<div>
					<h1 className="mb-1 font-semibold text-[22px]">Cabinet designs</h1>
					<p className="text-neutral-500 text-sm">
						Every cabinet customers can place, room by room. Upload a design,
						check its price, publish.
						{published && ` Customers see catalogue v${published.version}.`}
					</p>
				</div>

				{notice && (
					<p className="rounded-lg border border-green-300 bg-green-50 px-3 py-2.5 text-[13px] text-green-900">
						{notice}
					</p>
				)}
				{error && !panelOpen && (
					<p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-[13px] text-red-900">
						{error}
					</p>
				)}

				{/* The gate. Everything else on this page is reversible; the button
				    inside this is what a customer sees. */}
				{confirm && (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6">
						<div className="w-full max-w-[520px] rounded-xl border border-neutral-200 bg-white p-5 shadow-xl">
							<h2 className="font-semibold text-[15px]">{confirm.title}</h2>
							<p className="mt-1 text-[13px] text-neutral-500">
								Publish live now? This is what customers will get:
							</p>
							<ul className="mt-3 flex max-h-64 flex-col gap-1.5 overflow-auto rounded-lg bg-neutral-50 p-3 text-[13px]">
								{changes.map((change) => (
									<li key={change} className="text-neutral-800">
										{change}
									</li>
								))}
							</ul>
							{/* The mesh is what the customer actually looks at, so a design
							    that fell back to procedural geometry has to say so here
							    rather than reporting a clean success. */}
							{confirm.notes.map((note) => (
								<p
									key={note}
									className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
								>
									{note}
								</p>
							))}
							<div className="mt-4 flex items-center justify-end gap-2">
								<button
									type="button"
									onClick={() => setConfirm(null)}
									className="rounded-[9px] border border-neutral-300 px-3.5 py-2 font-medium text-[13px]"
								>
									Later
								</button>
								<button
									type="button"
									disabled={publishing || changes.length === 0}
									onClick={publish}
									className="rounded-[9px] bg-neutral-900 px-3.5 py-2 font-medium text-[13px] text-white disabled:opacity-50"
								>
									{publishing ? "Publishing…" : "Publish now"}
								</button>
							</div>
							<p className="mt-3 text-[12px] text-neutral-400">
								&ldquo;Later&rdquo; keeps it here, unpublished — the bar at the
								bottom of this page holds it until you publish.
							</p>
						</div>
					</div>
				)}

				<div className="flex flex-wrap items-center gap-1.5">
					{ROOMS.map((room) => (
						<button
							key={room}
							type="button"
							onClick={() => selectTab(room)}
							className={chipClass(tab === room)}
						>
							{ROOM_LABELS[room]}
							<span className="ml-1.5 tabular-nums opacity-60">
								{
									designs.filter(
										(d) => d.rooms.includes(room) && d.status === "PUBLISHED",
									).length
								}
							</span>
						</button>
					))}
					<span className="mx-1 h-5 w-px bg-neutral-200" />
					{SETTINGS_TABS.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => selectTab(t.id)}
							className={chipClass(tab === t.id)}
						>
							{t.label}
						</button>
					))}
				</div>

				{!isRoom(tab) ? (
					base && (
						<div className="flex max-w-4xl flex-col gap-3">
							<p className="text-[12px] text-neutral-500">
								Changes here are held on this page until you publish — reloading
								loses them.
							</p>
							<CatalogueSettings
								tab={tab}
								draft={base}
								editAction={edit}
								finishPhotos={finishPhotos}
								onPhotosChangeAction={loadFinishPhotos}
							/>
						</div>
					)
				) : (
					<>
						<div className="flex flex-wrap items-center gap-2.5">
							<input
								type="text"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search by name, SKU or tag"
								className="min-w-[200px] max-w-[320px] flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm"
							/>
							<div className="flex flex-wrap items-center gap-1.5">
								{(["all", "PUBLISHED", "ARCHIVED"] as const).map((s) => (
									<button
										key={s}
										type="button"
										onClick={() => setStatusFilter(s)}
										className={chipClass(statusFilter === s)}
									>
										{s === "all"
											? "All"
											: s === "PUBLISHED"
												? "Active"
												: "Archived"}
									</button>
								))}
							</div>
							<button
								type="button"
								onClick={() => openUpload(tab)}
								className="ml-auto flex items-center gap-1.5 rounded-[9px] bg-neutral-900 px-4 py-2.5 font-medium text-[13px] text-white"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 14 14"
									fill="none"
									aria-hidden="true"
								>
									<path
										d="M7 1V13M1 7H13"
										stroke="currentColor"
										strokeWidth="1.6"
										strokeLinecap="round"
									/>
								</svg>
								Upload to {ROOM_LABELS[tab]}
							</button>
						</div>

						{/* Only after a load that worked: a failed one has no rows either, and
						    "coming soon" would hide the error above it. */}
						{!loading && published && inRoom.length === 0 && (
							<div className="rounded-xl border border-neutral-200 bg-white p-10 text-center text-neutral-500 text-sm">
								{designs.some((d) => d.rooms.includes(tab))
									? "No designs match your filters."
									: `No cabinets in ${ROOM_LABELS[tab]} yet — customers see it as coming soon. Upload the first design.`}
							</div>
						)}

						{CATEGORIES.map((category) => {
							const rows = inRoom.filter((d) => d.category === category);
							if (rows.length === 0) return null;
							return (
								<section key={category} className="flex flex-col gap-2">
									<p className="text-[11px] text-neutral-500 uppercase tracking-wide">
										{CATEGORY_LABELS[category]} · {rows.length}
									</p>
									<div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
										<div className="overflow-x-auto">
											<table className="w-full table-fixed text-left text-sm">
												<colgroup>
													<col className="w-[26%]" />
													<col className="w-[13%]" />
													<col className="w-[11%]" />
													<col className="w-[9%]" />
													<col className="w-[19%]" />
													<col className="w-[8%]" />
													<col className="w-[14%]" />
												</colgroup>
												<thead>
													<tr className="border-neutral-200 border-b bg-[#f7f6f4]">
														{[
															"Design",
															"Dimensions",
															"SKU",
															"Price",
															"In the planner",
															"Updated",
															"",
														].map((h) => (
															<th
																key={h}
																className="whitespace-nowrap px-4 py-2.5 text-left font-medium text-[11px] text-neutral-500 uppercase tracking-wide"
															>
																{h}
															</th>
														))}
													</tr>
												</thead>
												<tbody>
													{rows.map((d) => {
														const reach = reachOf(d);
														return (
															<tr
																key={d.id}
																className="border-neutral-100 border-b last:border-b-0"
															>
																<td className="overflow-hidden px-4 py-2.5">
																	<button
																		type="button"
																		onClick={() => editItem(d)}
																		title={`Open ${d.name} — view the model and edit its details`}
																		className="flex min-w-0 w-full items-center gap-2.5 text-left"
																	>
																		<span
																			className="h-8 w-10 flex-shrink-0 rounded-md shadow-[inset_0_0_0_1px_rgba(0,0,0,.06)]"
																			style={{
																				backgroundColor:
																					CATEGORY_SWATCH[d.category],
																			}}
																		/>
																		<div className="min-w-0">
																			<p className="truncate font-medium">
																				{d.name}
																			</p>
																			<p className="truncate text-[11px] text-neutral-400">
																				{d.rooms.length > 1
																					? `also in ${d.rooms
																							.filter((r) => r !== tab)
																							.map((r) => ROOM_LABELS[r])
																							.join(", ")}`
																					: d.filename}
																			</p>
																		</div>
																	</button>
																</td>
																<td className="whitespace-nowrap px-3 py-2.5 text-neutral-700 tabular-nums">
																	{d.widthMm} × {d.heightMm} × {d.depthMm}
																</td>
																<td className="truncate px-3 py-2.5 font-mono text-neutral-500 text-xs">
																	{d.sku}
																</td>
																<td className="px-3 py-2.5 text-right tabular-nums">
																	RM {d.priceRm.toLocaleString()}
																</td>
																<td className="px-3 py-2.5">
																	<span
																		title={REACH_HINT[reach]}
																		className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 font-medium text-xs ${REACH_TONE[reach]}`}
																	>
																		<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
																		{REACH_LABEL[reach]}
																	</span>
																	<span
																		className={`mt-0.5 block text-[11px] ${
																			d.meshGroups?.length
																				? "text-neutral-400"
																				: "text-amber-700"
																		}`}
																		title={
																			d.meshGroups
																				?.map(
																					(g) =>
																						`${g.role} ${g.triangles}` +
																						(g.fit ? ` (${g.fit})` : "") +
																						(g.hingeSide
																							? ` hinged ${g.hingeSide}`
																							: ""),
																				)
																				.join(" · ") ?? undefined
																		}
																	>
																		{meshSummary(d)}
																	</span>
																</td>
																<td className="px-3 py-2.5 text-neutral-400">
																	{new Date(d.updatedAt).toLocaleDateString()}
																</td>
																{/* Armed state: Cancel sits last, under the pointer
																    that just armed the row, so clicking twice in the
																    same place backs out rather than deletes. */}
																<td className="px-4 py-2.5">
																	{confirmingDelete === d.id ? (
																		<div className="flex items-center justify-end gap-3 whitespace-nowrap">
																			<span className="text-[11px] text-neutral-500">
																				Sure?
																			</span>
																			<button
																				type="button"
																				onClick={() => removeItem(d)}
																				className="font-medium text-red-700 text-xs underline"
																			>
																				Delete
																			</button>
																			<button
																				type="button"
																				onClick={() =>
																					setConfirmingDelete(null)
																				}
																				className="font-medium text-neutral-700 text-xs underline"
																			>
																				Cancel
																			</button>
																		</div>
																	) : (
																		<div className="flex items-center justify-end gap-3 whitespace-nowrap">
																			<button
																				type="button"
																				onClick={() => editItem(d)}
																				className="text-neutral-600 text-xs underline"
																			>
																				Edit
																			</button>
																			<button
																				type="button"
																				onClick={() => toggleArchive(d)}
																				className={`text-xs underline ${
																					d.status === "PUBLISHED"
																						? "text-amber-700"
																						: "text-green-700"
																				}`}
																			>
																				{d.status === "PUBLISHED"
																					? "Archive"
																					: "Restore"}
																			</button>
																			<button
																				type="button"
																				onClick={() =>
																					setConfirmingDelete(d.id)
																				}
																				className="text-neutral-400 text-xs underline hover:text-red-700"
																			>
																				Delete
																			</button>
																		</div>
																	)}
																</td>
															</tr>
														);
													})}
												</tbody>
											</table>
										</div>
									</div>
								</section>
							);
						})}
					</>
				)}

				{/* What is saved but not live, kept in view until it is published —
				    so "Later" never means "forgotten". */}
				{changes.length > 0 && !confirm && (
					<div className="sticky bottom-4 z-20 mt-auto flex w-full items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 shadow-lg">
						<p className="text-[13px] text-amber-900">
							<strong>
								{changes.length} unpublished change
								{changes.length === 1 ? "" : "s"}
							</strong>{" "}
							— customers still see catalogue v{published?.version}.
						</p>
						<button
							type="button"
							onClick={() =>
								setConfirm({ title: "Publish to the planner?", notes: [] })
							}
							className="shrink-0 rounded-[9px] bg-neutral-900 px-3.5 py-2 font-medium text-[13px] text-white"
						>
							Review &amp; publish
						</button>
					</div>
				)}
			</main>

			{panelOpen && (
				<div className="fixed inset-0 z-30 flex justify-end bg-neutral-900/30">
					<div className="flex h-full w-full max-w-[480px] flex-col overflow-y-auto bg-white shadow-2xl">
						<div className="sticky top-0 z-10 flex items-center justify-between border-neutral-200 border-b bg-white px-5.5 py-4.5">
							<p className="font-semibold text-[15px]">
								{editingId ? "Edit design" : "Upload new design"}
							</p>
							<button
								type="button"
								onClick={() => setPanelOpen(false)}
								className="text-lg text-neutral-400 leading-none"
							>
								×
							</button>
						</div>

						<div className="flex flex-col gap-5 p-5.5">
							<div>
								<p className="mb-1.5 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
									Design file
								</p>
								<div className="rounded-[10px] border-[1.5px] border-neutral-300 border-dashed bg-neutral-50 p-5 text-center">
									{file || existingFilename ? (
										<>
											<p className="font-medium text-sm">
												{file ? file.name : existingFilename}
											</p>
											<p className="mt-1 text-neutral-500 text-xs">
												{file ? "uploaded just now" : "currently attached"}
											</p>
											<button
												type="button"
												onClick={() => {
													setFile(null);
													setExistingFilename(null);
													setMeasured(null);
													setMeasureError(null);
												}}
												className="mt-2.5 text-amber-700 text-xs underline"
											>
												Remove and choose a different file
											</button>
										</>
									) : (
										<>
											<p className="mb-1 text-neutral-700 text-sm">
												Drag a design file here, or
											</p>
											<label className="inline-block cursor-pointer rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs">
												Browse files
												<input
													type="file"
													accept=".obj,.zip"
													// Several at once: one export per width, each its own
													// cabinet. Editing still replaces exactly one file.
													multiple={!editingId}
													className="hidden"
													onChange={(e) => {
														const files = Array.from(e.target.files ?? []);
														if (files.length > 0) acceptFiles(files);
													}}
												/>
											</label>
											<p className="mt-2.5 text-[11px] text-neutral-400">
												.obj, or .zip with its textures — up to 40 MB.
												{!editingId &&
													" Pick several to add every width of a cabinet at once."}
											</p>
										</>
									)}
								</div>
							</div>

							{batch ? (
								<BatchFields
									batch={batch}
									setBatch={setBatch}
									form={form}
									setField={setField}
								/>
							) : (
								<>
									{(file || (editingId && existingFilename)) && (
										<DesignViewer
											source={
												file ??
												(editingId
													? `/api/admin/cabinet-designs/${editingId}/file`
													: null)
											}
											className="h-56 w-full"
										/>
									)}

									{measured && (
										<p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[12px] text-green-900">
											Read from the file:{" "}
											<strong>
												{measured.widthMm} × {measured.heightMm} ×{" "}
												{measured.depthMm} mm
											</strong>
											{measured.doors > 0 && `, ${measured.doors} door`}
											{measured.drawers > 0 && `, ${measured.drawers} drawer`}
											{measured.floorHeightMm >= 1200 &&
												`, hung at ${measured.floorHeightMm}mm`}
											. {measured.partCount} parts. Check the fields below
											before saving — they are a reading, not a spec.
											{measured.notes.map((n) => (
												<span key={n} className="mt-1 block text-amber-800">
													{n}
												</span>
											))}
										</p>
									)}
									{measureError && (
										<p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
											{measureError}
										</p>
									)}

									<div>
										<p className={LABEL_CLASS}>Cabinet name</p>
										<input
											type="text"
											value={form.name}
											onChange={(e) => setField("name", e.target.value)}
											placeholder="e.g. BC 800mm"
											className={fieldClass(missing.has("name"), "w-full")}
										/>
										{missing.has("name") && (
											<p className="mt-1 text-[11px] text-red-600">Required</p>
										)}
									</div>

									<div>
										<p className={LABEL_CLASS}>Category</p>
										<select
											value={form.category}
											onChange={(e) =>
												setField("category", e.target.value as Category)
											}
											className={SELECT_CLASS}
										>
											{CATEGORIES.map((c) => (
												<option key={c} value={c}>
													{CATEGORY_LABELS[c]}
												</option>
											))}
										</select>
									</div>

									<RoomPicker
										rooms={form.rooms}
										onChange={(rooms) => setField("rooms", rooms)}
									/>

									<div>
										<p className={LABEL_CLASS}>Dimensions (W × H × D, mm)</p>
										<div className="grid grid-cols-3 gap-2">
											{(["w", "h", "d"] as const).map((key) => (
												<div key={key}>
													<input
														type="number"
														value={form[key]}
														onChange={(e) => setField(key, e.target.value)}
														placeholder={key.toUpperCase()}
														className={fieldClass(missing.has(key), "w-full")}
													/>
													{missing.has(key) && (
														<p className="mt-1 text-[11px] text-red-600">
															Required
														</p>
													)}
												</div>
											))}
										</div>
									</div>

									<div className="grid grid-cols-2 gap-3">
										<div>
											<p className={LABEL_CLASS}>Price (RM)</p>
											<input
												type="number"
												value={form.price}
												onChange={(e) => setField("price", e.target.value)}
												placeholder="0.00"
												className={fieldClass(missing.has("price"), "w-full")}
											/>
											<p className="mt-1 text-[11px] text-neutral-400">
												All-in, door included.
											</p>
											<label className="mt-3 block">
												<span className={LABEL_CLASS}>Weight (kg)</span>
												<input
													type="number"
													min={0}
													step="0.1"
													value={form.weight}
													onChange={(e) => setField("weight", e.target.value)}
													placeholder="Not weighed"
													className={fieldClass(false, "w-full")}
												/>
												<span className="mt-1 block text-[11px] text-neutral-400">
													Optional. Fills the weight on deliveries made from
													orders — parcel partners need it.
												</span>
											</label>
											{missing.has("price") && (
												<p className="mt-1 text-[11px] text-red-600">
													Required
												</p>
											)}
										</div>
										<div>
											<p className={LABEL_CLASS}>SKU</p>
											<input
												type="text"
												value={form.sku}
												onChange={(e) => setField("sku", e.target.value)}
												placeholder="ICB-0000"
												className={fieldClass(
													missing.has("sku"),
													"w-full font-mono",
												)}
											/>
											{missing.has("sku") && (
												<p className="mt-1 text-[11px] text-red-600">
													Required
												</p>
											)}
										</div>
									</div>

									<div>
										<p className="mb-1.5 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
											Front / finish options
										</p>
										<div className="flex flex-wrap gap-1.5">
											{FINISH_OPTIONS.map((label) => (
												<button
													key={label}
													type="button"
													onClick={() => toggleFinish(label)}
													className={chipClass(form.finishes.includes(label))}
												>
													{label}
												</button>
											))}
										</div>
									</div>

									<div>
										<p className={LABEL_CLASS}>Description</p>
										<textarea
											value={form.description}
											onChange={(e) => setField("description", e.target.value)}
											rows={3}
											className="w-full resize-y rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
										/>
									</div>

									<div>
										<p className={LABEL_CLASS}>Tags</p>
										<input
											type="text"
											value={form.tags}
											onChange={(e) => setField("tags", e.target.value)}
											placeholder="e.g. soft-close, corner, best-seller"
											className="w-full rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
										/>
										<p className="mt-1 text-[11px] text-neutral-400">
											Comma-separated. Used for search only, not shown to
											customers.
										</p>
									</div>

									<div className="border-neutral-100 border-t pt-4">
										<p className="mb-2 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
											Status
										</p>
										<p className="mb-2 text-[11px] text-neutral-400">
											An archived design leaves the planner at the next publish.
										</p>
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => setFormStatus("PUBLISHED")}
												className={`flex-1 rounded-lg border px-3 py-2.5 text-left font-medium text-[12.5px] ${
													formStatus === "PUBLISHED"
														? "border-green-700 bg-green-50 text-green-700"
														: "border-neutral-200 bg-white text-neutral-500"
												}`}
											>
												Active — offered to customers
											</button>
											<button
												type="button"
												onClick={() => setFormStatus("ARCHIVED")}
												className={`flex-1 rounded-lg border px-3 py-2.5 text-left font-medium text-[12.5px] ${
													formStatus === "ARCHIVED"
														? "border-amber-700 bg-amber-50 text-amber-700"
														: "border-neutral-200 bg-white text-neutral-500"
												}`}
											>
												Archived — not offered
											</button>
										</div>
									</div>
								</>
							)}

							{error && (
								<p className="rounded border border-red-300 bg-red-50 p-2.5 text-red-900 text-sm">
									{error}
								</p>
							)}
						</div>

						<div className="sticky bottom-0 mt-auto flex justify-end gap-2.5 border-neutral-200 border-t bg-white px-5.5 py-4">
							<button
								type="button"
								onClick={() => setPanelOpen(false)}
								className="rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={batch ? saveBatch : save}
								disabled={saving}
								className="rounded-lg bg-neutral-900 px-4.5 py-2.5 font-medium text-sm text-white disabled:opacity-50"
							>
								{saving
									? "Saving…"
									: batch
										? `Upload ${batch.length} designs`
										: editingId
											? "Save changes"
											: "Upload design"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
