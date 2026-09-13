"use client";

import { type InputHTMLAttributes, useRef, useState } from "react";

/**
 * A millimetre figure that is typed, then committed — on Enter or blur, never
 * per keystroke. Every commit moves a cabinet and the engine clamps it, so
 * typing "1" on the way to "1500" would slam the cabinet into the wall and
 * leave it there.
 *
 * Its own file, not `PositionDimensions.tsx`: the side panel uses it too, and
 * importing it from there would drag drei out of the lazy 3D bundle.
 */
export function GapInput({
	valueMm,
	onCommit,
	onDone,
	...rest
}: {
	valueMm: number;
	onCommit: (mm: number) => void;
	/** After a commit or a cancel — the chip uses it to fold back to a label. */
	onDone?: () => void;
} & Omit<
	InputHTMLAttributes<HTMLInputElement>,
	"type" | "value" | "onChange" | "onBlur" | "onKeyDown"
>) {
	const [draft, setDraft] = useState<string | null>(null);
	const cancelled = useRef(false);

	return (
		<input
			{...rest}
			type="number"
			inputMode="numeric"
			min={0}
			value={draft ?? Math.round(valueMm)}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					cancelled.current = true;
					e.currentTarget.blur();
				}
			}}
			onBlur={() => {
				if (!cancelled.current && draft !== null && draft.trim() !== "") {
					onCommit(Number(draft));
				}
				cancelled.current = false;
				setDraft(null);
				onDone?.();
			}}
		/>
	);
}
