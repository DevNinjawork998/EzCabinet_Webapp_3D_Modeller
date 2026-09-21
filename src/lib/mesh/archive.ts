import { unzipSync } from "fflate";

/**
 * A design export is a folder — `FLAT PACK.obj`, `FLAT PACK.mtl` and every
 * texture it references — so intake takes the zipped folder rather than a
 * lone `.obj`. The textures are the only place the real finish names survive
 * (`Rhone Oak.jpg`, `Strata Noir.jpg`); the `.mtl` calls the same materials
 * `7#752#-1`.
 *
 * The bytes never reach the 3D scene. This reads names and text out of the
 * archive and drops the image data on the floor — see CLAUDE.md, "design
 * files are intake, not runtime assets".
 */

export type MeshArchive = {
	objName: string;
	objText: string;
	/** Texture filenames, in archive order. Finish candidates for a human. */
	imageNames: string[];
};

const IMAGE = /\.(png|jpe?g|webp|tga|bmp)$/i;

/**
 * The most a design archive may inflate to, images excluded — they are
 * skipped, never decompressed. A whole wall run's `.obj` is a few MB of text;
 * past this it is a zip bomb or a file with the furniture library left in,
 * and inflating it would take the function's memory down first.
 */
export const MAX_INFLATED_BYTES = 100 * 1024 * 1024;

/** Editor cruft, not content. */
const isNoise = (path: string) =>
	path.endsWith("/") || /(^|\/)(__MACOSX\/|\._|\.DS_Store$)/.test(path);

export function readArchive(bytes: Uint8Array): MeshArchive {
	const imageNames: string[] = [];
	let inflated = 0;

	// One pass. The filter runs for every entry, so it is also where the
	// texture names get collected — decompressing a 30 MB texture folder just
	// to read its filenames would be the whole cost of the import for nothing.
	const files = unzipSync(bytes, {
		filter: ({ name, originalSize }) => {
			if (isNoise(name)) return false;
			if (IMAGE.test(name)) {
				imageNames.push(basename(name));
				return false;
			}
			inflated += originalSize;
			if (inflated > MAX_INFLATED_BYTES) {
				throw new Error("archive too large once unzipped");
			}
			return true;
		},
	});

	const objName = Object.keys(files).find((name) =>
		name.toLowerCase().endsWith(".obj"),
	);
	if (!objName) {
		throw new Error("no .obj in the archive — zip the whole export folder");
	}

	// The `.mtl` is deliberately not read. Its materials are exporter ids
	// (`7#752#-1`) pointing at re-encoded texture copies, so it can name
	// neither a finish nor a panel — the texture filenames above are the only
	// thing in the archive that carries a real name.
	return {
		objName: basename(objName),
		objText: new TextDecoder().decode(files[objName]),
		imageNames,
	};
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The `.obj` text, whichever shape the design arrived in.
 *
 * The upload forms take a bare `.obj` *or* a `.zip` of the whole export
 * folder, so every reader has to handle both or half the files an admin can
 * attach come back empty. The filename is no help — a stored design keeps its
 * original name in the blob's content disposition and a route only ever has
 * bytes — so the archive is recognised by its magic number instead.
 *
 * `PK\x03\x04` is the local file header every zip starts with.
 */
export function objTextFromBytes(bytes: Uint8Array): string {
	const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
	return zipped ? readArchive(bytes).objText : new TextDecoder().decode(bytes);
}
