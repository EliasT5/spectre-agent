import webpush from "web-push";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getVapidSubject, getVapidPublicKey, getVapidPrivateKey, hasVapid } from "@/lib/vapid";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export async function sendPush(payload: PushPayload): Promise<void> {
  if (!hasVapid()) return;
  const vapidDetails = {
    subject: getVapidSubject(),
    publicKey: getVapidPublicKey(),
    privateKey: getVapidPrivateKey(),
  };

  const supabase = createServiceSupabase();
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth");

  if (!subs || subs.length === 0) return;

  const expired: string[] = [];

  await Promise.allSettled(
    subs.map(async (sub: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { vapidDetails }
        );
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 410 || status === 404) {
          expired.push(sub.id);
        }
      }
    })
  );

  if (expired.length > 0) {
    await supabase.from("push_subscriptions").delete().in("id", expired);
  }
}
