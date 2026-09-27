# Stripe integration — remaining steps

Stripe is the **sandbox-test gateway**. EzCabinet may replace it with Fiuu
(a Malaysian gateway, account in progress), so Stripe is built as one
adapter behind a gateway contract — see [Swapping gateways](#swapping-gateways--adding-fiuu).

## Values to Replace

The following values must be set before testing. **None of the Checkout
Session parameters are placeholders** — see the note under the table.

**Files containing placeholders:**
- [.env.example](.env.example) — copy the names into `.env.local` (local) and the Vercel project (Preview/Production)

| Field | Current Value | What to Set |
|-------|--------------|-------------|
| `STRIPE_SECRET_KEY` | *(empty)* | `sk_test_…` from https://dashboard.stripe.com/test/apikeys. Server only. |
| `STRIPE_PUBLISHABLE_KEY` | *(empty)* | `pk_test_…` from the same page. Passed to the browser at runtime, so no `NEXT_PUBLIC_` prefix. |
| `STRIPE_WEBHOOK_SECRET` | *(empty)* | `whsec_…` for the endpoint `/api/webhooks/payment/stripe` (Dashboard → Workbench → Webhooks), or from `stripe listen` locally. |

**`mode` and `line_items` are not placeholders.**
- **`mode`** is `"payment"`, because an order is a one-time charge. So `payment_method_collection` is left out; it only applies to subscriptions.
- **`line_items`** does not use a `price_…` Price ID. The total differs for every design, so it uses `price_data`: one line, MYR, `unit_amount` = the order's stored `totalRm` in sen. `POST /api/orders` priced that total on the server. A fixed Price ID would charge the wrong amount, so do not replace it.

## Configured Parameters

These parameters were configured in Checkout Studio and are already set correctly.

**Files containing these parameters:**
- [src/lib/payments/stripe.ts](src/lib/payments/stripe.ts): session parameters and API version
- [src/app/[lang]/order/[token]/StripeForm.tsx](src/app/[lang]/order/[token]/StripeForm.tsx): Stripe.js, beta flag, appearance

| Parameter | Value |
|-----------|-------|
| ui_mode | `form` (stripe-node 22.6.2 ≥ 21.0.0) |
| billing_address_collection | `auto` |
| phone_number_collection | `{ enabled: false }` |
| automatic_tax | `{ enabled: false }` |
| submit_type | `auto` |
| shipping_address_collection | `{ allowed_countries: ["MY"] }` |
| name_collection | `{ individual: { enabled: true } }` |
| saved_payment_method_options | `{ payment_method_save: "enabled" }` |
| integration_identifier | `custom_embedded_web_0001` |
| API version | `2026-03-25.dahlia; custom_checkout_payment_form_preview=v1` |
| Stripe.js | `https://js.stripe.com/dahlia/stripe.js`, `betas: ["custom_checkout_payment_form_1"]` |
| appearance | `stripe` theme, spaced inputs, PT Serif, `#0570de` primary |

The code also sets `client_reference_id`, `metadata.orderId` / `orderRef`, `customer_email` (pre-filled from the order) and `return_url`.

## Setup

1. Stripe test account → enable **FPX**, **cards** and **GrabPay** under Settings → Payment methods. The form shows whatever is enabled there; the code lists no methods.
2. Which gateway is live is the **`payment-gateway` Vercel flag**, not an env var — see [Gateway feature flag](#gateway-feature-flag). `.env.local` holds only keys:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PUBLISHABLE_KEY=pk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
3. Local webhooks: `stripe listen --forward-to localhost:3000/api/webhooks/payment/stripe`. It prints the `whsec_…` to use.
4. Vercel: add the same four variables to **Preview** only while testing, and register a webhook endpoint for the preview URL. Deployment protection blocks Stripe's webhook, so add a protection bypass for that path or test locally.
5. Dependency already installed: `stripe@22.6.2`.

## Project structure

```
src/lib/payments/
  types.ts        the PaymentGateway contract: start() / verify() / ack()
  registry.ts     payment-gateway flag → adapter; gatewayById for webhooks
src/flags.ts      the payment-gateway flag (Vercel Flags)
src/app/.well-known/vercel/flags/route.ts   Flags Explorer discovery
  stripe.ts       the Stripe adapter (only file importing the stripe SDK)
src/lib/orders/markPaid.ts                   the one AWAITING_PAYMENT → PAID write (+ WhatsApp)
src/app/api/orders/[token]/pay/route.ts      start paying: gateway.start(order)
src/app/api/webhooks/payment/[gateway]/route.ts  verify → amount check → markOrderPaid
src/app/[lang]/order/[token]/OnlinePayment.tsx   gateway-neutral: embedded form or hosted-page redirect
src/app/[lang]/order/[token]/StripeForm.tsx      Stripe's iframe form only
```

The admin **Mark paid** button (`/api/admin/orders/[id]/paid`) now calls the same `markOrderPaid`.
`next.config.ts` CSP allows `js.stripe.com` / `api.stripe.com`, and
`Permissions-Policy: payment` lets Stripe's iframe offer wallets.

## How it works

1. The customer places an order (`POST /api/orders`). It is priced on the server and stored as `AWAITING_PAYMENT`. They land on `/[lang]/order/[token]`.
2. If the `payment-gateway` flag serves a gateway whose keys are set, the page shows **Pay online** instead of the bank transfer details. `OnlinePayment` calls `POST /api/orders/[token]/pay`. That route builds a Checkout Session from the stored total and returns `{ kind: "stripe-form", publishableKey, clientSecret }`.
3. `StripeForm` mounts Stripe's form. On confirm, Stripe redirects back to the order page with `?paid=1`. That flag only changes the wording to "Confirming your payment".
4. Stripe calls `/api/webhooks/payment/stripe`. The route checks the signature, checks the amount equals the order total in MYR, and calls `markOrderPaid`. That sets PAID, `paymentProvider = "stripe"` and `paymentRef = pi_…`, and queues the WhatsApp message in the same transaction. A mismatch is logged and never marked paid. A retry is a no-op.

**The browser return never marks anything paid.** Only the verified webhook does.

## Testing

- Card `4242 4242 4242 4242`, any future expiry, any CVC → paid.
- Card `4000 0025 0000 3155` → 3-D Secure challenge.
- Card `4000 0000 0000 9995` → declined; the order stays awaiting.
- FPX in test mode → pick any bank, then authorise or fail on Stripe's test page.
- Refresh the order page after paying. It should read "Order confirmed", and `/admin/orders` should show it paid.
- `pnpm exec vitest run src/app/api/webhooks/payment` covers forged signature, amount mismatch, matching payment and an unknown gateway.
- **Check first:** `saved_payment_method_options.payment_method_save` may require a Stripe Customer on the session. If session creation errors on it, add `customer_creation: "always"` in `stripe.ts`.

## Gateway feature flag

`payment-gateway` (string) on Vercel Flags, declared in [src/flags.ts](src/flags.ts):

| Environment | Serves |
|-------------|--------|
| development | `stripe` |
| preview | `stripe` |
| production | `manual` (bank transfer) |

- **Switch with no redeploy:** `vercel flags set payment-gateway --environment production --variant stripe`, or from the dashboard.
- **Try before customers:** a team member can override the flag in their own browser from Flags Explorer (Vercel Toolbar on a preview deployment). This lets you test Fiuu on a deployment while customers still get Stripe.
- **Safe defaults:**
  - If Vercel Flags cannot answer, the flag serves `manual`.
  - A variant with no adapter, or an adapter without keys, also falls back to bank transfer. Checkout never breaks on a flag.
- **The flag only chooses where new payments start.** Keys stay in env vars, and webhooks ignore the flag (`gatewayById`), so payments begun before a switch still get confirmed.
- **Local:** evaluated with `VERCEL_OIDC_TOKEN` from `.env.local`. It expires; re-pull if the flag starts serving `manual` unexpectedly. **Do not `vercel env pull` straight into `.env.local`**, which overwrites your local-only secrets. Pull to another file and copy the lines across.
- **Toolbar in production:** Flags Explorer works on previews out of the box. Production would need `<VercelToolbar />` in the layout, which is left out so the public bundle doesn't grow.

## Swapping gateways / adding Fiuu

Every gateway is one adapter implementing `PaymentGateway` (`lib/payments/types.ts`). The adapter owns only what differs between gateways: how to start, how to verify, how to acknowledge. The rules that must not differ live outside any adapter, in the webhook route: amount must match, one write path, idempotent, return URL never trusted.

**Adding Fiuu** (once the merchant account exists):

1. `src/lib/payments/fiuu.ts`, with `fiuuGateway(): PaymentGateway | null`, reading `FIUU_MERCHANT_ID`, `FIUU_VERIFY_KEY`, `FIUU_SECRET_KEY` and `FIUU_SANDBOX`.
   - **`start`** returns `{ kind: "redirect", method: "POST", url: <hosted payment page>, fields }`. The fields are amount, `orderid` = order.id, bill_name / bill_email / bill_mobile, `currency: "MYR"`, `returnurl`, `callbackurl` = `notifyUrl`, and `vcode`. `OnlinePayment` already renders that as a form. Nothing client-side is Fiuu-specific.
   - **`verify`**: Fiuu posts `x-www-form-urlencoded`, so parse `rawBody` with `URLSearchParams`. Recompute `skey`; a mismatch throws `BadSignature`. Map status `00` → paid, `11` → failed, `22` → pending.
   - **`ack`**: Fiuu's IPN wants an acknowledgement and retries every 15 minutes, 4 times max, until it gets one.
   - Take the exact `vcode` / `skey` formulas, the sandbox/production URLs and the ACK format **from Fiuu's merchant docs when the account is issued**. Do not copy them from memory or from this file.
2. Add one line in `registry.ts`: `fiuu: fiuuGateway`.
3. Add a return route. Fiuu's return URL is a **browser POST**, and a Next page only answers GET. Add `src/app/api/orders/[token]/return/route.ts` answering POST (and GET) with a 303 to `/[lang]/order/[token]?paid=1`, and pass that as `returnUrl` from `pay/route.ts`.
4. CSP: add Fiuu's payment host to `form-action` in `next.config.ts`, or the browser blocks the redirect form.
5. Fiuu sandbox needs **IP whitelisting** with their support before demo banks work.
6. Write a test like `route.test.ts` against a Fiuu-signed body.
7. Add a `fiuu` variant (`vercel flags update payment-gateway`) and to the `options` in `src/flags.ts`, try it with a Flags Explorer override, then `vercel flags set payment-gateway --environment production --variant fiuu`. Leave Stripe's keys in place until in-flight Stripe payments have settled: its webhook keeps working through `gatewayById` while the Fiuu page takes new payments.

**Removing Stripe:**
1. Delete `lib/payments/stripe.ts` and its line in `registry.ts`.
2. Delete `StripeForm.tsx` and its branch in `OnlinePayment.tsx`, plus the `stripe-form` member of `PaymentStart`.
3. Delete the Stripe hosts in `next.config.ts` and the `STRIPE_*` variables.
4. Run `pnpm remove stripe`.

No order, admin or delivery code changes. `Order.paymentProvider` keeps the history of which gateway took each payment.

## Next steps

- Refunds: none yet, in the app or at the gateway. The re-measure question in CLAUDE.md ("What happens when a paid design changes?") becomes a refund question once money is taken online.
- The order page's "Confirming your payment" wording relies on the customer refreshing the page. Add polling if webhooks prove slow.
- `lib/orders/payment.ts` `BANK_TRANSFER` is still a placeholder; it remains the fallback whenever no gateway is set.

## Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
- Fiuu: https://github.com/FiuuPayment/Cheatsheet-BestPractices-Fiuu_API
