"use client";

import { EffectComposer, N8AO, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";

/**
 * Ambient occlusion for devices that measured fast enough — the dark creases
 * where a cabinet meets the wall, the floor and its neighbour, which is most of
 * what makes a render read as a photograph.
 *
 * Default export and imported only through `React.lazy`, so the postprocessing
 * code is its own chunk and a phone on the `low` tier never downloads it.
 *
 * The composer renders the scene into an offscreen target, and three only tone
 * maps when drawing to the screen, so tone mapping is re-applied here as the
 * last effect — the same Neutral curve `StudioLighting` sets, or the `high`
 * tier's colours would not match `low`'s.
 */
export default function HighQualityEffects() {
	return (
		<EffectComposer multisampling={4}>
			<N8AO halfRes aoRadius={0.4} distanceFalloff={1} intensity={2} />
			<ToneMapping mode={ToneMappingMode.NEUTRAL} />
		</EffectComposer>
	);
}
