# Translation review — for EzCabinet

## What this is

The planner site (EzCabinet's cabinet planner) is now available in three
languages: English, Simplified Chinese, and Bahasa Malaysia. All the Chinese
and Malay copy was drafted by AI, not by a native speaker or someone from your
team. Before this goes live in front of customers, we'd like someone at
EzCabinet to read through the list below and tell us what to change.

**What was translated:** every piece of UI text a customer reads — the
homepage, the room planner, the quote/price breakdown, the tutorial library,
buttons, headings, form labels, error messages.

**What was deliberately left in English, on purpose:** cabinet family names,
finish names (e.g. "Rhone Oak"), door style names, and tutorial video titles.
Those are your product names and your content — we don't think a translation
agency should be renaming them, and changing them could make it harder to
match a customer's screen to your own price list or catalogue. If you'd
rather these were localised too, let us know and we'll scope it separately.

**Chinese is Simplified Chinese** (used in mainland China and commonly
understood by Malaysian Chinese speakers), not Traditional. If your customers
would expect Traditional characters, say so and it's a small change.

**There are roughly 170 translated strings in total.** This document is not
all of them — it's the ~25 that matter most: the ones where getting the
wording wrong could cost a sale or make the page look unprofessional to
someone who knows the trade. The rest are lower-stakes (button hover states,
loading messages, aria labels for accessibility) and we're comfortable
shipping those as drafted.

**How to send corrections back:** for each row, just tell us what the
Chinese or Malay should say instead. You don't need to touch anything
technical — write it in a message, a spreadsheet, whatever's easiest. Every
one of these lives in a single line of a single file, so a correction costs
us minutes, not a rebuild.

---

## Review list

| Key | English | 中文 | Bahasa Malaysia | What to check |
| --- | --- | --- | --- | --- |
| `landing.faq.a3` | Solid carcasses with a choice of veneer, laminate or painted finishes. | 实心柜体，可选贴皮、防火板或喷漆等多种表面处理 | Badan kabinet solid dengan pilihan kemasan venir, laminat atau bersalut | Core trade vocabulary: "solid" (实心/solid), "veneer" (贴皮), "laminate" — Chinese uses 防火板 (literally "fireproof board", the common trade term for laminate boards in this region) rather than a direct 层压板. Confirm 防火板/laminat are the words your fitters and suppliers actually use, not just technically-correct equivalents. |
| `tutorials.categories.island`, `landing.gallery.roomSubtitle` (kitchen family) | Islands / kitchen island cabinets | 中岛柜 | Pulau dapur | Flagged by the translator as low-confidence. Kitchen islands are a newer layout in Malaysian homes, so "中岛柜" and "Pulau dapur" may not be the terms your customers search for or your team uses day to day. Alternative for BM: "kabinet pulau". |
| `planner.price.lines.endPanels`, `quote` breakdown | End panels | 收边板 | Panel hujung | The translator did not have your in-house term for this line item. BM alternative considered: "papan hujung". This is a line on the actual price breakdown a customer sees before paying — wrong or unfamiliar wording here looks like a typo on a quote. |
| `planner.price.detail.endPanelsOne/Other` | "{count} panel(s) over exposed sides" | {count} 块，用于外露侧面 | {count} panel pada sisi terdedah | The Chinese counter 块 is the generic word for "a piece/slab of something flat" — correct but generic. An alternative is 块封边板 (repeating "end panel" with the counter), which reads more precisely on a price line but is longer. Confirm which reads better on your actual quote screen. |
| `planner.unit` / `planner.units` (BM only) | unit / units | (n/a — Chinese doesn't inflect) | unit kabinet | We deliberately wrote "unit kabinet" instead of the plain word "unit" so our test suite could confirm the Malay text wasn't secretly just the English word. A Malaysian reader may find plain "unit" completely natural and prefer it. This is genuinely your call, not a translation-quality question — either is defensible. |
| `planner.crumbs.studio` | Studio | 设计工作台 | Ruang reka | This is the name of the main screen where a customer arranges cabinets — it appears in the breadcrumb at the top of the whole planner. There's no fixed industry term for it in either language; this is a best guess at register, not a verified term of art. |
| `planner.room.hanging` / `toCeiling` | Hanging / To ceiling | 悬挂式 / 顶天式 | Tergantung / Sampai ke siling | Cabinet-fitting terminology (wall units hung with a gap under the ceiling vs. built flush to it). Exactly the kind of term your own fitters would recognise instantly if we got it wrong. |
| `planner.room.skirted` / `legsShown` | Skirted / Legs shown | 带踢脚板 / 外露支脚 | Berpapan kaki / Kaki ditunjukkan | Same category — whether base cabinets have a kick board hiding the levelling legs, or the legs are left visible. Please confirm against your actual construction vocabulary. |
| `planner.room.openEnds` / `toWalls` | Open ends / To walls | 两端开放 / 紧靠侧墙 | Hujung terbuka / Sampai ke dinding | Whether a cabinet run's ends are left open (needing a finishing panel) or butt into a side wall. Same family of fitting terms as above — worth checking together. |
| `landing.gallery.roomAlt` | "{room} cabinets" | {room}橱柜 | kabinet {room} | This is an image `alt` text that glues your catalogue's own room name onto a Chinese/Malay suffix. It reads fine for the four preset rooms (kitchen, living, bedroom, foyer) but hasn't been checked against every actual room label that could appear here. |
| `landing.facts.typicalDeliveryValue`, `landing.faq.a1` | 4-6 weeks / "arrive within 4-6 weeks" | 4 至 6 周 / "...4 至 6 周内送达" | 4-6 minggu | **This is a delivery-time promise shown on the homepage.** Confirm 4–6 weeks is still accurate — if actual lead times have changed, this needs updating regardless of the wording. Also flagging a style choice: Chinese uses the fully-worded "至" rather than a bare "4-6" hyphen form; Malaysian retail signage often prefers the terser hyphen form. |
| `landing.facts.warrantyValue`, `warrantyLabel`, `landing.faq.a5` | 5 years / "Warranty on hardware and build" | 5 年 / 五金与结构保修 | 5 tahun / Waranti perkakasan dan binaan | **This is a warranty claim shown on the homepage and in the FAQ.** Please confirm 5 years, and "hardware and construction/build" as the scope, matches what EzCabinet actually offers — this is a promise to a customer, not just a translated sentence. |
| `landing.hero.cta`, `landing.nav.startPlanning`, `landing.closing.cta` | Start planning | 开始设计 | Mula reka bentuk | The single most important click on the whole homepage — every path into the planner starts here. Not flagged as a translation-confidence issue, but worth a native read specifically for whether it makes someone want to click, not just whether it's correct. |
| `quote.submitCta` | Send my design for a quote | 发送我的设计以索取报价 | Hantar reka bentuk saya untuk sebut harga | The final call to action on the whole site — this is the button that turns a browser into a lead. Please read it the way a customer would, at the moment they're about to hand over their contact details. |
| `planner.price.cta` | Get a quote for this design | 为此设计索取报价 | Dapatkan sebut harga untuk reka bentuk ini | Secondary CTA shown alongside the live price estimate while the customer is still building their design. |
| `quote.heading`, `quote.description` | "Get a real quote on this {room}" / "...calls you with a firm price — usually within one business day." | 为这间{room}索取正式报价 / "...随后致电为您提供确定价格——通常在一个工作日内完成。" | Dapatkan sebut harga sebenar untuk {room} ini / "...biasanya dalam masa satu hari bekerja." | **"Usually within one business day" is a response-time promise**, made on the page right before a customer submits their phone number. Confirm this matches your actual sales process — this reads as a commitment, not a translation nuance. |
| `quote.remeasureNote`, `quote.notAQuoteNote`, `planner.price.placeholderNote` | "A designer may re-measure on site — final price can change from this estimate." / "Placeholder rates — not a quote until EzCabinet confirms." | 设计师可能会到场重新测量——最终价格可能与此预估不同。 / 暂定价格——须经 EzCabinet 确认后方为正式报价。 | Pereka bentuk mungkin akan mengukur semula di tapak... / Kadar sementara — bukan sebut harga sehingga disahkan oleh EzCabinet. | These three lines are the disclaimer that the on-screen price is an estimate, not a firm quote — legally and commercially the most important sentence on the page. Please read carefully in both languages to make sure it's unambiguous, not just grammatically correct. |
| `planner.price.lines.carcasses` | Carcasses | 柜体 | Badan kabinet | Core trade term — the cabinet box itself, before doors/worktop/trim. This is a line on the price breakdown. |
| `planner.price.lines.doors` | Doors | 门板 | Pintu | Same — confirm 门板 (door panel/front) is the term you'd use on an actual invoice, versus a plainer 门. |
| `planner.price.lines.worktop` | Worktop | 台面 | Meja atas | Trade term for the countertop spanning a run of base cabinets. Confirm against your own price-list wording. |
| `planner.price.lines.ceilingTrim`, `skirting` | Ceiling trim / Skirting | 封顶收边条 / 踢脚板 | Jalur kemasan siling / Papan kaki | Two more price-breakdown line items — the trim strip capping a run at the ceiling, and the kick board hiding the legs at floor level. |
| `quote.frontsLabel` | "{label} fronts" (e.g. "Oak fronts") | {label}门板 | pintu {label} | This combines your own door-style name (left in English, on purpose — see note above) with translated surrounding text. Reads fine grammatically in testing, but hasn't been checked against every real style name in your catalogue for awkward combinations. |
| `tutorials.categories.wall`, `base`, `drawer` | Wall cabinets / Base cabinets / Drawers | 吊柜 / 地柜 / 抽屉柜 | Kabinet atas / Kabinet bawah / Laci | Basic cabinetry vocabulary used as filter labels on the public tutorials page — low risk of being wrong, but worth a fast confirm since it's the first trade vocabulary a browsing customer sees. |
| `tutorials.copyright`, `landing.footer.copyright` | "© 2026 {brand}. All rights reserved." / "© {brand}" | © 2026 {brand}。版权所有。 / © {brand} 版权所有 | © 2026 {brand}. Hak cipta terpelihara. / © Hak cipta {brand} | These two copyright lines were deliberately worded differently from each other (and across languages) only so an automated check could confirm neither language was accidentally left in English. The client may prefer one consistent short form used everywhere instead. |
| `planner.selection.nameWidth` (BM) | "{name} · {width} mm" | {name} · {width} 毫米 | {name} ({width} mm) | Not flagged by the translator, but worth a look: the Malay version uses parentheses where English and Chinese use a "·" separator. Minor, but it's the kind of small inconsistency worth deciding on once rather than leaving to chance. |

---

## A note on cost of change

Every row above is one line in a plain text file
(`src/lib/copy/zh.ts` or `src/lib/copy/ms.ts`). Changing any of them is a
one-line edit with no code change and no risk to how the site works — we can
turn around a batch of corrections the same day you send them.
