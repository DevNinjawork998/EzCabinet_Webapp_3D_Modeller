# FedEx carrier adapter — design

2026-09-22. Adds FedEx as a **domestic Malaysian parcel partner**, beside GDEX
and EasyParcel, behind the existing `CarrierAdapter` contract. International
shipping (customs, HS codes, commercial invoices) is out of scope.

## Why it looks like GDEX

GDEX is the closest existing partner: postcode-and-kilogram pricing, a pickup
booked as part of the booking, a label captured to private Blob at booking
time, tracking by cron poll only. FedEx follows the same shape so the admin
screen treats both the same way (see the "carrier parity over capability"
rule: a feature only one partner supports stays out of the admin UI).

## What was verified, and against what

Credentials in `.env.local` (`FEDEX_API_KEY`, `FEDEX_API_PASSWORD`,
`FEDEX_API_URL`) are **sandbox** credentials: the sandbox issues a token
(`expires_in: 3599`, scope `CXS-TP`); production answers "Sandbox credentials
not allowed in this environment".

The sandbox returns canned responses. Dengkil → KL and Dengkil → Singapore
returned the identical four international services at identical prices, and
Address Validation answered a KL street with `VIRTUAL.RESPONSE`. **Nothing the
sandbox says about Malaysian services or prices is evidence.** Real services
and prices are only visible with production credentials.

Request and response shapes come from FedEx's OpenAPI files, which the docs
site loads and which download without a login:

```
https://developer.fedex.com/wirc/json/api_groups/Rate/RateQuotes-Resource.json
https://developer.fedex.com/wirc/json/api_groups/Ship/Shipment-Resource.json
https://developer.fedex.com/wirc/json/api_groups/Pickup/Pickup-Resource.json
https://developer.fedex.com/wirc/json/api_groups/Track/TrackingNumbers-Resource.json
…/<Group>/<Group>-Common-ErrorMapping.json   (Rate, Ship, Pickup, Track)
```

Enumerations (services, packaging, pickup types, tracking event codes, mock
tracking numbers) come from the API reference guide,
`developer.fedex.com/api/en-my/guides/api-reference.html`.

Facts from those sources this design depends on:

- **Malaysian domestic services:** `FEDEX_PRIORITY` ("Only Malaysia and
  Thailand") for parcels; `FEDEX_PRIORITY_EXPRESS_FREIGHT` (same note) for
  freight. The rest of the APAC list is international.
- `YOUR_PACKAGING`: **68 kg per package**. Malaysia is postal-aware, pattern
  `NNNNN`.
- `requestedPackageLineItems`: **at most 30** per shipment; a line item can be
  several identical packages (`groupPackageCount`).
- Rate: `preferredCurrency` requests a currency. The reply carries a currency
  per amount, and the sandbox examples are USD.
- Ship: `labelResponseOptions` is `LABEL` (base64 per package) or `URL_ONLY`.
  A single merged PDF of every package label is returned **only** with
  `URL_ONLY` + `mergeLabelDocOption: "LABELS_ONLY"`. The reply carries
  `masterTrackingNumber`.
- Pickup: create (`POST /pickup/v1/pickups`) returns `pickupConfirmationCode`
  and `location`; cancel (`PUT /pickup/v1/pickups/cancel`) requires
  `pickupConfirmationCode`, `scheduledDate` and `location`. There is **no
  operation to read back an existing pickup.**
- Track: `POST /track/v1/trackingnumbers`, up to 30 numbers per call, latest
  status in `latestStatusDetail.code` / `derivedCode`.
- Cancel shipment: `PUT /ship/v1/shipments/cancel` with `accountNumber` and
  `trackingNumber`.

## Components

### `src/lib/logistics/adapters/fedex.ts` (new, `server-only`)

**Configuration.**

| Variable | Use |
| --- | --- |
| `FEDEX_API_KEY` | OAuth `client_id` |
| `FEDEX_API_PASSWORD` | OAuth `client_secret` |
| `FEDEX_ACCOUNT_NUMBER` | `accountNumber` on Rate, Ship, Pickup and cancel. **Not yet in `.env.local`.** |
| `FEDEX_API_URL` | Base URL. Unset → `https://apis-sandbox.fedex.com`, so a missing variable can never book a real shipment. |

`isConfigured()` is true only when the key, password and account number are
all set.

**Token.** `POST {base}/oauth/token`, form-encoded `client_credentials`.
Cached in module memory until 60 s before `expires_in`. No database row: there
is no user consent and no refresh token, so losing the cache on a cold start
costs one token call. A 401 from any later call clears the cache and retries
once, since a token can be revoked before it expires. That retry covers only
the token; the booking call itself is never retried (see Book).

**Refusals before any call** (`FedexNotDeliverable`, message shown on the
comparison row, same as `GdexNotDeliverable`):

- no weight on any item;
- any single package over 68 kg;
- more than 30 line items;
- a site or pickup postcode that is not five digits;
- no `scheduledAt`, or a `scheduledAt` in the past (a pickup needs a day).

**Quote.** `POST /rate/v1/rates/quotes` with shipper = pickup place, recipient
= site place, `pickupType: "CONTACT_FEDEX_TO_SCHEDULE"`,
`rateRequestType: ["ACCOUNT"]`, `preferredCurrency: "MYR"`, one line item per
item row (`groupPackageCount` = qty). From the reply:

- choose `FEDEX_PRIORITY`; if absent, the cheapest service returned; if none,
  `FedexNotDeliverable("FedEx priced nothing for this job")`;
- price = that service's `totalNetCharge`. **If its currency is not `MYR`,
  refuse** rather than show a foreign amount labelled RM;
- `quoteRef` = the chosen `serviceType`, so booking uses the service that was
  priced;
- `etaMinutes` stays null (it is a vehicle-partner field); the delivery date,
  when FedEx returns one, goes in `notes`, e.g. `Parcel, 12 kg — FedEx
  Priority, by Thu 24 Sep`.

**Book.** Two calls, all-or-nothing:

1. `POST /ship/v1/shipments` with `serviceType` from `quoteRef`,
   `packagingType: "YOUR_PACKAGING"`, `pickupType:
   "CONTACT_FEDEX_TO_SCHEDULE"`, `shippingChargesPayment.paymentType:
   "SENDER"`, `labelResponseOptions: "URL_ONLY"`, `mergeLabelDocOption:
   "LABELS_ONLY"`, `labelSpecification: { imageType: "PDF", labelStockType:
   "PAPER_4X6" }`. Phones through `toE164` (`phone.ts`). **Never retried**: a
   retried create is a second shipment and a second charge. `carrierFetch`
   already refuses to retry a non-idempotent call.
2. `POST /pickup/v1/pickups` with `readyDateTimestamp` = `scheduledAt`,
   `customerCloseTime` = `WORKSHOP_CLOSE_TIME` (new constant beside
   `WORKSHOP_PHONE` in `carriers.ts`), `carrierCode: "FDXE"`, the pickup
   address and `WORKSHOP_PHONE` as the contact.

If the pickup call fails, the adapter cancels the shipment it just created
and throws with FedEx's pickup message, so the job stays unbooked and the
admin sees why. If that cancel also fails, it throws an error that names the
tracking number, so the admin can void it in FedEx Ship Manager. A shipment
with no pickup is never reported as booked.

Then the merged label URL is fetched once and stored at
`labelPathname("fedex", trackingNumber)` in private Blob. As with GDEX, a
failed label capture does not fail the booking: `labelUrl` comes back null
and the admin prints the label from FedEx Ship Manager.

Returns:

- `carrierOrderId` = `masterTrackingNumber`;
- `trackingUrl` = `https://www.fedex.com/fedextrack/?trknbr=<number>` (a
  public page, so unlike GDEX the customer gets a link);
- `labelUrl` = `/api/admin/deliveries/<id>/label`, or null;
- `pickupRef` = `JSON.stringify({ code, date, location })` (new optional
  field, below).

**Track.** `POST /track/v1/trackingnumbers`, `includeDetailedScans: false`.
Reads `latestStatusDetail.code` and maps it through `status.ts`. A
`TRACKING.TRACKINGNUMBER.NOTFOUND` (or `NOT.FOUND.ERROR`) returns `status: null` with a
message, the way GDEX handles an unknown consignment, and leaves the row
alone.

**Cancel.** Reads `pickupRef` back from the booking event (below), cancels the
pickup, then cancels the shipment. If the pickup cancel fails because the
pickup is already done or past, the adapter still cancels the shipment. If
the shipment cancel fails (FedEx refuses once the parcel is scanned), it
throws with FedEx's message, and `advance/route.ts` already turns that into
`carrier_refused_cancel`.

No `verifyWebhook`: FedEx's push tracking is a separate programme. The 10-min
cron poll covers FedEx the same way it covers GDEX.

### Storing the pickup for cancel

`CarrierBooking` gains one optional, carrier-agnostic field:

```ts
/** Whatever the partner needs later to undo the collection. Opaque to everything but its adapter. */
pickupRef?: string | null;
```

`book/route.ts` already writes `raw: { booking, quote }` on the booking
event, so `pickupRef` is persisted with no schema change. FedEx's `cancel`
finds it with the latest `DeliveryEvent` for the delivery whose `carrierOrderId`
matches and whose `raw.booking.pickupRef` is set. **No migration**, which
matters while `prisma migrate` cannot run non-interactively (Known issue 12).
If a later partner needs the same thing often enough to warrant a column,
promote it then.

### `src/lib/logistics/status.ts`

New `fedex` table, keyed on the event code:

| Ours | FedEx codes |
| --- | --- |
| `BOOKED` | `OC`, `PD`, `DS` |
| `PICKED_UP` | `PU`, `DO`, `IP` |
| `IN_TRANSIT` | `IT`, `AR`, `AF`, `DP`, `TR`, `OD` |
| `DELIVERED` | `DL` |
| `FAILED` | `RS` |
| `CANCELLED` | `CA` |

`DE`, `DD`, `SE` (exceptions) and anything else stay unmapped → null → row
unchanged, per the existing rule in `mapCarrierStatus`.

### Registration

- `carriers.ts`: `{ id: "fedex", label: "FedEx", kind: "parcel" }`, and
  `WORKSHOP_CLOSE_TIME = "18:00:00"` (placeholder, see Open questions).
- `registry.ts`: add `fedex: fedexAdapter`.

### Label capture, generalised

`labelPathname` moves out of `adapters/gdex.ts` into `src/lib/logistics/label.ts`
as `labelPathname(carrierId, number)` → `logistics/<carrierId>/<number>.pdf`.
GDEX's existing paths are unchanged (`logistics/gdex/…`), so no stored label
moves. `label/route.ts` drops its `carrierId !== "gdex"` check and serves any
delivery whose carrier is a `parcel` kind. `DeliveryDetail.tsx`'s "note was not
captured" warning covers both, naming the right portal.

The GDEX-only "Check collection" button and `pickup/route.ts` stay GDEX-only,
since FedEx has no way to read back a pickup. For FedEx, the booking event's
message carries the pickup confirmation code.

### `scripts/fedex-ping.mjs`

Like `gdex-ping.mjs`: token, one Malaysian rate, one track of a mock number
(`918408715227`, "Picked up"). It checks the real reply shape, which CI's
recorded fixtures cannot. Run it before any release that touches the adapter.

## Testing

`src/lib/logistics/__tests__/fedex.test.ts`, stubbed `fetch`, no network,
following `gdex.test.ts`:

- every refusal above, before any fetch;
- rate: picks `FEDEX_PRIORITY`, falls back to cheapest, refuses non-MYR,
  refuses empty;
- book: body shape, never retried, pickup failure cancels the shipment and
  throws, label-capture failure still books;
- token: cached, refreshed near expiry, one retry on 401;
- track: each mapped code, unmapped code → null, unknown number → null;
- cancel: pickup then shipment, reads `pickupRef` from the event, a FedEx
  refusal reaches the caller;
- `status.ts` table test gains the `fedex` rows.

## Going live (outside the code)

1. `FEDEX_ACCOUNT_NUMBER` into `.env.local` and Vercel.
2. Confirm the FedEx project has Rate, Ship, Pickup and Track enabled.
3. **Label certification.** FedEx issues production Ship credentials only
   after submitting sample labels. It can take weeks, so start alongside the build.
4. In Vercel, switch `FEDEX_API_URL` to `https://apis.fedex.com` **and** the
   key/secret to the production pair **together**. Either one alone is
   refused by FedEx.
5. Run `fedex-ping` against production and confirm `FEDEX_PRIORITY` prices in
   MYR for a real lane.

## Open questions

- **The workshop's real street address, phone and closing time.** FedEx takes
  the shipper and pickup address from `WORKSHOP_ADDRESS` /
  `WORKSHOP_POSTCODE` / `WORKSHOP_CITY` and `WORKSHOP_PHONE`, which are
  placeholders (existing open question in `CLAUDE.md`). GDEX avoided this by
  using its account profile. FedEx cannot. `WORKSHOP_CLOSE_TIME` is new and
  also a placeholder.
- **Does EzCabinet's FedEx account actually sell `FEDEX_PRIORITY`
  domestically, and at what price?** Only production credentials or their
  FedEx rep can answer. If it does not, the adapter falls back to the cheapest
  service FedEx offers, which could be an international product priced
  accordingly. The admin sees the price before booking.
- **`FEDEX_PRIORITY_EXPRESS_FREIGHT`** (freight, above 68 kg) could carry
  whole cabinets, which no parcel partner can today. Out of scope here. Worth
  asking EzCabinet whether they want it.
