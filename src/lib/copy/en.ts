/**
 * The English dictionary, and the shape every other locale is held to.
 *
 * Values are plain strings — never functions. The dictionary is handed from a
 * server component into `CopyProvider`, so it crosses the RSC boundary and has
 * to serialise. Strings needing a number carry a `{token}` and go through
 * `fill`.
 */
export const en = {
	meta: {
		title: "EzCabinet · Design your kitchen in 3D",
		description:
			"Drop real EzCabinet units onto a model of your own room, see it from every angle, and get an instant price. No showroom visit required.",
	},
	common: {
		brand: "EzCabinet",
		back: "Back",
		next: "Next",
		close: "Close",
		language: "Language",
		comingSoon: "Coming soon",
	},
	landing: {
		nav: {
			howItWorks: "How it works",
			gallery: "Gallery",
			finishes: "Finishes",
			faq: "FAQ",
			tutorials: "Tutorials",
			menu: "Menu",
			startPlanning: "Start planning",
			admin: "Admin",
		},
		hero: {
			eyebrow: "Free to try · no account needed",
			titleBeforeAccent: "Design your kitchen",
			titleAccent: "in 3D",
			subtitle:
				"Drop real EzCabinet units into your own room, see the price move as you build, and send us the plan.",
			cta: "Start planning",
			howItWorks: "How it works",
			alt: "A finished EzCabinet kitchen",
		},
		facts: {
			cabinetsFromLabel: "Cabinets from",
			typicalDeliveryValue: "4-6 weeks",
			typicalDeliveryLabel: "Typical delivery",
			warrantyValue: "5 years",
			warrantyLabel: "Warranty on hardware and build",
			noAccountValue: "No account",
			noAccountLabel: "Needed to plan and price",
		},
		how: {
			heading: "Three steps from an empty wall to a quote",
			step1Title: "Pick your room",
			step1Detail:
				"Choose kitchen, living room, bedroom or foyer, and set your real wall dimensions.",
			step2Title: "Drop in cabinets, to scale",
			step2Detail:
				"Arrange real EzCabinet units in 3D and swap finishes until it looks right.",
			step3Title: "Get an instant quote",
			step3Detail:
				"See a live price as you build, then send your plan straight to our team.",
		},
		gallery: {
			heading: "Explore by room",
			subtitle:
				"Every room starts from real EzCabinet sizes and a layout already on your wall.",
			roomAlt: "{room} cabinets",
			roomSubtitle: {
				kitchen: "Real EzCabinet sizes",
				living: "TV ledge & display units",
				bedroom: "Wardrobes",
				foyer: "Shoe cabinets & bench",
			},
		},
		finishes: {
			heading: "Finishes & materials",
			subtitle: "Swap finishes on any cabinet right inside the planner.",
		},
		faq: {
			heading: "Frequently asked questions",
			q1: "How long does delivery take?",
			a1: "Most orders arrive within 4-6 weeks of confirming your plan, depending on finish and cabinet size.",
			q2: "Can I get cabinets installed too?",
			a2: "Yes. Installation can be added when you send your plan to our team for a final quote.",
			q3: "What are the cabinets made of?",
			a3: "Solid carcasses with a choice of veneer, laminate or painted finishes. The full range is in the planner.",
			q4: "Can I change my design after ordering?",
			a4: "Changes are free before production starts. Our team will confirm your plan with you first.",
			q5: "Do you offer a warranty?",
			a5: "Every cabinet comes with a 5-year warranty on hardware and construction.",
		},
		closing: {
			heading: "Your wall, your sizes, your price. In about five minutes.",
			subtitle: "Nothing to install and nothing to sign up for.",
			cta: "Start planning",
		},
		footer: {
			tagline:
				"Custom cabinets, planned in 3D and built to your room's real dimensions.",
			productHeading: "Product",
			startPlanning: "Start planning",
			gallery: "Gallery",
			faq: "FAQ",
			tutorials: "Tutorials",
			contactHeading: "Contact",
			email: "hello@ezcabinet.com",
			privacy: "Privacy",
			adminSignIn: "Admin sign in",
			copyright: "© 2026 {brand}. All rights reserved.",
		},
	},
	planner: {
		crumbs: {
			roomPlanner: "Room planner",
			studio: "Studio",
			quote: "Quote",
		},
		breadcrumbAriaLabel: "Breadcrumb",
		admin: "Admin",
		changeRoom: "Change room",
		diyTutorials: "DIY tutorials",
		clear: "Clear",
		dimensionAriaSuffix: "{label} in millimetres",
		tools: {
			ariaLabel: "Tools",
			select: "Select",
			add: "Add",
			room: "Room",
			measure: "Measure",
			view: "View",
			doors: "Doors",
			defaults: "Setup",
			selectTitle: "Select and move cabinets",
			addTitle: "Add cabinet",
			roomTitle: "Room size: wall, ceiling and depth",
			measureTitle: "Measure between two points",
			viewTitle: "View: 3D, elevation or plan",
			doorsTitle: "Doors: open, closed or hidden",
			defaultsTitle: "Defaults for the whole run",
		},
		panel: {
			sideHint: "Flat onto the side wall.",
			close: "Close panel",
			addTitle: "Add a cabinet",
			addHint:
				"Click one to drop it at the end of the run, or drag it onto the wall.",
			viewTitle: "View",
			viewHint: "How the room is drawn.",
			threeDHint: "See the room as it will look.",
			elevationHint: "Flat front-on — best for sizing.",
			planHint: "From above — best for depth and walkways.",
			resetView: "Reset view",
			resetViewHint: "Re-frame the whole run.",
			doorsTitle: "Doors",
			doorsHint:
				"Applies to every unit. One cabinet's doors open from its own Open doors action.",
			defaultsTitle: "Defaults for this run",
			defaultsHint: "Set once, applies to everything — placed or not.",
		},
		start: {
			heading: "What room are you planning?",
			subtitle: "Pick one to start on an empty wall with real EzCabinet sizes.",
			roomIconAlt: "{room} icon",
			roomSubtitle: {
				kitchen: "Real EzCabinet sizes",
				living: "TV ledge & display units",
				bedroom: "Wardrobes",
				foyer: "Shoe cabinets & bench",
			},
			cta: "Start planning",
		},
		room: {
			fitFree: "{mm} mm of wall still free.",
			fitOver:
				"The run is {mm} mm longer than the wall. Remove a cabinet or lengthen the wall.",
			moreSettings: "Skirting, ends, hang height…",
			heading: "The room",
			subtitle: "Sets the space every cabinet has to fit in.",
			wallLength: "Wall length",
			ceiling: "Ceiling",
			roomDepth: "Room depth",
			shape: "Layout",
			shapeStraight: "One wall",
			shapeLeft: "L, corner on the left",
			shapeRight: "L, corner on the right",
			shapeLocked: "Clear the side wall and corner to go back to one wall.",
			sideWallLength: "Side wall length",
			wallUnitsHangAt: "Wall units hang at",
			narrowWallNote:
				"Your {min}mm run sets the shortest wall it fits on. Remove or resize a cabinet to go narrower.",
			wallUnitsAria: "Wall units",
			hanging: "Hanging",
			toCeiling: "To ceiling",
			undersidesNote:
				"Undersides at {height}mm — the tops run to the ceiling, capped by a trim strip.",
			flushWallUnitTops: "Flush wall-unit tops to tall units",
			addTallFirst: "Add a tall cabinet or fridge housing first",
			baseUnitsAria: "Base units",
			skirted: "Skirted",
			legsShown: "Legs shown",
			kickBoardNote: "A kick board runs along the floor, hiding the levellers.",
			levellersNote: "The adjustable levellers stay on show under the run.",
			runAria: "Run",
			openEnds: "Open ends",
			toWalls: "To walls",
			noPanelNeededNote:
				"An end that butts into a side wall needs no finished panel.",
			panelNeededNote:
				"Each open end is finished with a panel over the carcass side.",
			doorsAria: "Doors",
			doorsClosed: "Doors closed",
			doorsOpen: "Doors open",
			doorsHidden: "Doors hidden",
			frontsOffNote:
				"Fronts are off, so the whole run is on show at once. Two doors that hinge on the same stile cannot both swing open, which is why this view takes them away instead.",
			interiorsShownNote:
				"Shelves and interiors are on show. Measuring closes them again.",
			openDoorsNote:
				"Open the doors, or take the fronts off, to see inside the run.",
			overhangWarning:
				"The run overhangs this wall by {overhang}mm — close the gaps below, or remove a cabinet.",
		},
		view: {
			side: "Side wall",
			ariaLabel: "View",
			threeD: "3D",
			elevation: "Elevation",
			plan: "Plan",
		},
		addCabinets: {
			targetWall: "Add to",
			mainWall: "Main wall",
			sideWall: "Side wall",
			heading: "Add cabinets",
			subtitle: "Drag onto the wall. Size and front come after.",
			sizeRange: "{min}–{max}mm · from {price}",
			widthPrice: "{width}mm · {price}",
			categories: {
				BASE_CABINET: "Base cabinets",
				WALL_CABINET: "Wall cabinets",
				TALL_CABINET: "Tall cabinets",
				DRAWER_BASE: "Drawer bases",
				FRIDGE_HOUSING: "Fridge housings",
				CORNER_BASE_CABINET: "Corner base cabinets",
				CORNER_WALL_CABINET: "Corner wall cabinets",
			},
		},
		canvas: {
			selectHint: "Click a cabinet to select it · right-click for its actions",
			runOfWall: "{run} m run of {wall} m wall",
			loading: "Loading 3D view…",
		},
		measure: {
			tooltip:
				"Click two points on a cabinet — a corner, an edge midpoint, or the surface — to measure between them",
			measuring: "Measuring…",
			measure: "Measure",
			constrainLabel: "Constrain the measurement",
			clickToStart: "Click a point to start measuring",
			clickSecondPoint: "Click a second point",
			hintMeasuring:
				"Click two points on a cabinet — a corner, an edge midpoint or the surface. Auto locks the second point to the axis you are measuring along; Free reads all three at once.",
			hintDefault:
				"Click a cabinet to change its size or front. Drag it along the wall to move it.",
		},
		selection: {
			hangAtThis: "This one hangs at",
			swapLeft: "Swap with the cabinet on its left",
			swapRight: "Swap with the cabinet on its right",
			swapHint:
				"The arrows trade places with the cabinet beside it, so a packed run stays packed. Type a figure to put it somewhere with room.",
			verbResize: "Resize",
			verbReplace: "Replace",
			verbMove: "Move",
			verbOpenDoors: "Open doors",
			verbCloseDoors: "Close doors",
			moveMeta: "arrows + mm",
			replaceHeading: "Replace with",
			positionHeading: "Position",
			gapLeft: "Gap left",
			gapRight: "Gap right",
			editGap: "Edit distance",
			widthHint:
				"Neighbours stay put — a size with no room for it is greyed out. {name} comes in {n} widths.",
			moveHintFloor:
				"The arrows slide it along the wall and lift it off the floor. The ring turns it.",
			moveHintWall:
				"The arrows slide it along the wall and set its hang height. The ring turns it.",
			hangsAt: "hangs at {mm} mm",
			standsAt: "This one stands at",
			turnedBy: "Turned by",
			sizeRangeMeta: "{min}–{max} mm",
			heading: "Selected cabinet",
			emptyHint: "Click a cabinet in the room to size it or change its front.",
			nameWidth: "{name} · {width} mm",
			width: "Width",
			noRoom: "no room",
			front: "Front",
			swing: "Swing",
			closeDoor: "Close door",
			openDoor: "Open door",
			hingeLeft: "Hinge left",
			hingeRight: "Hinge right",
			duplicate: "Duplicate",
			remove: "Remove",
			nSelected: "{n} cabinets selected",
			removeAll: "Remove all {n}",
		},
		design: {
			heading: "This design",
			hint: "Click a cabinet in the room to size it, swap it or move it.",
			room: "Room",
			wall: "Wall",
			run: "Run",
			wallFree: "Wall free",
			overBy: "over by {mm} mm",
			finish: "Finish",
			addCabinet: "Add a cabinet",
		},
		finish: {
			heading: "Front finish · whole run",
			currentLabel: "{label} · one colour for the whole room",
		},
		run: {
			heading: "Your run · {count} {unit}",
			closeGaps: "Close gaps",
			closeGapsCount: "Close gaps ({n})",
			selectAria: "Select {name}",
			noDoorInline: "no door",
			emptyHint: "Nothing placed yet — drag a carcass onto the wall.",
			reset: "Reset this room",
		},
		price: {
			breakdown: "Breakdown",
			breakdownTitle: "What makes up {total}",
			trimStrip: "a trim strip capping the run at the ceiling",
			skirtingBoard: "a skirting board over the legs",
			endPanels: "a finished panel over each cabinet side left in the open",
			and: "and",
			includedAboveSingular: "is included above.",
			includedAbovePlural: "are included above.",
			estimatedTotal: "Estimated total",
			estimateBadge: "ESTIMATE",
			placeholderNote:
				"Placeholder rates — not a quote until EzCabinet confirms.",
			cta: "Get a quote for this design",
			lines: {
				carcasses: "Carcasses",
				doors: "Doors",
				worktop: "Worktop",
				ceilingTrim: "Ceiling trim",
				skirting: "Skirting",
				endPanels: "End panels",
			},
			detail: {
				unitCountOne: "{count} unit",
				unitCountOther: "{count} units",
				noDoors: "none chosen yet",
				doorCountOne: "{count} door",
				doorCountOther: "{count} doors",
				lengthRate: "{ft} ft @ RM {rate}/ft",
				endPanelsOne: "{count} panel over exposed sides",
				endPanelsOther: "{count} panels over exposed sides",
			},
		},
		unit: "unit",
		units: "units",
	},
	quote: {
		loading: "Loading…",
		backToEditing: "Back to editing",
		savedHeading: "Saved — for this demo only",
		savedBody:
			"Lead capture isn't wired to EzCabinet yet (that's a later phase of this build). Nothing was sent anywhere.",
		heading: "Order this {room}",
		description:
			"Place the order, then pay by bank transfer. A designer confirms your measurements on site before anything is built.",
		fullName: "Full name",
		phone: "Phone (WhatsApp)",
		email: "Email",
		area: "Area",
		siteAddress: "Delivery address",
		addressNotes: "Access notes — unit, gate code, lift",
		remeasureNote:
			"I understand a designer re-measures on site before production and will contact me if the design has to change.",
		saved: "Saved",
		submitCta: "Place order",
		submitting: "Placing your order…",
		errorGeneric: "We couldn't place your order. Please try again.",
		errorPhone:
			"That phone number doesn't look right. Include the area code, like 012-345 6789.",
		errorDesign:
			"Something in this design can't be ordered as it stands. Go back to editing and check your cabinets.",
		subtotal: "Cabinets",
		delivery: "Delivery",
		total: "Total",
		summary: "{room} · {wall} m wall · {count} {unit}",
		noFrontsYet: "no fronts chosen yet",
		frontsLabel: "{label} fronts",
		mixedFronts: "mixed fronts",
		estimatedTotal: "Estimated total",
		estimateBadge: "ESTIMATE",
		notAQuoteNote: "Not a quote until confirmed on site.",
	},
	tutorials: {
		eyebrow: "Learn",
		heading: "DIY tutorials",
		subtitle:
			"Step-by-step videos for building and installing EzCabinet units yourself, from a first flat-pack carcass to fitting a full run.",
		allTypes: "All types",
		allLevels: "All levels",
		emptyNoTutorials: "Tutorials are being filmed. Check back soon.",
		emptyNoMatches: "No tutorials match those filters yet.",
		loadingPlayer: "Loading player…",
		copyright: "© {brand}",
		backToSite: "Back to site",
		categories: {
			base: "Base cabinets",
			wall: "Wall cabinets",
			wardrobe: "Wardrobes",
			drawer: "Drawers",
			island: "Islands",
		},
		levels: {
			beginner: "Beginner",
			intermediate: "Intermediate",
			advanced: "Advanced",
		},
	},
	/** The page a customer lands on after checkout, reached by its public token. */
	order: {
		breadcrumb: "Order confirmation",
		headingAwaiting: "Order placed — awaiting payment",
		bodyAwaiting:
			"Thanks, your order is saved. Transfer the total below to confirm it.",
		headingPaid: "Order confirmed",
		bodyPaid: "Payment received. Your cabinets are going into production.",
		headingCancelled: "Order cancelled",
		bodyCancelled:
			"This order was cancelled. Get in touch if that isn't what you expected.",
		orderId: "Order ID",
		copyOrderId: "Copy order ID",
		copied: "Copied",
		summaryHeading: "Order summary",
		qty: "Qty {count}",
		subtotal: "Subtotal",
		delivery: "Delivery",
		total: "Total",
		totalPaid: "Total paid",
		addressHeading: "Delivery address",
		payHeading: "Pay by bank transfer",
		payBank: "Bank",
		payAccountName: "Account name",
		payAccountNumber: "Account number",
		payReference: "Reference",
		payAmount: "Amount",
		payNote:
			"Use your order ID as the transfer reference so we can match your payment. We'll contact you once it arrives, usually within one working day.",
		nextHeading: "What happens next",
		stagePaid: "Payment received",
		stageMeasure: "Site re-measure",
		stageMeasureDetail:
			"A designer confirms your measurements before production.",
		stageBuild: "Cabinets built in our workshop",
		stageDelivery: "Delivery to your site",
		trackDelivery: "Track your delivery",
		backToPlanner: "Back to planner",
		backHome: "Back to home",
	},
	/**
	 * The delivery tracking page a customer reaches from their link.
	 *
	 * Status names are the ones the app stores, translated here rather than
	 * shown as the carrier spelled them: a partner writes "ON_GOING" in English
	 * regardless of who is reading, and a page that renders the raw word loses
	 * the locale on the one screen a customer opens more than once.
	 */
	track: {
		breadcrumb: "Order confirmation",
		headingPlaced: "Order placed",
		bodyPlaced: "Thanks — we've got your order and we're getting it ready.",
		headingDelivered: "Delivered",
		bodyDelivered: "Your cabinets have arrived. Thanks for choosing us.",
		headingStopped: "Delivery on hold",
		bodyStopped:
			"This delivery didn't go through. Our team will call you to sort it out.",
		orderId: "Order ID",
		copyOrderId: "Copy order ID",
		copied: "Copied",
		summaryHeading: "Order summary",
		qty: "Qty {count}",
		noItems: "The job sheet is still being finalised.",
		addressHeading: "Delivery address",
		statusHeading: "Delivery status",
		etaHeading: "Estimated delivery",
		etaPending: "To be confirmed",
		carrierRef: "{carrier} · {reference}",
		carrierBooked: "Delivered by {carrier}",
		timelineEmpty: "Nothing to show yet.",
		/* Before a carrier holds the job there is no tracker to draw, so the
		   card says what we do know and what happens next. */
		awaitingHeading: "Delivery",
		awaitingEtaHeading: "Expected window",
		awaitingStatus: "Being arranged",
		awaitingCarrier: "Partner not booked yet",
		stagePlaced: "Order placed",
		stageBuilding: "Cabinets being built",
		stageBuildingDetail: "In the workshop now",
		awaitingNote:
			"A delivery partner is booked once your cabinets are built. The moment that happens, the tracking appears here and we send you the link.",
		awaitingNoteSub:
			"Usually two to three working days before your delivery window. Nothing is needed from you until then.",
		backToPlanner: "Back to planner",
		backHome: "Back to home",
		status: {
			DRAFT: "Being arranged",
			QUOTED: "Being arranged",
			BOOKED: "Order placed",
			DRIVER_ASSIGNED: "Driver assigned",
			PICKED_UP: "Picked up",
			IN_TRANSIT: "In transit",
			DELIVERED: "Delivered",
			CANCELLED: "Cancelled",
			FAILED: "Failed",
		},
	},
	/**
	 * The analytics consent banner. PDPA s.129: the transfer outside Malaysia
	 * is named in the banner itself, not only behind the link.
	 */
	consent: {
		title: "Help us improve the planner",
		body: "Allow us to record how you use the planner and any errors, processed by PostHog in the EU (outside Malaysia). Nothing you type is included. If you decline, we only count visits, without cookies.",
		accept: "Allow",
		reject: "Decline",
		learnMore: "Privacy notice",
	},
	/** Draft wording — EzCabinet's counsel approves it before production. */
	privacy: {
		title: "Privacy notice",
		draft:
			"Draft — pending review by EzCabinet Sdn Bhd before it takes effect.",
		intro:
			"This notice explains what the EzCabinet planner records when you use it, and why.",
		purposeHeading: "Why",
		purpose: "To find where the planner is confusing or broken, and fix it.",
		collectHeading: "What we record",
		collect:
			"Which screens you open, the design choices you make (room, cabinets, sizes, finish, doors), the estimated price, the type of device and browser, and technical errors the planner hits. If you allow it, we also keep a short recording of the page — with everything you type hidden — when an error happens, so we can see what went wrong.",
		notCollectHeading: "What we never record",
		notCollect:
			"Your name, phone number, email or address from the quote form are not sent to our analytics provider. We do not keep your IP address in analytics.",
		whereHeading: "Who processes it, and where",
		where:
			"Usage data is processed by PostHog Inc. on servers in the European Union (Frankfurt), under a data processing agreement. This means the data is transferred outside Malaysia. The website itself is hosted by Vercel.",
		choiceHeading: "Your choice",
		choice:
			"If you decline, we only count visits without cookies or local storage, with an identifier that resets daily, and no recordings are made. You can change your choice at any time by clearing this site's data in your browser.",
		contactHeading: "Contact",
		contact: "Questions, or requests to access or correct your data: {email}",
		back: "Back to home",
	},
} as const;

/**
 * Every leaf of `en`'s shape must be a string, at whatever depth it sits.
 * Groups nest further than two levels (e.g. `landing.hero.title`), so this
 * recurses rather than fixing a depth.
 */
type Leaves<T> = {
	readonly [K in keyof T]: T[K] extends string ? string : Leaves<T[K]>;
};

export type Dictionary = Leaves<typeof en>;
