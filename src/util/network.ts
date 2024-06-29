import { UnsignedEvent, Event } from "nostr-tools/core";
import { getEventHash } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { RelayInformation, fetchRelayInformation as internalFetchRelayInformation } from "nostr-tools/nip11";
import { getPow, minePow } from "nostr-tools/nip13";
import { npubEncode } from "nostr-tools/nip19";
import { findAll } from "./db.ts";
import { EventSigner, store, pool } from "./stores.ts";
import { Eid, RelayInfo } from "./models.ts";

const TIMEOUT = 7000;

let publishAttempt = 0;

export const sleep = async (timeout: number = TIMEOUT) => new Promise(resolve => setTimeout(resolve, timeout));

const timeLimit = async <T>(fn: () => Promise<T>, timeout: number = TIMEOUT) => {
  let timer;
  try {
    timer = setTimeout(() => {
      throw new Error('Timelimit exceeded');
    }, timeout);
    return await fn();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const publishOnRelay = async (relayUrl: string, event: Event) => {
  // @ts-ignore
  let relay = pool.relays.get(relayUrl);
  if (!relay) {
    relay = await Relay.connect(relayUrl);
  }
  await relay.publish(event);
};

const publishSequentially = async (event: Event, relays: string[]): Promise<[number, any[]]> => {
  const failures = [];
  for (const relayUrl of relays) {
    try {
      await timeLimit(async () => publishOnRelay(relayUrl, event));
    } catch (e) {
      failures.push([relayUrl, e]);
    }
  }

  const ok = relays.length - failures.length;
  return [ok, failures];
};

const publishConcurrently = async <T>(event: Event, relays: string[]): Promise<[number, any[]]> => {
  const results = await Promise.allSettled(relays.map(async (relayUrl: string) =>
    timeLimit(async () => await publishOnRelay(relayUrl, event))
  ));

  let ok = 0;
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      ok += 1;
    } else if (results[i]) {
      failures.push([relays[i], results[i]]);
    }
  }
  return [ok, failures];
};

export const powIsOk = (id: Eid, powOrTags: number | string[][], minPow: number): boolean => {
  if (minPow === 0) {
    return true;
  }

  let pow = 0;
  if (typeof powOrTags === 'number') {
    pow = powOrTags;
  } else if (typeof powOrTags === 'object') {
    const nonce = powOrTags.find(t => t.length > 2 && t[0] === 'nonce');
    pow = nonce && +nonce[2] || 0;
  }
  return pow >= minPow && getPow(id) >= minPow;
};

export const supportedReadRelay = (info?: RelayInformation) => {
  if (!info) {
    return true;
  }

  const languages = store.languages;
  if (languages.length > 0 && info.language_tags && info.language_tags.length > 0) {
    if (languages.filter(lang => info.language_tags!.includes(lang)).length !== languages.length) {
      return false;
    }
  }

  return true;
};

export const supportedWriteRelay = (event?: Event, info?: RelayInformation, maxWritePow?: number) => {
  if (!info) return true;
  if (!supportedReadRelay(info)) return false;

  /* TODO: enable when more relays will report they support NIP-25
  const requiredNips = event.kind === 7 ? [25] : [];
  if (info.supported_nips.length > 0 && requiredNips.filter(n => info.supported_nips.includes(n)).length !== requiredNips.length) {
    return false;
  }*/

  const retention = info.retention;
  if (retention) {
    const eventKind = event ? event.kind : 1;
    const allowed = retention.filter(r => {
      const disallowed = (r.time && r.time === 0) || (r.count && r.count === 0);
      const kindMatches = r.kinds.includes(eventKind);
      const kindRangeMatches = r.kinds
        .filter(r => Array.isArray(r))
        .map(r => r as number[])
        .map(kindRange => kindRange.length == 2 && eventKind >= kindRange[0] && eventKind <= kindRange[1])
        .length > 0;
      return disallowed && (kindMatches || kindRangeMatches);
    }).length === 0;
    if (!allowed) {
      return false;
    }
  }

  const limitation = info.limitation;
  if (limitation) {
    if (limitation.auth_required && limitation.auth_required!) return false;
    if (limitation.payment_required && limitation.payment_required!) return false;
    if (limitation.min_pow_difficulty && ((maxWritePow && maxWritePow < limitation.min_pow_difficulty) || (event && !powIsOk(event.id, event.tags, limitation.min_pow_difficulty)))) return false;
    if (limitation.max_content_length && event && event.content.length > limitation.max_content_length) return false;
    if (limitation.max_message_length && event && ('["EVENT",' + JSON.stringify(event) + ']').length > limitation.max_message_length) return false;
  }

  return true;
};

export const publishEvent = async (event: Event): Promise<[number, number]> => {
  if (store.onPublish && !(await store.onPublish(event.id, npubEncode(event.pubkey), event.kind, event.content))) {
    return [0, 0];
  }

  //publishAttempt += 1;
  const writeRelays = store.writeRelays;
  const relayInfos: { [name: string]: RelayInfo } = Object.fromEntries((await findAll('relayInfos')).map((r: RelayInfo) => [r.name, r])); // TODO: extract? find single item?
  const supportedWriteRelays = writeRelays.filter(r => {
    const relayInfo = relayInfos[r];
    return !relayInfo || supportedWriteRelay(event, relayInfo.info);
  });
  //const pow = Math.min(...supportedWriteRelayInfos.map(r => r.info?.limitation?.min_pow_difficulty || 0));
  //console.log('pow', pow); // TODO: use it in signAndPublishEvent
  const startTime = Date.now();
  const [ok, failures] = publishAttempt % 2 == 0 ? await publishConcurrently(event, supportedWriteRelays) : await publishSequentially(event, supportedWriteRelays);
  const deltaTime = Date.now() - startTime;
  const unsupported = writeRelays.length - supportedWriteRelays.length;
  console.log(`[zapthreads] publish to ${supportedWriteRelays} ok=${ok} failed=${failures.length} unsupported=${unsupported} took ${deltaTime} ms`);
  failures.length > 0 && console.log(failures);
  return [ok, failures.length]
};

export const fetchRelayInformation = async (relay: string): Promise<RelayInformation> => await timeLimit(async () => await internalFetchRelayInformation(relay));

// TODO: move
export const sign = async (unsignedEvent: UnsignedEvent, signer: EventSigner) => {
  const pow = store.writePowDifficulty;
  let event: Event;
  if (pow > 0) {
    const eventWithPow = minePow(unsignedEvent, pow);
    const signature = await signer.signEvent!(eventWithPow);
    event = { ...eventWithPow, ...signature };
  } else {
    const id = getEventHash(unsignedEvent);
    const signature = await signer.signEvent!(unsignedEvent);
    event = { id, ...unsignedEvent, ...signature };
  }
  console.log(JSON.stringify(event, null, 2));
  return event;
}

export const signAndPublishEvent = async (unsignedEvent: UnsignedEvent, signer: EventSigner): Promise<[number, number, Event]> => {
  const event = await sign(unsignedEvent, signer);
  const [ok, failures] = await publishEvent(event);
  return [ok, failures, event];
}
