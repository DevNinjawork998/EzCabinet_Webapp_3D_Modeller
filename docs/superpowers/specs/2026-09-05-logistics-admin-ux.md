# Deliveries screen — UX spec

**Surface:** `/admin/logistics` (`LogisticsManager.tsx`, `/api/admin/deliveries*`)
**Audience:** three internal admins at EzCabinet, on a laptop, booking a
lorry while a customer waits on the phone.

## What went wrong in testing

A job was created with an address the geocoder could not place. The detail
panel said:

> Site address did not resolve to a map location. Vehicle partners price by
> coordinate, so only own lorry can be booked — edit the address, or paste a pin.

There was no way to edit the address. The instruction named an action the
screen did not offer. That is the seed of this spec; reading the code turned up
four more of the same shape — the screen knows something the admin needs and
does not say it, or says it and gives them nothing to do about it.

## Problems, in the order they bite

1. **No edit.** `PATCH /api/admin/deliveries/[id]` has existed and accepts
   DRAFT and QUOTED jobs. Nothing in the UI called it. The only recovery was
   delete and retype.

2. **A pasted pin can vanish silently.** `parseCoords` accepts exactly
   `"3.15, 101.59"`. Anything else — a Google Maps link, a pin with a place
   name, a stray degree sign — returns null, and null is indistinguishable from
   "left blank". The admin sees the save succeed and the job still unlocated,
   with nothing said about why. What a phone actually puts on the clipboard
   from Maps is a URL, so this is the common case, not the edge.

3. **"Did not resolve" has two very different causes.** With no
   `GOOGLE_GEOCODING_API_KEY`, `geocodeAddress` returns null for every address
   ever typed, and the screen blames the admin's typing. `isGeocodingConfigured()`
   exists and nothing renders it.

4. **The pickup pin is never checked.** The panel warns only about the site.
   The default pickup is `WORKSHOP_ADDRESS` — "EzCabinet Sdn Bhd, Klang
   Valley, Selangor" — which is a placeholder that does not geocode to a
   point. So every job has an unlocated pickup, Lalamove needs both stops as
   coordinates, and the screen says nothing.

5. **The list says nothing about any of this.** Pin trouble is only visible
   after opening a row, so a list of jobs cannot be triaged.

6. **Error codes reach the admin.** `setError(body?.error ?? …)` prints
   `invalid_body` and `not_found`.

7. **`prompt()` for the actor name** on every status advance, and `bookedBy`
   is retyped for every booking. It is the same three people all day.

## What "better" means here

- Anything the screen asks for, the screen offers. No instruction naming an
  action that does not exist.
- A refusal says which of the two it is: we cannot look addresses up at all,
  or we looked this one up and could not place it.
- Nothing an admin typed is discarded without a word.
- Triage from the list. Open a row to act, not to find out.

## Explicitly out of scope

- Search, filters, pagination on the delivery list. Three admins and a handful
  of open jobs; add it when the list is long enough to scroll.
- A map picker. A pasted pin plus a maps link covers it, and an embedded map
  is an API key, a bundle, and a component to maintain.
- Editing a booked job. The carrier holds those details; the API refuses, and
  it is right to.
- Fixing `WORKSHOP_ADDRESS` / `WORKSHOP_PHONE`. Those are the client's real
  address and line — an open question in CLAUDE.md, not a code change. This
  spec only makes the consequence visible.
