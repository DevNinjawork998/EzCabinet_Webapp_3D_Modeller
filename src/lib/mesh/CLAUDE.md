# Design intake (`lib/mesh`)

How an OBJ export becomes catalogue data and a drawable mesh. Loaded only when
working under `src/lib/mesh/` — the rules that govern what the *planner* does
with the result stay in the root `CLAUDE.md` under "3D".

## Every stage infers, none assumes

The admin keeps adding designs, so each import is a file nobody has seen. A
`.skp` gave cabinets for free — component instances *are* cabinets — but an OBJ
is one flat namespace of boxes with no units and no up-axis. So:

- **Scale** (`normalise.ts`) is found by trying mm/cm/inch/metre and keeping the
  one that puts the modal panel thickness in 12–25mm. Board thickness is a
  constant of the trade; model size is not.
- **Up-axis** is found by settling *depth first* (this product plans one wall, so
  depth is the smallest extent) and then voting between the two axes left, on
  which one panels are thin on. Voting across all three gets it wrong on a real
  file, because doors and backs are thin on depth and outvote the shelves.
- **Which end is the wall.** A *named* front wins — if the drafter typed
  `Door_L_`, that panel's side is the front, full stop. `inferFrontSide` is the
  fallback, and it deliberately ignores anything standing on the floor: feet are
  hardware by every test but a leveller sits under the middle of the carcass and
  says nothing about which way it faces. Four of them with no knobs flipped the
  client's `BC 800mm.obj` back to front.
- **Getting this wrong is now visible, not subtle.** Mirroring the depth axis
  reverses triangle winding, so the indices are emitted backwards to compensate;
  without that every normal points inward and the cabinet renders black.
- **Panel roles** (`roles.ts`) come from one ordered naming table, with a
  geometric fallback. `NAMING_RULES` is the only place cabinet semantics live; a
  drafter who renames something is an edit there and nowhere else.
- **Cabinets in a run** (`strategies.ts`) are found by three strategies,
  best-first: gaps between end panels (high confidence), connected components of
  touching panels (medium), the whole file as one row (low).

Finish names do not survive the export: materials come through as `7#752#-1`
pointing at re-encoded texture copies. The real names survive only as the texture
filenames in the folder. Finishes are set by hand in the admin; do not try to
auto-map them.

## One intake path: upload converts, publish rebuilds

**A design file is one cabinet.** `/admin/cabinet-designs` uploads it and
`POST /api/admin/cabinet-designs` calls `lib/catalogue/convertDesign.ts` in the
same request: `measureDesign` reads the fit-out and `renderMesh` writes the
drawable mesh, both onto the row (`geometry`, `meshPathname`). A file that is not
one cabinet — far wider than its row, or taller than any room — is refused and
the row is not kept. The bytes are re-fetched from Blob; trust comes from the
file, never from what a client claims about it.

`measureDesign` deliberately skips the run-grouping. Over a lone cabinet
`byEndPanels` measures the opening *between* the end panels, so an 800 carcass
reports 768 — its clear width, minus two 16mm boards. The form wants the size on
the invoice, which is the bounding box. `coalesceParts` unions the records an
exporter split a panel into (safe here because it is one cabinet; across a run it
would merge neighbours).

**Publishing merges nothing.** `lib/catalogue/buildCatalogue.ts` rebuilds the
catalogue's families from every active design row — one design, one family, one
size, and the family id *is* the design id — and carries door styles, finishes,
rates and room walls over from the published version. Name, all-in price, box
and rooms come from the row the admin typed; only the fit-out and the mesh come
from the file.

This replaced `mergeIntoCatalogue` and the whole-run `/admin/import` (deleted
September 2026), which matched designs into existing families by shape within
20mm. On the first real uploads it folded BC 600 / 800 / 900 into the seed's
invented `base-cabinet`, kept that family's invented prices and 607×880 box
over the ones typed at upload, and left no screen showing which cabinet was
real. `read.ts` and the run strategies in `strategies.ts` are left over from that
import with no caller in the app; remove them once that is certain.
