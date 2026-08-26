# send-sms — KaamAI OTP delivery hook (WhatsApp-first, SMS fallback via MSG91)

Supabase Auth generates the 6-digit OTP and calls this Edge Function to **deliver**
it. It sends over **MSG91 WhatsApp first** and falls back to **MSG91 SMS** if
WhatsApp fails. Supabase still generates and verifies the OTP, so nothing in the
app's auth/session/RLS changes — this function is only the delivery pipe.

The dev **test phone number** set in Supabase bypasses this hook (Supabase returns
a fixed code without sending), so you can test the whole app flow without spend.

## One-time setup

1. **MSG91 account** — sign up at msg91.com and get your **Auth Key**.
2. **WhatsApp (preferred channel)**
   - Register a WhatsApp Business sender (integrated number) in MSG91.
   - Create + get approval for a WhatsApp **authentication** template with an OTP
     variable (and, typically, a copy-code button).
3. **SMS fallback**
   - Complete **India DLT** registration (PE-ID, 6-char sender header, approved
     OTP content template). Real SMS will not deliver without this.
   - Create an MSG91 **Flow** template tied to your DLT template; note its
     `template_id` and the OTP variable name.

## Deploy

```bash
# from the repo root, with the Supabase CLI logged in and linked to the project
supabase functions deploy send-sms --no-verify-jwt
```

`--no-verify-jwt` is required: the request comes from Supabase Auth, not a logged-in
user. The function does its own signature check with `SEND_SMS_HOOK_SECRET`.

## Secrets (never commit real values)

```bash
supabase secrets set \
  SEND_SMS_HOOK_SECRET="v1,whsec_..." \
  MSG91_AUTHKEY="..." \
  MSG91_WA_INTEGRATED_NUMBER="..." \
  MSG91_WA_TEMPLATE_NAME="..." \
  MSG91_WA_LANG_CODE="en" \
  MSG91_SMS_TEMPLATE_ID="..." \
  MSG91_SMS_VAR="otp"
```

Optional: `MSG91_WA_NAMESPACE`, `MSG91_WA_OTP_BUTTON` (`true`/`false`, default `true`).

## Enable the hook

Dashboard → **Authentication → Hooks → Send SMS hook** → point it at this function
(`https://<project-ref>.functions.supabase.co/send-sms`) and paste the same secret
Supabase shows there into `SEND_SMS_HOOK_SECRET`. Also enable the **Phone** provider.

For local dev, the equivalent in `supabase/config.toml`:

```toml
[auth.hook.send_sms]
enabled = true
uri = "https://<project-ref>.functions.supabase.co/send-sms"
```

## Payload contract

Supabase POSTs `{ "user": { "phone": "919876543210", ... }, "sms": { "otp": "123456" } }`.
The function maps `user.phone` → recipient and `sms.otp` → the template's OTP variable.
Return `200 {}` on success; a non-2xx surfaces as an auth error to the user.
