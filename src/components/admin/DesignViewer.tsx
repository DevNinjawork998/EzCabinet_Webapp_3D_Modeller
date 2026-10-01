"use client";

import { Center, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useState } from "react";
import type { Group } from "three";
import { Box3, Vector3 } from "three";
import { DesignedCabinet } from "@/components/planner/DesignedCabinet";
import { StudioLighting } from "@/components/planner/Lighting";
import { markShadowsDirty, SHADOW_MAP } from "@/components/planner/lightingRig";
import type { RenderMesh } from "@/lib/mesh/renderMesh";
import type { DoorStyle, Finish } from "@/lib/planner/catalogueSchema";
import type { FloorPlan } from "@/lib/planner/floorplan";
import { previewFrame } from "./previewFrame";
import { chipClass } from "./styles";

/**
 * Shows an uploaded design file the way the planner will draw it.
 *
 * The file goes through `buildRenderMesh` — the function publish runs — in the
 * browser, and the result is drawn by the planner's own `DesignedCabinet` under
 * the planner's own `StudioLighting`. So the admin sees the customer's cabinet,
 * not a grey approximation, and above all sees which triangles take the finish:
 * the drafter's part names decide that (CLAUDE.md known issue 1), and a misnamed
 * door is invisible in grey and obvious in colour.
 *
 * A file that will not convert is still shown, in grey through three's own
 * `OBJLoader`, because the admin still needs to see which file they picked —
 * and is told the planner will draw it procedurally, which is what publish does.
 *
 * It stays out of the public bundle because the only thing that imports it is
 * an admin page, behind a dynamic import.
 */

/** A room just big enough to light and floor one cabinet. Only the lighting
 * rig's shadow camera reads it. */
const PREVIEW_PLAN: FloorPlan = {
	template: "rect",
	widthMm: 2000,
	depthMm: 2000,
};
const PREVIEW_CEILING_MM = 2400;

/** Fit a non-converting model into a box about this big, whatever units it was
 * drawn in. The grey fallback only — a converted mesh is drawn in metres. */
const FRAME_SIZE = 2;

type Doors = "shut" | "open" | "hidden";
const DOORS: { id: Doors; label: string }[] = [
	{ id: "shut", label: "Doors shut" },
	{ id: "open", label: "Open" },
	{ id: "hidden", label: "Hidden" },
];

/**
 * The `.obj` text, from whichever shape the design arrived in.
 *
 * Both cases end up as bytes, so both go through `objTextFromBytes` — the same
 * reader the publish route uses, which spots an archive by its magic number
 * rather than its name. A stored design keeps its original filename in the
 * blob's content disposition, so the name is not something a fetch can rely on.
 *
 * Imported lazily: `lib/mesh` pulls in fflate, and this whole component is
 * already behind a dynamic import to keep it out of the customer bundle.
 */
async function objTextFrom(source: File | string): Promise<string> {
	const { objTextFromBytes } = await import("@/lib/mesh/archive");

	if (typeof source === "string") {
		const res = await fetch(source);
		if (!res.ok) throw new Error("could not fetch the design file");
		return objTextFromBytes(new Uint8Array(await res.arrayBuffer()));
	}

	return objTextFromBytes(new Uint8Array(await source.arrayBuffer()));
}

/**
 * The grey fallback's framing.
 *
 * One mechanism only. An earlier version scaled here *and* wrapped the result
 * in drei's `<Bounds fit clip>`, and the two disagreed about what they were
 * measuring — the canvas mounted, the file parsed, and nothing appeared.
 * `<Center>` puts the model on the origin; the scale below decides how big it
 * is; the camera never moves. A viewer only has to look right, not measure.
 */
function RawModel({ object }: { object: Group }) {
	const size = new Box3().setFromObject(object).getSize(new Vector3());
	const longest = Math.max(size.x, size.y, size.z) || 1;

	// Z-up files arrive lying on their back. A cabinet is never deeper than it
	// is tall, so that comparison is a safe way to spot one.
	const zUp = size.z > size.y;

	return (
		<Center>
			<primitive
				object={object}
				scale={FRAME_SIZE / longest}
				rotation={zUp ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}
			/>
		</Center>
	);
}

/** Shared by both canvases. The panel is a fixed overlay with a scrolling
 * body. R3F sizes itself through react-use-measure, and with scroll tracking
 * on it measured this container as zero and never created its root — the
 * canvas element existed but no frame was ever drawn. */
const CANVAS_RESIZE = { scroll: false, debounce: 0 } as const;

export function DesignViewer({
	/** The picked file, or a URL an admin route streams the stored one from. */
	source,
	className = "",
	finishes,
	doorStyles,
	finishPhotos,
}: {
	source: File | string | null;
	/** Sizes the canvas box only; the controls sit below it. */
	className?: string;
	finishes: Finish[];
	doorStyles: DoorStyle[];
	/** `finish:<id>` → decor photo URL. */
	finishPhotos: Record<string, string>;
}) {
	/** What the planner will draw. */
	const [mesh, setMesh] = useState<RenderMesh | null>(null);
	/** Only when `mesh` is null: the file as drawn, in grey. */
	const [object, setObject] = useState<Group | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const [finishId, setFinishId] = useState<string | null>(null);
	const [doorId, setDoorId] = useState<string | null>(null);
	const [doors, setDoors] = useState<Doors>("shut");

	useEffect(() => {
		// Reset both first, so switching files never shows the last one's
		// cabinet under the next one's name.
		setMesh(null);
		setObject(null);
		setError(null);
		if (!source) return;

		let cancelled = false;
		setLoading(true);

		(async () => {
			try {
				const [{ buildRenderMesh, MAX_TRIANGLES }, text] = await Promise.all([
					import("@/lib/mesh/renderMesh"),
					objTextFrom(source),
				]);
				if (cancelled) return;

				// The triangle cap lives in `convertDesign.ts`, not in
				// `buildRenderMesh`, so it is repeated here — a preview that paints
				// what publish will refuse is the opposite of a preview.
				const converted = buildRenderMesh(text);
				if (converted && converted.triangleCount <= MAX_TRIANGLES) {
					setMesh(converted);
					return;
				}

				// Loaded on demand. The loader is three's own, from `examples/jsm`,
				// and has no business in any bundle but this one.
				const { OBJLoader } = await import(
					"three/examples/jsm/loaders/OBJLoader.js"
				);
				if (cancelled) return;
				const parsed = new OBJLoader().parse(text);
				if (parsed.children.length === 0) {
					setError("No geometry in that file.");
				} else {
					setObject(parsed);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [source]);

	if (!source) return null;

	// A finish or door style deleted elsewhere while this is open falls back to
	// the first, rather than painting `undefined`.
	const finish = finishes.find((f) => f.id === finishId) ?? finishes[0];
	const door = doorStyles.find((d) => d.id === doorId) ?? doorStyles[0];
	const hasFronts =
		mesh?.groups.some((g) => g.role === "door" || g.role === "drawerFront") ??
		false;
	const frame = mesh ? previewFrame(mesh.sizeMm) : null;

	// The shadow map only redraws when asked. Swinging doors ask for
	// themselves (`Hinge`, `Slide`); a door style or a hidden front changes
	// what casts without moving anything, so it has to ask here.
	const pickDoor = (id: string) => {
		setDoorId(id);
		markShadowsDirty();
	};
	const pickDoors = (next: Doors) => {
		setDoors(next);
		markShadowsDirty();
	};

	return (
		<div className="flex flex-col gap-2.5">
			<div
				className={`relative overflow-hidden rounded-lg border border-neutral-200 bg-[#f4f2ee] ${className}`}
			>
				{mesh && frame && (
					<Canvas
						dpr={[1, 2]}
						shadows={SHADOW_MAP}
						camera={{ fov: 40, position: frame.camera }}
						resize={CANVAS_RESIZE}
						style={{ width: "100%", height: "100%" }}
					>
						<StudioLighting
							plan={PREVIEW_PLAN}
							ceilingHeightMm={PREVIEW_CEILING_MM}
							quality="low"
						/>
						<mesh rotation-x={-Math.PI / 2} receiveShadow>
							<planeGeometry
								args={[
									PREVIEW_PLAN.widthMm / 1000,
									PREVIEW_PLAN.depthMm / 1000,
								]}
							/>
							<meshStandardMaterial color="#e9e5de" />
						</mesh>
						<DesignedCabinet
							groups={mesh.groups}
							door={door}
							hinge="left"
							open={doors === "open"}
							doorsHidden={doors === "hidden"}
							finishHex={finish.hex}
							finishPhoto={finishPhotos[`finish:${finish.id}`] ?? null}
							sheetOffset={0}
							selected={false}
						/>
						<OrbitControls
							makeDefault
							enablePan={false}
							target={frame.target}
						/>
					</Canvas>
				)}

				{object && (
					<Canvas
						dpr={[1, 2]}
						camera={{ fov: 40, position: [2.8, 2, 3.4] }}
						resize={CANVAS_RESIZE}
						style={{ width: "100%", height: "100%" }}
					>
						<ambientLight intensity={1.1} />
						<directionalLight position={[4, 7, 6]} intensity={1.6} />
						<RawModel object={object} />
						<OrbitControls makeDefault enablePan={false} />
					</Canvas>
				)}

				{(loading || error) && (
					<p
						className={`absolute inset-0 flex items-center justify-center px-4 text-center text-xs ${
							error ? "text-amber-800" : "text-neutral-500"
						}`}
					>
						{error ?? "Reading the model…"}
					</p>
				)}

				{(mesh || object) && (
					<p className="pointer-events-none absolute bottom-1.5 left-0 right-0 text-center text-[10px] text-neutral-400">
						drag to rotate · scroll to zoom
					</p>
				)}
			</div>

			{object && (
				<p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
					Won't convert — the planner will draw this one procedurally.
				</p>
			)}

			{mesh && (
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-1.5">
						{finishes.map((f) => {
							const photo = finishPhotos[`finish:${f.id}`];
							const active = f.id === finish.id;
							return (
								<button
									key={f.id}
									type="button"
									title={f.label}
									aria-label={f.label}
									aria-pressed={active}
									onClick={() => setFinishId(f.id)}
									className={`h-6 w-6 rounded-full border border-neutral-300 bg-center bg-cover ${
										active ? "ring-2 ring-neutral-900 ring-offset-1" : ""
									}`}
									style={{
										backgroundColor: f.hex,
										backgroundImage: photo ? `url(${photo})` : undefined,
									}}
								/>
							);
						})}
						<span className="ml-1 text-[11px] text-neutral-500">
							{finish.label}
						</span>
					</div>

					<div className="flex flex-wrap gap-1.5">
						{doorStyles.map((d) => (
							<button
								key={d.id}
								type="button"
								aria-pressed={d.id === door.id}
								onClick={() => pickDoor(d.id)}
								className={chipClass(d.id === door.id)}
							>
								{d.label}
							</button>
						))}
					</div>

					{hasFronts ? (
						<div className="flex flex-wrap gap-1.5">
							{DOORS.map((d) => (
								<button
									key={d.id}
									type="button"
									aria-pressed={doors === d.id}
									onClick={() => pickDoors(d.id)}
									className={chipClass(doors === d.id)}
								>
									{d.label}
								</button>
							))}
						</div>
					) : (
						<p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
							No doors or drawer fronts recognised in this file, so the finish
							reaches nothing. Check the drafter's part names.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
