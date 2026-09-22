# WhatsApp notifications — what EzCabinet must do before go-live

Design: `docs/superpowers/specs/2026-09-22-whatsapp-notifications-design.md`.

The code can be built and tested without any of this. None of it can be done
by us: every item needs EzCabinet's company documents, phone, staff or lawyer.
Tick items off here as they land.

| # | Item | Owner at EzCabinet | Blocks | Status |
| --- | --- | --- | --- | --- |
| 1 | Meta Business verification | Director / admin | Everything | ☐ |
| 2 | Dedicated WhatsApp number | Admin | Everything | ☐ |
| 3 | Access for JNS Nexion (system user + token) | Admin | Sending | ☐ |
| 4 | Payment method on the WhatsApp account | Finance | Sending | ☐ |
| 5 | Template approval, 7 × 3 languages | Admin, with a zh and a ms speaker | Sending | ☐ |
| 6 | The factory's real production steps | Factory manager | Stage messages | ☐ |
| 7 | Sales WhatsApp number for the auto-reply | Sales | Auto-reply | ☐ |
| 8 | Privacy notice sign-off | Counsel | Public launch | ☐ |

---

## 1. Meta Business verification

In **Meta Business Suite** (business.facebook.com), under Security Centre,
verify the business in **EzCabinet Sdn Bhd's legal name**.

Have ready:

- SSM registration (company certificate / Form 9 or Section 17 equivalent)
- A utility bill or bank statement showing the registered address
- A business website on the company's own domain, with the same name and
  address on it
- A company email on that domain, or a company phone that can take a code

Verification is reviewed by Meta and can take several days to a couple of
weeks. It is the longest lead-time item — start it first.

Why it matters: an unverified business is limited to a small number of
customers messaged per day and cannot get a display name approved.

## 2. A dedicated WhatsApp number

A number used with the Cloud API **cannot also be used in the WhatsApp or
WhatsApp Business phone app**. Do not use the number sales already chats on.

- A new mobile or landline number EzCabinet owns long-term. It must be able to
  receive one SMS or voice call for the verification code.
- If the number was ever on WhatsApp, delete that WhatsApp account first.
- **Display name:** what customers see, e.g. "EzCabinet". It must match the
  verified business name or clearly relate to it; Meta approves it.
- A 6-digit two-step verification PIN — record it somewhere safe. Losing it
  locks the number.

## 3. Access for JNS Nexion

In Meta Business Suite, under Business settings:

1. Create a **Meta app** (type: Business) and add the **WhatsApp** product to
   it, linked to EzCabinet's WhatsApp Business Account.
2. Create a **system user** (admin role), assign it the app and the WhatsApp
   Business Account, and generate a **permanent token** with the
   `whatsapp_business_messaging` and `whatsapp_business_management`
   permissions.
3. Send JNS Nexion, **through a password manager or in person — never by
   WhatsApp or email**:

| What | Becomes |
| --- | --- |
| The permanent token | `WHATSAPP_TOKEN` |
| The phone number ID (not the phone number) | `WHATSAPP_PHONE_NUMBER_ID` |
| The app secret (App settings → Basic) | `WHATSAPP_APP_SECRET` |

JNS Nexion then registers the webhook
(`https://<production domain>/api/whatsapp/webhook`) with a verify token it
generates itself.

The token can send messages as EzCabinet to anyone. If a staff member who had
it leaves, revoke and regenerate it.

## 4. Payment method

Add a credit card or payment method to the WhatsApp Business Account. Meta
charges per delivered template message, and every order update is a template
message. Malaysian rates for the **utility** category are on Meta's
WhatsApp pricing page; at this business's order volume the monthly bill is
small, but it is not zero and it is EzCabinet's account that pays it.

## 5. Template approval

Every message the app sends first must be a template Meta has approved. There
are 7, each needed in **English, Simplified Chinese and Bahasa Melayu** — 21
submissions. Submit them in **WhatsApp Manager → Message templates**, category
**Utility**.

The English drafts are below. `{{1}}`, `{{2}}` are the values the app fills in;
keep them exactly where they are. The zh and ms versions need a native speaker
at EzCabinet — keep the same numbered variables in the same meaning.

Each template has one **URL button** with a dynamic suffix: the base URL is
fixed at submission and the app appends the private link token.

| Template name | Button | Button URL |
| --- | --- | --- |
| `order_placed` | View order | `https://<domain>/order/{{1}}` |
| `payment_confirmed` | View order | `https://<domain>/order/{{1}}` |
| `production_stage` | View progress | `https://<domain>/order/{{1}}` |
| `delivery_booked` | Track delivery | `https://<domain>/track/{{1}}` |
| `delivery_picked_up` | Track delivery | `https://<domain>/track/{{1}}` |
| `delivery_delivered` | View delivery | `https://<domain>/track/{{1}}` |
| `delivery_failed` | View delivery | `https://<domain>/track/{{1}}` |

**`order_placed`**
> Hi {{1}}, thank you for your order with EzCabinet. Your order number is
> {{2}}, total RM {{3}}. Please complete the bank transfer shown on your order
> page. We'll message you here as your cabinets are made and delivered.

**`payment_confirmed`**
> Payment received for order {{1}}. Your cabinets are now queued for
> production. We'll update you at each step.

**`production_stage`**
> Update on order {{1}}: your cabinets are now at the {{2}} stage.

**`delivery_booked`**
> Your order {{1}} is ready and delivery is booked with {{2}}. Tracking number:
> {{3}}.

**`delivery_picked_up`**
> Your order {{1}} has been picked up and is on its way to you.

**`delivery_delivered`**
> Your order {{1}} has been delivered. Thank you for choosing EzCabinet.

**`delivery_failed`**
> We couldn't complete the delivery of order {{1}}. Our team will contact you
> to arrange a new time.

Tips that get templates approved first time:

- No promotional wording ("discount", "offer", "don't miss") — that moves a
  template into the Marketing category, which costs more and can be refused.
- Provide sample values when Meta asks for them (e.g. `IC-20260922-001`).
- A rejected template can be edited and resubmitted; the reason is shown in
  WhatsApp Manager.

Once approved, send JNS Nexion the final zh and ms wording so the app's copy
matches what Meta approved.

## 6. The factory's real production steps

The design uses placeholders:

**In queue → Cutting → Edging → Assembly → Quality check → Ready**

EzCabinet's factory manager should confirm:

- The real steps, in order, and what each is called on the floor.
- What a customer should see for each — the floor's name may not be the right
  customer-facing word.
- The zh and ms name for each (these fill `{{2}}` in `production_stage`).
- Which steps are worth a message. Every step is a message on the customer's
  phone; five or six over two weeks is fine, ten is spam.

## 7. Sales WhatsApp number

The number customers are sent to when they reply to an update — normally the
number sales already uses on their phones. Give it in full international form,
e.g. `+60 12-345 6789`.

## 8. Privacy notice sign-off

`/[lang]/privacy` is already a draft awaiting EzCabinet's counsel. It gains a
paragraph saying order updates are sent through WhatsApp, operated by Meta,
to customers who tick the box at checkout. Counsel approves the wording along
with the rest of the notice; Meta's WhatsApp Business terms are accepted in
EzCabinet's legal name during step 1.
