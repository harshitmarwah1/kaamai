// KaamAI — Supabase "Send SMS" auth hook.
//
// Supabase Auth generates the OTP and calls this function to DELIVER it. We send
// over MSG91 **WhatsApp first**, and fall back to **MSG91 SMS** if WhatsApp fails.
// Supabase still owns OTP generation + verification (verifyOtp is unchanged), so
// the whole auth/session/RLS flow is untouched — this function is purely the pipe.
//
// The dev "test phone number" configured in Supabase bypasses this hook entirely
// (Supabase returns a fixed code without sending), so you can test without spend.
//
// Required env (set as Edge Function secrets — NEVER commit real values):
//   SEND_SMS_HOOK_SECRET        the hook signing secret Supabase shows you (v1,whsec_…)
//   MSG91_AUTHKEY               your MSG91 auth key
// WhatsApp channel (preferred):
//   MSG91_WA_INTEGRATED_NUMBER  the WhatsApp Business number registered in MSG91
//   MSG91_WA_TEMPLATE_NAME      approved WhatsApp *authentication* template name
//   MSG91_WA_LANG_CODE          template language code (default "en")
//   MSG91_WA_NAMESPACE          template namespace (optional, if your template needs it)
//   MSG91_WA_OTP_BUTTON         "true" if the template has a copy-code/URL OTP button (default "true")
// SMS fallback:
//   MSG91_SMS_TEMPLATE_ID       DLT-approved MSG91 Flow template id
//   MSG91_SMS_VAR               the OTP variable name in that template (default "otp")
//
// The OTP value and the recipient are passed into the template variable(s); the
// template text itself is whatever you registered and approved with MSG91/DLT.

import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

const HOOK_SECRET = Deno.env.get("SEND_SMS_HOOK_SECRET") ?? "";
const MSG91_AUTHKEY = Deno.env.get("MSG91_AUTHKEY") ?? "";

const WA_INTEGRATED_NUMBER = Deno.env.get("MSG91_WA_INTEGRATED_NUMBER") ?? "";
const WA_TEMPLATE_NAME = Deno.env.get("MSG91_WA_TEMPLATE_NAME") ?? "";
const WA_LANG_CODE = Deno.env.get("MSG91_WA_LANG_CODE") ?? "en";
const WA_NAMESPACE = Deno.env.get("MSG91_WA_NAMESPACE") ?? "";
const WA_HAS_OTP_BUTTON = (Deno.env.get("MSG91_WA_OTP_BUTTON") ?? "true") === "true";

const SMS_TEMPLATE_ID = Deno.env.get("MSG91_SMS_TEMPLATE_ID") ?? "";
const SMS_VAR = Deno.env.get("MSG91_SMS_VAR") ?? "otp";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// MSG91 wants a country-code-prefixed number with no "+" (e.g. 919876543210).
const digits = (phone: string) => (phone || "").replace(/\D/g, "");

// MSG91 returns { type: "success" | "error", ... } on its v5 endpoints.
function assertMsg91Ok(channel: string, status: number, text: string) {
  if (status < 200 || status >= 300) throw new Error(`${channel}-http-${status}: ${text}`);
  try {
    const j = JSON.parse(text);
    if (j && j.type && j.type !== "success") throw new Error(`${channel}-msg91: ${text}`);
  } catch {
    /* a non-JSON 2xx body is treated as success */
  }
}

async function sendWhatsApp(mobile: string, otp: string): Promise<void> {
  if (!WA_INTEGRATED_NUMBER || !WA_TEMPLATE_NAME) throw new Error("whatsapp-not-configured");
  const components: Record<string, unknown> = { body_1: { type: "text", value: otp } };
  if (WA_HAS_OTP_BUTTON) components.button_1 = { subtype: "url", type: "text", value: otp };

  const body = {
    integrated_number: WA_INTEGRATED_NUMBER,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: WA_TEMPLATE_NAME,
        language: { code: WA_LANG_CODE, policy: "deterministic" },
        ...(WA_NAMESPACE ? { namespace: WA_NAMESPACE } : {}),
        to_and_components: [{ to: [mobile], components }],
      },
    },
  };

  const res = await fetch("https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/", {
    method: "POST",
    headers: { "Content-Type": "application/json", authkey: MSG91_AUTHKEY },
    body: JSON.stringify(body),
  });
  assertMsg91Ok("whatsapp", res.status, await res.text());
}

async function sendSms(mobile: string, otp: string): Promise<void> {
  if (!SMS_TEMPLATE_ID) throw new Error("sms-not-configured");
  const recipient: Record<string, string> = { mobiles: mobile };
  recipient[SMS_VAR] = otp;

  const res = await fetch("https://control.msg91.com/api/v5/flow/", {
    method: "POST",
    headers: { "Content-Type": "application/json", authkey: MSG91_AUTHKEY },
    body: JSON.stringify({ template_id: SMS_TEMPLATE_ID, short_url: "0", recipients: [recipient] }),
  });
  assertMsg91Ok("sms", res.status, await res.text());
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: { message: "method not allowed" } }, 405);

  const payloadText = await req.text();

  // Verify the request genuinely came from Supabase Auth.
  if (HOOK_SECRET) {
    try {
      const wh = new Webhook(HOOK_SECRET.replace("v1,whsec_", ""));
      wh.verify(payloadText, Object.fromEntries(req.headers));
    } catch (e) {
      console.error("send-sms: signature verification failed", errMsg(e));
      return json({ error: { message: "invalid signature" } }, 401);
    }
  }

  let mobile = "";
  let otp = "";
  try {
    const data = JSON.parse(payloadText);
    mobile = digits(data?.user?.phone ?? "");
    otp = String(data?.sms?.otp ?? "");
  } catch {
    return json({ error: { message: "bad payload" } }, 400);
  }
  if (!mobile || !otp) return json({ error: { message: "missing phone or otp" } }, 400);
  if (!MSG91_AUTHKEY) return json({ error: { message: "MSG91_AUTHKEY not set" } }, 500);

  // WhatsApp first, SMS fallback.
  const failures: string[] = [];
  try {
    await sendWhatsApp(mobile, otp);
    return json({});
  } catch (e) {
    failures.push(errMsg(e));
  }
  try {
    await sendSms(mobile, otp);
    return json({});
  } catch (e) {
    failures.push(errMsg(e));
  }

  console.error("send-sms: all channels failed", failures);
  return json({ error: { message: "delivery failed", details: failures } }, 500);
});
