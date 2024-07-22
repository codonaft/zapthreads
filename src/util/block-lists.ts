import { Block, BlockName, Eid, Pk } from "./models.ts";
import { store } from "./stores.ts";
import { find, findAll, save, remove } from "./db.ts";
import { HOUR_IN_SECS, DAY_IN_SECS, WEEK_IN_SECS, currentTime } from "./date-time.ts";
import { shortFetch } from "./network.ts";

const disabledSpamNostrBand = () => store.disableFeatures!.includes('spamNostrBand');

export const updateBlockFilters = async (lastUpdateBlockFilters: number) => {
  if (disabledSpamNostrBand() || !store.blocks.checkUpdates) return;

  store.blocks.checkUpdates = false;
  const now = currentTime();
  const deadline = lastUpdateBlockFilters + DAY_IN_SECS;
  if (now < deadline) {
    console.log(`[zapthreads] spam filters will be updated in ${((deadline - now) / HOUR_IN_SECS).toFixed(1)} hours`);
    return;
  }

  const lists: BlockName[] = ['eventsBlocked', 'pubkeysBlocked'];
  await Promise.allSettled(lists.map(async (list) => {
    const API_METHOD = 'https://spam.nostr.band/spam_api?method=get_current_spam';
    try {
      const view = list.replace('Blocked', '');
      const request = shortFetch(`${API_METHOD}&view=${view}`);
      // @ts-ignore
      const fromStore = store.blocks[view];

      const response = await request;
      if (response.status === 200) {
        const newIds = (await response.json())[`cluster_${view}`]
          .map((i: any) => i[view])
          .flat()
          .filter((id: string) =>
            !fromStore.has(id)
          );
        newIds.forEach((id: string) => {
          fromStore.add(id);
          save(list, { id, addedAt: now, used: false, reason: `Block-listed ${view.slice(0, -1)} by spam.nostr.band` });
        });
      }
    } catch (e) {
      console.error(e);
    }
  }));
  console.log('[zapthreads] updated spam filters');
};

export const loadBlockFilters = async () => {
  if (disabledSpamNostrBand()) return 0;

  const now = currentTime();
  const lists: BlockName[] = ['eventsBlocked', 'pubkeysBlocked'];
  const lastUpdate = Math.max(...await Promise.all(lists.map(
    async (list) => {
      const view = list.replace('Blocked', '');
      // @ts-ignore
      const fromStore = store.blocks[view];
      let lastUpdate = 0;
      const outdatedIds = [];
      const items: Block[] = await findAll(list);
      for (const i of items) {
        lastUpdate = Math.max(lastUpdate, i.addedAt);
        if (!i.used && now >= i.addedAt + WEEK_IN_SECS) {
          outdatedIds.push(i.id);
        } else {
          fromStore.add(i.id);
        }
      }
      // @ts-ignore
      remove(list, outdatedIds);
      return lastUpdate;
    }
  )));
  return lastUpdate;
};

export const applyBlock = async (list: BlockName, id: Eid | Pk, reason?: string) => {
  const block = await find(list, IDBKeyRange.only(id)) || { id, addedAt: currentTime(), used: false };
  if (!block.used) {
    const newReason = block.reason || reason;
    save(list, { ...block, used: true, reason: newReason });
  }
};
