import { ShortTextNote, Metadata, Highlights, Reaction, Report, CommunityDefinition, Zap } from "nostr-tools/kinds";
import { Filter } from "nostr-tools/filter";
import { Event } from "nostr-tools/core";
import { Block, BlockName, Eid, Pk } from "./models.ts";
import { store, isDisableType, signersStore } from "./stores.ts";
import { pool } from "./network.ts";
import { find, findAll, save, remove } from "./db.ts";
import { HOUR_IN_SECS, DAY_IN_SECS, WEEK_IN_SECS, currentTime } from "./date-time.ts";
import { shortFetch } from "./network.ts";

const disabledSpamNostrBand = () => store.disableFeatures!.includes('spamNostrBand');

export const applyBlock = async (list: BlockName, id: Eid | Pk, reason?: string) => {
  const block = await find(list, IDBKeyRange.only(id)) || { id, addedAt: currentTime(), used: false };
  if (!block.used) {
    let pubkeyBlock;
    if (list === 'eventsBlocked') {
      // check whether it's already blocked by pubkey first
      const event = await find('events', IDBKeyRange.only(id));
      if (event) {
        pubkeyBlock = await find('pubkeysBlocked', IDBKeyRange.only(event!.pk));
      }
    }

    if (pubkeyBlock) {
      save('pubkeysBlocked', { ...pubkeyBlock, used: true });
    } else {
      const newReason = block.reason || reason;
      save(list, { ...block, used: true, reason: newReason });
    }

    let blockedEids;
    if (list === 'eventsBlocked') {
      blockedEids = [id];
    } else if (list === 'pubkeysBlocked') {
      const blockedEvents = await findAll('events', id, { index: 'pk' });
      blockedEids = blockedEvents.map(e => e.id);
    }

    if (blockedEids) {
      remove('events', blockedEids);
    }
  }
};

export const loadBlockFilters = async () => {
  const lastUpdate = Math.max(await loadModerators(), await loadSpamNostrBand());

  const now = currentTime();
  const deadline = lastUpdate + DAY_IN_SECS;
  if (now < deadline) {
    console.log(`[zapthreads] block filters will be updated in ${((deadline - now) / HOUR_IN_SECS).toFixed(1)} hours`);
    return { communityFilter: [], lastUpdateBlockFilters: lastUpdate };
  }

  const communityFilter: Filter[] = store.community && store.anchorAuthor
    ? [{ kinds: [CommunityDefinition], since: lastUpdate + 1, "#a": [`${CommunityDefinition}:${store.anchorAuthor}:${store.community}`] }]
    : [];

  return { communityFilter, lastUpdateBlockFilters: lastUpdate }
};

export const updateBlockFilters = async (lastUpdateBlockFilters: number) => {
  if (!store.blocks.checkUpdates) return;
  store.blocks.checkUpdates = false;

  await updateSpamNostrBand(lastUpdateBlockFilters);
  await updateModeratorReports();

  console.log('[zapthreads] updated block-lists');
};

const loadSpamNostrBand = async () => {
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

const updateSpamNostrBand = async (lastUpdateBlockFilters: number) => {
  if (disabledSpamNostrBand()) return;

  const now = currentTime();
  const deadline = lastUpdateBlockFilters + DAY_IN_SECS;
  if (now < deadline) return;

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

const loadModerators = async () => {
  const community = store.community && await find('communities', IDBKeyRange.only(store.community));
  const lastUpdate = community ? community.l : 0;

  store.moderators.clear();
  if (store.anchorAuthor) {
    store.moderators.add(store.anchorAuthor!);
  }
  if (community) {
    community.moderators.forEach(pk => store.moderators.add(pk));
  }

  console.log('loadModerators', store.moderators.size, [...store.moderators]);
  return lastUpdate;
};

const updateModeratorReports = async () => {
  const lastUpdate = await loadModerators();

  const currentUser = signersStore.active ? [signersStore.active!.pk] : [];
  const authors = [...store.moderators, ...currentUser];

  const events: Event[] = await pool.querySync(store.readRelays, { kinds: [Report], authors });
  events.forEach(processReport);
};

const processReport = (e: Event) => {
  const reportedPks = e.tags.filter(t => t.length >= 2 && t[0] === 'p').map(t => t[1]);
  const expectedReportedPks = reportedPks.length > 0 && reportedPks.filter(pk => store.moderators.has(pk)).length === 0;
  if (!expectedReportedPks) return;
  console.log('processReport', e);

  const reportedEvents = e.tags.filter(t => t.length >= 3 && t[0] === 'e');
  if (reportedEvents.length > 0) {
    reportedEvents.forEach(t => applyBlock('eventsBlocked', t[1], t[2]));
  } else {
    e
      .tags
      .filter(t => t.length >= 3 && t[0] === 'p')
      .forEach(t => applyBlock('pubkeysBlocked', t[1], t[2]));
  }
};
