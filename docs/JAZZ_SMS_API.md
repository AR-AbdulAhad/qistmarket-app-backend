# Jazz CMT SMS API — Reference

Condensed from the vendor PDF (*Jazz Business — SMS Sending API Document, v1.0, Operational
Department - Mobilink, 06-08-2020*). This is our own internal summary for implementation reference —
if behavior ever seems to contradict this doc, trust a fresh test against the live API over this file.

## 1. Sending an SMS — Direct (GET) API

Simplest option: a single GET request, no XML/SOAP needed.

```
https://connect.jazzcmt.com/sendsms_url.html
    ?Username=<CMS portal username, e.g. 03xxxxxxxxx>
    &Password=<CMS portal password>
    &From=<approved sender Mask, e.g. QistMarket>
    &To=<recipient, e.g. 03xxxxxxxxx>
    &Message=<message text>
    &Identifier=<optional, cannot be 0>
    &UniqueId=<optional, cannot be 0>
    &ProductId=<optional, cannot be 0>
    &Channel=<optional, cannot be 0>
    &TransactionId=<optional, cannot be 0>
```

**All values must be URL-encoded**, including the message text and any special characters in it.

### Response (plain text body)

| Code | Meaning |
|---|---|
| — | `The "FROM" Field is empty...` |
| — | `The "TO" Field is empty...` |
| — | `The "MESSAGE" Field is empty...` |
| — | `Your account is expired please contact Admin` |
| — | `Message contains banned words` (e.g. sex, porn) |
| — | `Invalid Username/Password` |
| — | `Mask not allowed!` (mask not assigned to this account) |
| — | `Insufficient Funds` (balance exhausted) |
| — | **`Message Sent Successfully!`** ← the only success case |
| — | `The "Identifier"/"UniqueId"/"ProductId"/"Channel"/"TransactionId" Field is 0...` (if provided, these optional fields must be non-zero) |

The Direct API's response is a plain string, not a structured code — **match on the exact success
string `Message Sent Successfully!`**, don't try to parse a numeric status code from this endpoint
(that only exists on the XML API, see below).

## 2. Sending an SMS — XML API

Same data, sent as XML via POST instead of a query string. Use this if a structured, code-based
response is needed.

**Target URL:** `https://connect.jazzcmt.com/sendsms_xml.html`
**POST field:** `xmldoc=<your XML>` (must be sent as a POST body field, not a query string)

```xml
<SMSRequest>
  <Username>03xxxxxxxxx</Username>
  <Password>xxxxxx</Password>
  <From>QistMarket</From>
  <To>03xxxxxxxxx</To>
  <Message>Hi, this is a test message</Message>
  <urdu>0</urdu>              <!-- 1 = Urdu message -->
  <statuscode>1</statuscode>  <!-- 1 = ask for numeric status code back -->
  <Identifier>xxxxxx</Identifier>       <!-- optional, cannot be 0 -->
  <UniqueId>xxxxxx</UniqueId>           <!-- optional, cannot be 0 -->
  <ProductId>xxxxxx</ProductId>         <!-- optional, cannot be 0 -->
  <Channel>xxxxxx</Channel>             <!-- optional, cannot be 0 -->
  <TransactionId>xxxxxx</TransactionId> <!-- optional, cannot be 0 -->
</SMSRequest>
```

### Response (XML)

```xml
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE response SYSTEM "response.dtd">
<response>
  <statuscode>300</statuscode>
  <statusmessage>Message Sent Successfully!</statusmessage>
  <messageid>XXXXX</messageid>
  <originator>03xxxxxxxxx</originator>
  <recipient>03xxxxxxxxx</recipient>
  <responsedatetime>2020-03-15 02:35:12</responsedatetime>
  <messagedata>Hi, this is a test message.</messagedata>
</response>
```

**`300` is the only success code.** Everything else is a failure — check `statuscode`, not the message
text, when parsing programmatically.

| Code | Meaning |
|---|---|
| 300 | ✅ Message sent successfully |
| 301 | From field is empty |
| 302 | To field is empty |
| 303 | Message field is empty |
| 304 | Invalid username/password |
| 305 | Mask not correct / not assigned |
| 306 | Account expired |
| 307 | Number is blocked (promotional message opted out) |
| 308 | Message contains banned words |
| 309 | To-number is banned |
| 310 | SMS balance is 0, or account is inactive |
| 311 | Username field is empty |
| 312 | Password field is empty |
| 313 | Duplicate message — same message sent again within 30 seconds |
| 314 | Identifier field is 0 (must be non-zero if provided) |
| 315 | UniqueId field is 0 |
| 316 | ProductId field is 0 |
| 317 | Channel field is 0 |
| 318 | TransactionId field is 0 |

A SOAP-wrapped variant of the same XML exists too (`sendsms_xml_soap.html?wsdl`, function
`sendXML(YOURXML)`) — same payload and response codes, just invoked over SOAP instead of plain POST.
Not needed unless something specifically requires SOAP.

## 3. Balance check

```
GET https://connect.jazzcmt.com/request_sms_check.html?Username=...&Password=...
```

Returns two comma-separated numbers: `<Bolton SMS balance>, <Bundle SMS balance>` (e.g. `499930, 919`).
Empty/wrong username or password returns an error string instead.

## 4. Receiving inbound SMS (not used for OTP — reference only)

XML POST to `https://connect.jazzcmt.com/receivesms_xml.html` (or the SOAP variant
`receivesms_xml_soap.html?wsdl`, function `receiveXML(...)`), with `Username`, `Password`, `Shortcode`,
and optionally `FromDate`/`ToDate` for a historical pull instead of real-time. Only relevant if this
system ever needs to receive inbound SMS on an assigned shortcode — not part of the OTP-sending flow.

## 5. Other endpoints in the vendor doc (not currently planned for use)

- **Group sending** (`sendsms_group.html`) — send to a saved contact group by name instead of a single
  number.
- **International sending** (`int_api.html`) — same as Direct API but recipient number must include a
  country code (e.g. `0044...`).
- **.txt file upload campaign** (`upload_txt.html`) — bulk campaign from an uploaded number list.
- **Voice broadcast** (`voice_api/voice_api_file_upload.html`) — automated voice call campaigns.

None of these are relevant to single-recipient OTP delivery — listed here only so nobody re-reads the
full vendor PDF looking for something already covered.

## Credentials

Jazz CMT username/password/Mask are per-account and must never be committed to the repo. Store them as
environment variables (see whatever naming convention `.env`/`.env.example` already uses for other
providers in this project, e.g. `WATI_API_KEY`) — something like `JAZZ_SMS_USERNAME`,
`JAZZ_SMS_PASSWORD`, `JAZZ_SMS_MASK`.
