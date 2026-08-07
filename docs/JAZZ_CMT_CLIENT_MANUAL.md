# Jazz CMT — Client Portal Manual (Reference)

Condensed from the vendor PDF (*Campaign Management Tool — Client Manual*, Jazz Business). This
covers the **web portal** (connect.jazzcmt.com) itself — for the programmatic SMS-sending API, see
[`JAZZ_SMS_API.md`](./JAZZ_SMS_API.md) instead.

> **Note on IP whitelisting**: this manual does **not** mention any IP whitelist / authorized-IP setting
> anywhere. We checked the portal itself (Reports, Settings, FAQs) too — nowhere is one exposed to
> clients. If the API returns `IP not authorized`, that has to be resolved by contacting Jazz's
> support/account team directly with the server's public IP — it is not something configurable from
> this portal or documented here.

## Dashboard

The landing page after login. Quick-access tiles: **Send SMS**, **Campaign Logs**, **Address Book**,
**Contacts Book**, **Payments**, **SMS API Logs**. Plus six usage graphs: Top Masks (last 7 days),
Purchased History, API Usage, Campaigns, USSD Channel Usage, Top USSD (last 7 days).

## Sending SMS from the portal (3 campaign types)

| Type | Use case | How |
|---|---|---|
| **Static** | Same message to many numbers | Pick a Mask, write/select a message, add recipients via comma-separated numbers, an Address Book group, or an uploaded text file |
| **Dynamic (English)** | Personalized message per recipient | Download the sample CSV, fill in per-row data, upload it, pick a Mask. Don't remove the CSV's existing columns — you can only add new ones alongside them |
| **Dynamic (Urdu)** | Same as above, in Urdu | Same flow, but with a sample **XLSX** file instead of CSV |

All three: send immediately or schedule for later ("Schedule Time").

## Address Book / Groups

- **Address Book Contacts**: store individual contacts (name, email, phone) one at a time or in bulk via
  `.xlsx`/`.txt` upload (sample files downloadable from the same screen).
- **Groups**: organize contacts into named groups (e.g. "coworkers", "customers") so a campaign can
  target a whole group at once instead of pasting numbers manually. Supports bulk add/export via CSV.

## SMS Inbox / Prefix

- **SMS Inbox**: shows inbound (mobile-originated / "P2A") messages sent by customers to your
  assigned short/long codes.
- **Prefix**: lets you tag specific reply keywords (e.g. "YES", "NO") on a short code and see stats on
  how many people replied with that word — useful for opt-in/opt-out or simple poll-style replies.

## Reports

- **Purchased Bucket History** — every SMS bundle/Bolton ever bought: price, purchase date, expiry,
  remaining balance.
- **TOTAL SMS Campaign Logs** — every campaign (name, Mask, start date, status), with day/week/
  month/year totals. Actions per campaign: export CSV, resend, view details, see per-message counts.
- **Single Campaign Details** — for one campaign: how many messages were sent, charged, and failed,
  plus which on-net numbers were promotionally blocked.
- **SMS API Logs** — the log for messages sent via the *API* (not the portal UI) — day/week/month/year
  totals, filterable by date/number/Mask/status, exportable to CSV. This is the page to check when
  verifying whether our backend's Jazz integration actually delivered a message.

## SMS Templates

Save reusable message bodies (≤160 characters) so you don't retype the same text every campaign.
Editable and deletable individually or in bulk.

## Voice (not used by our integration — reference only)

- **Voice Templates**: upload a `.wav` prompt for voice campaigns. Requires Jazz's approval (shows
  green "Approved" once cleared) before it can be used.
- **Voice Inbox**: inbound responses/keypresses against assigned short codes for voice campaigns.
- **Voice Campaigns**: logs and status of voice broadcasts, exportable as CSV.
- **Voice API**: same idea as the SMS API, but for triggering voice campaigns — see the separate Voice
  API docs if this is ever needed (out of scope for OTP).

## Change Password

Under Settings → Change Password. You can change **either** the Portal login password **or** the API
password independently — pick which one from the "Password Type" dropdown before entering the old/
new password. Password rules: 1 capital letter, 1 number, 1 special character (`!@#%^&*().`), minimum
8 characters.

⚠️ If the **API** password is ever changed here, `JAZZ_CMT_PASSWORD` in the backend's `.env` must be
updated to match, or every send will start failing with an auth error.
