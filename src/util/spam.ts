import { Spam } from "./models.ts";
import { store } from "./stores.ts";
import { find, findAll, save, remove } from "./db.ts";
import { HOUR_IN_SECS, DAY_IN_SECS, WEEK_IN_SECS, currentTime } from "./date-time.ts";
import { SHORT_TIMEOUT } from "./network.ts";

const disabled = () => store.disableFeatures!.includes('spamNostrBand');

export const updateSpamFilters = async (lastUpdateSpamFilters: number) => {
  if (disabled()) return;
  const now = currentTime();
  const deadline = lastUpdateSpamFilters + DAY_IN_SECS;
  if (now < deadline) {
    console.log(`[zapthreads] spam filters will be updated in ${((deadline - now) / HOUR_IN_SECS).toFixed(1)} hours`);
    return;
  }

  await Promise.allSettled(['events', 'pubkeys'].map(async (view) => {
    const API_METHOD = 'https://spam.nostr.band/spam_api?method=get_current_spam';
    try {
      const request = fetch(`${API_METHOD}&view=${view}`, {
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
      const type = `${view}Spam`;

      // @ts-ignore
      const fromStore = store.spam[view];

      const response = await request;
      if (response.status === 200) {
        const newIds = (await response.json())[`cluster_${view}`]
          .map((i: any) => i[view])
          .flat()
          .filter((id: string) =>
            // @ts-ignore
            !fromStore.has(id)
          );
        newIds.forEach((id: string) => {
          // @ts-ignore
          fromStore.add(id);
          // @ts-ignore
          save(type, { id, addedAt: now, used: false });
        });
      }
    } catch (e) {
      console.error(e);
    }
  }));
  console.log('[zapthreads] updated spam filters');
};

export const loadSpamFilters = async () => {
  if (disabled()) return 0;
  const now = currentTime();
  return Math.max(...await Promise.all(['events', 'pubkeys'].map(
    async (view: string) => {
      // @ts-ignore
      const fromStore = store.spam[view];
      const type = `${view}Spam`;
      let lastUpdate = 0;
      const outdatedIds = [];
      // @ts-ignore
      const items: Spam[] = await findAll(type);
      for (const i of items) {
        lastUpdate = Math.max(lastUpdate, i.addedAt);
        if (!i.used && now >= i.addedAt + WEEK_IN_SECS) {
          outdatedIds.push(i.id);
        } else {
          // @ts-ignore
          fromStore.add(i.id);
        }
      }
      // @ts-ignore
      remove(type, outdatedIds);
      return lastUpdate;
    }
  )));
};

export const useSpamBlock = async (type: 'eventsSpam' | 'pubkeysSpam', id: string) => {
  if (disabled()) return;
  const spam = await find(type, IDBKeyRange.only(id));
  if (spam && !spam.used) {
    save(type, { ...spam, used: true });
  }
};
