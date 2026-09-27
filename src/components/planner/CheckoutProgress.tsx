/**
 * Details → Payment → Done, shared by the checkout form and the order page.
 * Takes its labels rather than reading `useCopy`, so the server-rendered order
 * page can use it too.
 */
export function CheckoutProgress({
	labels,
	ariaLabel,
	step,
}: {
	labels: readonly string[];
	ariaLabel: string;
	/** Index of the current step; every earlier one shows a tick. */
	step: number;
}) {
	return (
		<ol
			aria-label={ariaLabel}
			className="hidden items-center gap-1.5 text-[12px] md:flex"
		>
			{labels.map((label, i) => (
				<li
					key={label}
					aria-current={i === step ? "step" : undefined}
					className={`flex items-center gap-1.5 px-1 ${
						i === step ? "font-semibold text-[#171717]" : "text-[#737373]"
					}`}
				>
					<span
						className={`flex h-[18px] w-[18px] items-center justify-center rounded-full font-semibold text-[10px] ${
							i <= step
								? "bg-[#171717] text-white"
								: "bg-[#e5e5e5] text-[#525252]"
						}`}
					>
						{i < step ? "✓" : i + 1}
					</span>
					{label}
				</li>
			))}
		</ol>
	);
}
