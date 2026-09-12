"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { chipClass, fieldClass } from "@/components/admin/styles";
import {
	CATEGORIES,
	CATEGORY_LABELS,
	CATEGORY_SWATCH,
	type Category,
	ROOM_LABELS,
	ROOMS,
	type Room,
} from "@/lib/catalogue/cabinetDesignLabels";
import type { DesignMeasurement } from "@/lib/mesh/measureDesign";

type Status = "PUBLISHED" | "ARCHIVED";

type CabinetDesign = {
	id: string;
	name: string;
	filename: string;
	blobUrl: string;
	blobPathname: string;
	category: Category;
	room: Room;
	widthMm: number;
	heightMm: number;
	depthMm: number;
	priceRm: number;
	sku: string;
	description: string | null;
	tags: string | null;
	finishes: string[];
	status: Status;
	/** The planner family this design was pushed into, if it ever was. */
	familyId: string | null;
	/** The derived render mesh, written when the design is pushed. Null means
	 * the conversion found nothing drawable, so the planner falls back to
	 * procedural geometry for this cabinet. */
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

/**
 * What the planner will draw for this design, in one line.
 *
 * The push already reports this once, in a toast, and a toast is gone by the
 * time anyone wonders why a cabinet looks generic. This is the version that
 * stays on the row.
 */
function meshSummary(d: CabinetDesign): string | null {
	if (!d.familyId) return null;
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
 * Where a design actually is, which is not what `status` says.
 *
 * `status` (PUBLISHED/ARCHIVED) only filters this table — no customer-facing
 * page has ever read it, though it was once labelled "visible to customers".
 * Reaching the planner is a separate act: push the design into the catalogue,
 * then publish that catalogue version. This derives the truth from both.
 */
type Reach = "library" | "queued" | "live";

/** Short enough for a table column. The sentence version is the tooltip —
 * "Queued — in an unpublished draft" wrapped to three lines in the cell. */
const REACH_LABEL: Record<Reach, string> = {
	library: "Library only",
	queued: "In draft",
	live: "In planner",
};

const REACH_HINT: Record<Reach, string> = {
	library:
		"In the design library only. No customer can see this — use “Publish to planner”.",
	queued:
		"Merged into a catalogue draft but never published. Use “Publish to planner” to finish it.",
	live: "Live in the published catalogue — customers can place this cabinet.",
};

const REACH_TONE: Record<Reach, string> = {
	library: "bg-neutral-100 text-neutral-500",
	queued: "bg-amber-50 text-amber-700",
	live: "bg-green-50 text-green-700",
};

const reachOf = (d: CabinetDesign, plannerFamilyIds: Set<string>): Reach => {
	if (!d.familyId) return "library";
	return plannerFamilyIds.has(d.familyId) ? "live" : "queued";
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
	room: Room;
	w: string;
	h: string;
	d: string;
	price: string;
	sku: string;
	description: string;
	tags: string;
	finishes: string[];
};

function emptyForm(): Form {
	return {
		name: "",
		category: "BASE_CABINET",
		room: "KITCHEN",
		w: "",
		h: "",
		d: "",
		price: "",
		sku: "",
		description: "",
		tags: "",
		finishes: ["Slab"],
	};
}

/**
 * Admin-only, and loaded on demand — this is the one component in the app that
 * loads a mesh, and it must never reach a customer's bundle. See the file
 * itself for why the planner's no-loaded-models rule does not apply here.
 */
const DesignViewer = dynamic(
	() => import("@/components/admin/DesignViewer").then((m) => m.DesignViewer),
	{ ssr: false },
);

/**
 * One file in a multi-file upload.
 *
 * The client draws one export per width — BC 600, BC 800, BC 900 — and those are
 * three rungs of one size ladder. Uploading them one at a time meant re-typing
 * the room, category and description three times and reviewing three separate
 * catalogue drafts, for what is one decision.
 *
 * Only the genuinely per-rung fields live here. Everything shared stays in
 * `form`, filled once for the batch.
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

/** What both publish routes answer with — the single-design one flattens the
 * batch arrays back out, so the fields differ by name only. */
type PushBody = {
	status: "draft_created" | "already_in_catalogue";
	draftId?: string;
	draftVersion?: number;
	basedOnVersionId?: string;
	basedOnDraftVersion?: number;
	changes?: string[];
	meshNote?: string | null;
	meshNotes?: string[];
} | null;

/**
 * What a confirm sheet is confirming.
 *
 * Two shapes, one sheet, because they are the same moment from opposite
 * directions: something is about to change what a customer can place, here is
 * what it is, say go. `draftId` is the version the publish call flips live —
 * built by the merge that just ran, or the open draft a re-push found already
 * holding this design.
 */
type Confirm =
	| {
			kind: "publish";
			draftId: string;
			title: string;
			changes: string[];
			notes: string[];
	  }
	| { kind: "delete"; design: CabinetDesign; message: string };

const LABEL_CLASS =
	"mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide";
const SELECT_CLASS =
	"w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-sm";

/**
 * The per-file half of a multi-file upload.
 *
 * Only SKU and price are per row, because only SKU and price genuinely differ
 * between BC 600, BC 800 and BC 900 — everything else about them is the same
 * cabinet. Dimensions are shown but not editable: they were read off the
 * geometry, and a batch is the wrong place to second-guess a measurement.
 * Upload a file on its own if a number needs correcting.
 */
function BatchFields({
	batch,
	setBatch,
	category,
	room,
	description,
	tags,
	setField,
}: {
	batch: BatchRow[];
	setBatch: (rows: BatchRow[]) => void;
	category: Category;
	room: Room;
	description: string;
	tags: string;
	setField: (key: keyof Form, value: string) => void;
}) {
	const update = (i: number, patch: Partial<BatchRow>) =>
		setBatch(batch.map((row, n) => (n === i ? { ...row, ...patch } : row)));

	return (
		<>
			<div className="flex flex-col gap-2">
				<p className={LABEL_CLASS}>
					{batch.length} designs — one catalogue draft
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

			<div className="grid grid-cols-2 gap-3">
				<div>
					<p className={LABEL_CLASS}>Category</p>
					<select
						value={category}
						onChange={(e) => setField("category", e.target.value)}
						className={SELECT_CLASS}
					>
						{CATEGORIES.map((c) => (
							<option key={c} value={c}>
								{CATEGORY_LABELS[c]}
							</option>
						))}
					</select>
				</div>
				<div>
					<p className={LABEL_CLASS}>Room type</p>
					<select
						value={room}
						onChange={(e) => setField("room", e.target.value)}
						className={SELECT_CLASS}
					>
						{ROOMS.map((r) => (
							<option key={r} value={r}>
								{ROOM_LABELS[r]}
							</option>
						))}
					</select>
				</div>
			</div>

			<div>
				<p className={LABEL_CLASS}>Description</p>
				<textarea
					value={description}
					onChange={(e) => setField("description", e.target.value)}
					rows={2}
					className="w-full rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
				/>
			</div>

			<div>
				<p className={LABEL_CLASS}>Tags</p>
				<input
					value={tags}
					onChange={(e) => setField("tags", e.target.value)}
					className="w-full rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
				/>
			</div>
		</>
	);
}

export default function CabinetDesignsPage() {
	const router = useRouter();
	const [designs, setDesigns] = useState<CabinetDesign[]>([]);
	const [loading, setLoading] = useState(true);
	const [search, setSearch] = useState("");
	const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");
	const [categoryFilter, setCategoryFilter] = useState<"all" | Category>("all");

	const [panelOpen, setPanelOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<Form>(emptyForm());
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

	/** Families the *published* catalogue carries, for the reach badge. */
	const [plannerFamilyIds, setPlannerFamilyIds] = useState<Set<string>>(
		new Set(),
	);
	/** Id of the design currently being pushed, so its button can say so. */
	const [pushing, setPushing] = useState<string | null>(null);
	/** What the last push did, shown until the next action. */
	const [pushed, setPushed] = useState<string | null>(null);
	/**
	 * The one thing standing between a design and a customer.
	 *
	 * A merge builds a draft and a delete builds a removal; both then need a
	 * person to look at what changed and say go. That used to mean a trip to
	 * `/admin/catalogue`, which is where the two-page dance came from — the
	 * review is worth keeping, the page hop never was.
	 */
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const [confirmBusy, setConfirmBusy] = useState(false);

	async function load() {
		setLoading(true);
		const res = await fetch("/api/admin/cabinet-designs");
		if (res.status === 401) {
			router.push("/admin/login");
			return;
		}
		if (!res.ok) {
			setError("Failed to load designs");
			setLoading(false);
			return;
		}
		const body = await res.json();
		setDesigns(body.designs ?? []);
		setPlannerFamilyIds(new Set<string>(body.plannerFamilyIds ?? []));
		setLoading(false);
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: load on mount only
	useEffect(() => {
		load();
	}, []);

	function openUpload() {
		setEditingId(null);
		setForm(emptyForm());
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

	/**
	 * Takes the chosen file and reads its dimensions straight out of the
	 * geometry, so the admin confirms numbers rather than typing them off a
	 * drawing. Only fills fields that are still empty — re-attaching a file to
	 * an existing design must not quietly overwrite a size someone corrected.
	 *
	 * A `.zip` is not read here. The library stores a design; it does not
	 * extract one, and unzipping in the browser to measure is work this form
	 * does not need. Those keep the manual fields.
	 */
	/** A SKU that is at least unique among the files in this batch. The admin
	 * still owns it — this only saves typing three near-identical codes. */
	const skuFrom = (name: string) =>
		name
			.replace(/\.[^.]+$/, "")
			.toUpperCase()
			.replace(/[^A-Z0-9]+/g, "-")
			.replace(/^-|-$/g, "");

	/**
	 * The entry point for the file input, which now takes several.
	 *
	 * One file keeps the existing single-design form, untouched — that is still
	 * the common case and it has the 3D preview, the finish picker and the edit
	 * path hanging off it. Two or more switch to the batch table, because
	 * filling that form three times is the thing this exists to remove.
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
				// Same reason the single form does not read one: the library stores
				// a design, it does not extract one.
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

		// Widest first is the order a ladder reads in, and it makes a missing
		// rung obvious at a glance.
		rows.sort(
			(a, b) => (a.measured?.widthMm ?? 0) - (b.measured?.widthMm ?? 0),
		);
		setBatch(rows);
		// The category is shared, so take it from the first file that had one.
		const read = rows.find((row) => row.measured)?.measured;
		if (read) setForm((prev) => ({ ...prev, category: read.category }));
	}

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
			room: d.room,
			w: String(d.widthMm),
			h: String(d.heightMm),
			d: String(d.depthMm),
			price: String(d.priceRm),
			sku: d.sku,
			description: d.description ?? "",
			tags: d.tags ?? "",
			finishes: d.finishes,
		});
		setFormStatus(d.status);
		setFile(null);
		setExistingFilename(d.filename);
		setError(null);
		setMissing(new Set());
		setPanelOpen(true);
	}

	function closePanel() {
		setPanelOpen(false);
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
		await fetch(`/api/admin/cabinet-designs/${d.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status }),
		});
		load();
	}

	/**
	 * Deletes for good — the row and the file behind it.
	 *
	 * Two clicks, not one, and the first is only ever armed for a single row:
	 * `confirmingDelete` holds an id rather than a boolean, so arming one row
	 * disarms any other. Archiving already covers "hide this from customers",
	 * so anyone reaching here means it.
	 */
	async function removeItem(d: CabinetDesign, fromPlanner = false) {
		setConfirmingDelete(null);
		setPushed(null);
		const res = await fetch(
			`/api/admin/cabinet-designs/${d.id}${fromPlanner ? "?fromPlanner=1" : ""}`,
			{ method: "DELETE" },
		);
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			// The design is in the catalogue. That is not a refusal any more — it
			// is the second half of the same job, so ask rather than send the
			// admin to another page to do it by hand.
			if (body?.error === "in_planner") {
				setConfirm({ kind: "delete", design: d, message: body.message });
				return;
			}
			setError(body?.message ?? `Could not delete ${d.name}.`);
			return;
		}
		setConfirm(null);
		setPushed(
			fromPlanner
				? `${d.name} deleted and removed from the planner.`
				: `${d.name} deleted.`,
		);
		load();
	}

	/**
	 * Turns a merge result into either a confirm sheet or a plain message.
	 *
	 * A merge that changed something has a draft to publish, so it asks. A merge
	 * that changed nothing has nothing to publish — unless the design is sitting
	 * in an open draft that was never published, which is the one case where
	 * "already in the catalogue" and "no customer can see it" are both true.
	 * That draft is the base the merge just ran against, so its id is already in
	 * hand.
	 */
	function afterMerge(title: string, body: NonNullable<PushBody>) {
		const notes: string[] =
			body.meshNotes ?? (body.meshNote ? [body.meshNote] : []);
		const draftId =
			body.draftId ?? (body.basedOnDraftVersion ? body.basedOnVersionId : null);

		if (!draftId) {
			setPushed(
				[
					`${title} is already live in the planner — nothing to add.`,
					...notes,
				].join(" "),
			);
			load();
			return;
		}

		setConfirm({
			kind: "publish",
			draftId,
			title,
			changes: body.changes ?? [],
			notes,
		});
		load();
	}

	/**
	 * Merges this design into the planner catalogue, then asks before it goes
	 * live.
	 *
	 * The design library used to be a dead end: an admin uploaded, priced and
	 * "published" a design and no customer could ever see it, because the
	 * planner reads only the published `CatalogueVersion`. Then it was a
	 * half-bridge — the merge landed in a draft and the admin had to finish the
	 * job at `/admin/catalogue`, which is two pages for one intent.
	 *
	 * The review it was protecting is kept, as the confirm sheet: the merge is
	 * still a numbered `CatalogueVersion` and going live is still a deliberate,
	 * separate click. It just happens where the admin already is.
	 */
	async function pushToPlanner(d: CabinetDesign) {
		setPushing(d.id);
		setError(null);
		setPushed(null);
		try {
			const res = await fetch(`/api/admin/cabinet-designs/${d.id}/publish`, {
				method: "POST",
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				setError(
					body?.message ?? `Could not add ${d.name} to the planner catalogue.`,
				);
				return;
			}
			afterMerge(d.name, body);
		} finally {
			setPushing(null);
		}
	}

	/**
	 * The second click: flips the draft the merge built to PUBLISHED.
	 *
	 * Deliberately the existing catalogue endpoint rather than a new one — the
	 * transaction that supersedes the live pricing document should have exactly
	 * one implementation, and this page is not the place for a second.
	 */
	async function publishConfirmed() {
		if (confirm?.kind !== "publish") return;
		setConfirmBusy(true);
		setError(null);
		try {
			const res = await fetch(
				`/api/admin/catalogue/versions/${confirm.draftId}/publish`,
				{ method: "POST" },
			);
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				setError(
					body?.error === "invalid_catalogue"
						? "That draft no longer validates, so it was not published. Open it at /admin/catalogue to see what is wrong."
						: `Could not publish the catalogue (${body?.error ?? res.status}).`,
				);
				return;
			}
			setConfirm(null);
			setPushed(
				[
					`${confirm.title} is live in the planner — catalogue v${body.version}.`,
					...confirm.notes,
				].join(" "),
			);
			load();
		} finally {
			setConfirmBusy(false);
		}
	}

	/** Uploads one file and creates its row. Returns the new design id, or the
	 * reason it could not be created — per row, because one bad file in a batch
	 * of three must not lose the other two. */
	async function createOne(
		row: BatchRow,
		shared: {
			category: Category;
			room: Room;
			description: string;
			tags: string;
		},
	): Promise<{ id: string } | { error: string }> {
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
				category: shared.category,
				room: shared.room,
				widthMm: row.measured?.widthMm ?? 0,
				heightMm: row.measured?.heightMm ?? 0,
				depthMm: row.measured?.depthMm ?? 0,
				priceRm: Number(row.price) || 0,
				sku: row.sku,
				description: shared.description || undefined,
				tags: shared.tags || undefined,
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
		return { id: body.design?.id ?? body.id };
	}

	/**
	 * Saves every file in the batch, then pushes them all into **one** catalogue
	 * draft.
	 *
	 * The single draft is the whole point: three widths of one cabinet are three
	 * rungs of one ladder, and reviewing them as three stacked drafts is both
	 * more work and harder to judge.
	 */
	async function saveBatch() {
		if (!batch) return;

		const missingPrice = batch.some((row) => !row.price.trim());
		const missingSku = batch.some((row) => !row.sku.trim());
		if (missingPrice || missingSku) {
			setError(
				"Every design needs its own SKU and price — those are the two things that differ per width.",
			);
			return;
		}

		setSaving(true);
		setError(null);
		setPushed(null);

		const shared = {
			category: form.category,
			room: form.room,
			description: form.description,
			tags: form.tags,
		};

		const rows = [...batch];
		const ids: string[] = [];
		for (const [i, row] of rows.entries()) {
			if (row.result === "saved") continue;
			const result = await createOne(row, shared);
			if ("error" in result) {
				rows[i] = { ...row, result: result.error };
			} else {
				rows[i] = { ...row, result: "saved" };
				ids.push(result.id);
			}
			setBatch([...rows]);
		}

		if (ids.length === 0) {
			setError("None of those files could be saved — see the rows above.");
			setSaving(false);
			return;
		}

		const res = await fetch("/api/admin/cabinet-designs/publish", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids }),
		});
		const body = await res.json().catch(() => null);
		setSaving(false);

		if (!res.ok) {
			load();
			setError(
				body?.message ??
					`Saved ${ids.length} design${ids.length === 1 ? "" : "s"}, but could not add them to the catalogue.`,
			);
			return;
		}

		// Close first: the confirm sheet sits behind the upload panel, and an
		// admin who cannot see what they are approving will not approve it.
		setPanelOpen(false);
		setBatch(null);
		afterMerge(
			`${ids.length} design${ids.length === 1 ? "" : "s"}`,
			body as NonNullable<PushBody>,
		);
	}

	async function save() {
		const failed = REQUIRED_FIELDS.filter((f) => !f.valid(form[f.key]));
		if (failed.length > 0) {
			setMissing(new Set(failed.map((f) => f.key)));
			setError(`Missing: ${failed.map((f) => f.label).join(", ")}`);
			return;
		}
		setMissing(new Set());
		setSaving(true);
		setError(null);
		try {
			let blob: { url: string; pathname: string; filename: string } | null =
				null;
			if (file) {
				const { upload } = await import("@vercel/blob/client");
				const importId = crypto.randomUUID();
				// Must match MESH_PATHNAME in lib/catalogue/meshBlob.ts, which the
				// shared token route enforces. That module is server-only, so the
				// shape is repeated here rather than imported. Keep the two in step.
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
				room: form.room,
				widthMm: Number(form.w),
				heightMm: Number(form.h),
				depthMm: Number(form.d),
				priceRm: Number(form.price),
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
								: (body.error ?? "Could not save"),
				);
				setSaving(false);
				return;
			}

			setPanelOpen(false);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return designs.filter((d) => {
			if (statusFilter !== "all" && d.status !== statusFilter) return false;
			if (categoryFilter !== "all" && d.category !== categoryFilter)
				return false;
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
	}, [designs, search, statusFilter, categoryFilter]);

	return (
		<div className="flex min-h-screen flex-col bg-[#f4f3f1] text-neutral-900">
			<AdminHeader />
			<main className="mx-auto flex w-full max-w-[1320px] flex-1 flex-col gap-5 p-7">
				<div className="flex items-end justify-between gap-4">
					<div>
						<h1 className="mb-1 font-semibold text-[22px]">Cabinet designs</h1>
						<p className="text-neutral-500 text-sm">
							Upload design exports, describe them, and publish them straight to
							the planner. You confirm what changes before customers see it.
						</p>
					</div>
					<button
						type="button"
						onClick={openUpload}
						className="flex items-center gap-1.5 rounded-[9px] bg-neutral-900 px-4 py-2.5 font-medium text-[13px] text-white"
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
						Upload design
					</button>
				</div>

				{/* Push results and guard refusals both land here. The panel has its
				    own error line, but a design is pushed and deleted from the table,
				    where nothing was reporting back. */}
				{pushed && (
					<p className="rounded-lg border border-green-300 bg-green-50 px-3 py-2.5 text-[13px] text-green-900">
						{pushed}
					</p>
				)}
				{error && !panelOpen && (
					<p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-[13px] text-red-900">
						{error}
					</p>
				)}

				{/* The gate. Everything above this point is reversible; the button
				    inside it is what a customer sees. */}
				{confirm && (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6">
						<div className="w-full max-w-[520px] rounded-xl border border-neutral-200 bg-white p-5 shadow-xl">
							{confirm.kind === "publish" ? (
								<>
									<h2 className="font-semibold text-[15px]">
										Publish to the planner?
									</h2>
									<p className="mt-1 text-[13px] text-neutral-500">
										{confirm.title} is ready. This is what customers will get.
									</p>
									<ul className="mt-3 flex flex-col gap-1.5 rounded-lg bg-neutral-50 p-3 text-[13px]">
										{confirm.changes.length > 0 ? (
											confirm.changes.map((change) => (
												<li key={change} className="text-neutral-800">
													{change}
												</li>
											))
										) : (
											<li className="text-neutral-500">
												No change to the catalogue — the draft is already up to
												date.
											</li>
										)}
									</ul>
									{/* The mesh is what the customer actually looks at, so a
									    design that fell back to procedural geometry has to say
									    so here rather than reporting a clean success. */}
									{confirm.notes.map((note) => (
										<p
											key={note}
											className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
										>
											{note}
										</p>
									))}
								</>
							) : (
								<>
									<h2 className="font-semibold text-[15px]">
										Delete {confirm.design.name}?
									</h2>
									<p className="mt-1 text-[13px] text-neutral-600">
										{confirm.message}
									</p>
									<p className="mt-2 text-[13px] text-neutral-500">
										The design file goes too. Archive instead if you only want
										it out of the list.
									</p>
								</>
							)}
							<div className="mt-4 flex items-center justify-end gap-2">
								<button
									type="button"
									onClick={() => setConfirm(null)}
									className="rounded-[9px] border border-neutral-300 px-3.5 py-2 font-medium text-[13px]"
								>
									{confirm.kind === "publish" ? "Not yet" : "Keep it"}
								</button>
								<button
									type="button"
									disabled={confirmBusy}
									onClick={() =>
										confirm.kind === "publish"
											? publishConfirmed()
											: removeItem(confirm.design, true)
									}
									className={`rounded-[9px] px-3.5 py-2 font-medium text-[13px] text-white disabled:opacity-50 ${
										confirm.kind === "publish" ? "bg-neutral-900" : "bg-red-600"
									}`}
								>
									{confirmBusy
										? "Working…"
										: confirm.kind === "publish"
											? "Publish"
											: "Remove and delete"}
								</button>
							</div>
							{confirm.kind === "publish" && (
								<p className="mt-3 text-[12px] text-neutral-400">
									“Not yet” keeps it as a draft — nothing reaches customers, and
									you can publish it later at /admin/catalogue.
								</p>
							)}
						</div>
					</div>
				)}

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
					<span className="mx-1 h-5 w-px bg-neutral-200" />
					<div className="flex flex-wrap items-center gap-1.5">
						<button
							type="button"
							onClick={() => setCategoryFilter("all")}
							className={chipClass(categoryFilter === "all")}
						>
							All categories
						</button>
						{CATEGORIES.map((c) => (
							<button
								key={c}
								type="button"
								onClick={() => setCategoryFilter(c)}
								className={chipClass(categoryFilter === c)}
							>
								{CATEGORY_LABELS[c]}
							</button>
						))}
					</div>
					<span className="ml-auto text-neutral-400 text-xs">
						{filtered.length} of {designs.length} designs
					</span>
				</div>

				<div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
					<div className="overflow-x-auto">
						<table className="w-full table-fixed text-left text-sm">
							{/* table-fixed, so these are the real widths and content that
							    does not fit is clipped rather than pushing out. The last
							    column carries three actions and needs the room. */}
							<colgroup>
								<col className="w-[17%]" />
								<col className="w-[9%]" />
								<col className="w-[7%]" />
								<col className="w-[11%]" />
								<col className="w-[8%]" />
								<col className="w-[7%]" />
								<col className="w-[10%]" />
								<col className="w-[7%]" />
								<col className="w-[24%]" />
							</colgroup>
							<thead>
								<tr className="border-neutral-200 border-b bg-[#f7f6f4]">
									{[
										"Design",
										"Category",
										"Room",
										"Dimensions",
										"SKU",
										"Price",
										"Status",
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
								{filtered.map((d) => (
									<tr key={d.id} className="border-neutral-100 border-b">
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
														backgroundColor: CATEGORY_SWATCH[d.category],
													}}
												/>
												<div className="min-w-0">
													<p className="truncate font-medium">{d.name}</p>
													<p className="truncate text-[11px] text-neutral-400">
														{d.filename}
													</p>
												</div>
											</button>
										</td>
										<td className="truncate px-3 py-2.5 text-neutral-700">
											{CATEGORY_LABELS[d.category]}
										</td>
										<td className="truncate px-3 py-2.5 text-neutral-700">
											{ROOM_LABELS[d.room]}
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
												title={REACH_HINT[reachOf(d, plannerFamilyIds)]}
												className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 font-medium text-xs ${
													REACH_TONE[reachOf(d, plannerFamilyIds)]
												}`}
											>
												<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
												{REACH_LABEL[reachOf(d, plannerFamilyIds)]}
											</span>
											{d.status === "ARCHIVED" && (
												<span className="ml-1.5 text-[11px] text-neutral-400">
													archived
												</span>
											)}
											{meshSummary(d) && (
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
																	(g.hingeSide ? ` hinged ${g.hingeSide}` : ""),
															)
															.join(" · ") ?? undefined
													}
												>
													{meshSummary(d)}
												</span>
											)}
										</td>
										<td className="px-3 py-2.5 text-neutral-400">
											{new Date(d.updatedAt).toLocaleDateString()}
										</td>
										{/* Armed state: Cancel sits last, under the pointer that
										    just armed the row, so clicking twice in the same place
										    backs out rather than deletes. Note the armed state
										    survives a same-route navigation, because React keeps the
										    state — worth knowing, since a row was lost during
										    testing and that is the most likely way. Labels are short
										    because this has to fit the same column as the three
										    links it replaces. */}
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
														onClick={() => setConfirmingDelete(null)}
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
													{reachOf(d, plannerFamilyIds) !== "live" && (
														<button
															type="button"
															onClick={() => pushToPlanner(d)}
															disabled={pushing === d.id}
															className="text-blue-700 text-xs underline disabled:text-neutral-400"
														>
															{pushing === d.id
																? "Preparing…"
																: "Publish to planner"}
														</button>
													)}
													<button
														type="button"
														onClick={() => toggleArchive(d)}
														className={`text-xs underline ${
															d.status === "PUBLISHED"
																? "text-amber-700"
																: "text-green-700"
														}`}
													>
														{d.status === "PUBLISHED" ? "Archive" : "Restore"}
													</button>
													<button
														type="button"
														onClick={() => setConfirmingDelete(d.id)}
														className="text-neutral-400 text-xs underline hover:text-red-700"
													>
														Delete
													</button>
												</div>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{!loading && filtered.length === 0 && (
						<div className="p-10 text-center text-neutral-400 text-sm">
							No designs match your filters.
						</div>
					)}
				</div>
			</main>

			{panelOpen && (
				<div className="fixed inset-0 z-10 flex justify-end bg-neutral-900/30">
					<div className="flex h-full w-full max-w-[480px] flex-col overflow-y-auto bg-white shadow-2xl">
						<div className="sticky top-0 z-10 flex items-center justify-between border-neutral-200 border-b bg-white px-5.5 py-4.5">
							<p className="font-semibold text-[15px]">
								{editingId ? "Edit design" : "Upload new design"}
							</p>
							<button
								type="button"
								onClick={closePanel}
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
													// Several at once: one export per width is how the
													// client draws a size ladder, and they belong in
													// one catalogue draft. Editing an existing design
													// still replaces exactly one file.
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
													" Pick several to add a whole size ladder at once."}
											</p>
										</>
									)}
								</div>
							</div>

							{batch ? (
								<BatchFields
									batch={batch}
									setBatch={setBatch}
									category={form.category}
									room={form.room}
									description={form.description}
									tags={form.tags}
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
										<p className="mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
											Cabinet name
										</p>
										<input
											type="text"
											value={form.name}
											onChange={(e) => setField("name", e.target.value)}
											placeholder="e.g. Drawer base 400"
											className={fieldClass(missing.has("name"), "w-full")}
										/>
										{missing.has("name") && (
											<p className="mt-1 text-[11px] text-red-600">Required</p>
										)}
									</div>

									<div className="grid grid-cols-2 gap-3">
										<div>
											<p className="mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
												Category
											</p>
											<select
												value={form.category}
												onChange={(e) =>
													setField("category", e.target.value as Category)
												}
												className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-sm"
											>
												{CATEGORIES.map((c) => (
													<option key={c} value={c}>
														{CATEGORY_LABELS[c]}
													</option>
												))}
											</select>
										</div>
										<div>
											<p className="mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
												Room type
											</p>
											<select
												value={form.room}
												onChange={(e) =>
													setField("room", e.target.value as Room)
												}
												className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-sm"
											>
												{ROOMS.map((r) => (
													<option key={r} value={r}>
														{ROOM_LABELS[r]}
													</option>
												))}
											</select>
										</div>
									</div>

									<div>
										<p className="mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
											Dimensions (W × H × D, mm)
										</p>
										<div className="grid grid-cols-3 gap-2">
											<div>
												<input
													type="number"
													value={form.w}
													onChange={(e) => setField("w", e.target.value)}
													placeholder="W"
													className={fieldClass(missing.has("w"), "w-full")}
												/>
												{missing.has("w") && (
													<p className="mt-1 text-[11px] text-red-600">
														Required
													</p>
												)}
											</div>
											<div>
												<input
													type="number"
													value={form.h}
													onChange={(e) => setField("h", e.target.value)}
													placeholder="H"
													className={fieldClass(missing.has("h"), "w-full")}
												/>
												{missing.has("h") && (
													<p className="mt-1 text-[11px] text-red-600">
														Required
													</p>
												)}
											</div>
											<div>
												<input
													type="number"
													value={form.d}
													onChange={(e) => setField("d", e.target.value)}
													placeholder="D"
													className={fieldClass(missing.has("d"), "w-full")}
												/>
												{missing.has("d") && (
													<p className="mt-1 text-[11px] text-red-600">
														Required
													</p>
												)}
											</div>
										</div>
									</div>

									<div className="grid grid-cols-2 gap-3">
										<div>
											<p className="mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
												Price (RM)
											</p>
											<input
												type="number"
												value={form.price}
												onChange={(e) => setField("price", e.target.value)}
												placeholder="0.00"
												className={fieldClass(missing.has("price"), "w-full")}
											/>
											{missing.has("price") && (
												<p className="mt-1 text-[11px] text-red-600">
													Required
												</p>
											)}
										</div>
										<div>
											<p className="mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
												SKU
											</p>
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
										<p className="mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
											Description
										</p>
										<textarea
											value={form.description}
											onChange={(e) => setField("description", e.target.value)}
											placeholder="Shown to customers in the planner detail view"
											rows={3}
											className="w-full resize-y rounded-lg border border-neutral-300 px-2.5 py-2 text-sm"
										/>
									</div>

									<div>
										<p className="mb-1 font-semibold text-[11px] text-neutral-600 uppercase tracking-wide">
											Tags
										</p>
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
											In this library
										</p>
										{/* Renamed from "Visibility", which promised something this
									    flag has never done: no customer-facing page reads it. A
									    design reaches customers only by being added to the
									    planner catalogue and that version being published. */}
										<p className="mb-2 text-[11px] text-neutral-400">
											Filters this list only. To put a cabinet in front of
											customers, use “Publish to planner”.
										</p>
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => setFormStatus("PUBLISHED")}
												className={`flex-1 rounded-lg border px-3 py-2.5 text-left text-[12.5px] font-medium ${
													formStatus === "PUBLISHED"
														? "border-green-700 bg-green-50 text-green-700"
														: "border-neutral-200 bg-white text-neutral-500"
												}`}
											>
												Active — kept in the library
											</button>
											<button
												type="button"
												onClick={() => setFormStatus("ARCHIVED")}
												className={`flex-1 rounded-lg border px-3 py-2.5 text-left text-[12.5px] font-medium ${
													formStatus === "ARCHIVED"
														? "border-amber-700 bg-amber-50 text-amber-700"
														: "border-neutral-200 bg-white text-neutral-500"
												}`}
											>
												Archived — hidden from this list
											</button>
										</div>
									</div>

									{error && (
										<p className="rounded border border-red-300 bg-red-50 p-2.5 text-red-900 text-sm">
											{error}
										</p>
									)}
								</>
							)}
						</div>

						<div className="sticky bottom-0 mt-auto flex justify-end gap-2.5 border-neutral-200 border-t bg-white px-5.5 py-4">
							<button
								type="button"
								onClick={closePanel}
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
										? `Upload ${batch.length} and publish`
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
