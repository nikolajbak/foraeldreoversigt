// Web-push til de installerede apps (iOS 16.4+ når appen er føjet til hjemmeskærmen).
import webpush from 'npm:web-push@3.6.7';
import { getConfig, setConfig, sql } from './db.ts';

const SUBJECT = 'https://nikolajbak.github.io/foraeldreoversigt/';

interface Vapid {
  publicKey: string;
  privateKey: string;
}

export async function vapidPublicKey(): Promise<string> {
  return (await vapid()).publicKey;
}

async function vapid(): Promise<Vapid> {
  let keys = await getConfig<Vapid>('vapid');
  if (!keys) {
    keys = webpush.generateVAPIDKeys() as Vapid;
    await setConfig('vapid', keys);
  }
  return keys;
}

export async function subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device?: string) {
  const host = new URL(sub.endpoint).hostname;
  const allowed = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'];
  if (!allowed.some((h) => host === h || host.endsWith('.' + h) || host.endsWith('.notify.windows.com'))) {
    throw new Error('Ukendt push-tjeneste');
  }
  await sql`
    insert into foraeldre.push_subscriptions (endpoint, keys, device)
    values (${sub.endpoint}, ${sql.json(sub.keys)}, ${device ?? null})
    on conflict (endpoint) do update set keys = excluded.keys, device = excluded.device`;
}

export async function unsubscribe(endpoint: string) {
  await sql`delete from foraeldre.push_subscriptions where endpoint = ${endpoint}`;
}

export interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/** Sender til alle tilmeldte enheder. Returnerer antal leverede. */
export async function sendToAll(msg: PushMessage, itemId?: string): Promise<number> {
  const keys = await vapid();
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  const subs = await sql`select endpoint, keys from foraeldre.push_subscriptions`;
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: s.keys },
        JSON.stringify(msg),
        { TTL: 6 * 3600, urgency: 'normal' },
      );
      delivered++;
      await sql`update foraeldre.push_subscriptions set last_ok = now() where endpoint = ${s.endpoint}`;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await unsubscribe(s.endpoint);
      else console.error('push fejlede', code, String(e).slice(0, 200));
    }
  }
  await sql`
    insert into foraeldre.notifications (item_id, title, body, delivered)
    values (${itemId ?? null}, ${msg.title}, ${msg.body}, ${delivered})`;
  return delivered;
}
