import { Event } from "nostr-tools/core";
import { Relay } from "nostr-tools/relay";
import { RelayInformation, fetchRelayInformation as internalFetchRelayInformation } from "nostr-tools/nip11";
import { getPow } from "nostr-tools/nip13";
import { findAll } from "./db.ts";
import { store } from "./stores.ts";

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

const publishSequentially = async (event: Event, relays: string[]): Promise<[number, any[]]> => {
  const failures = [];
  for (const relayUrl of relays) {
    try {
      await timeLimit(async () => {
        const relay = await Relay.connect(relayUrl);
        await relay.publish(event);
      });
    } catch (e) {
      failures.push([relayUrl, e]);
    }
  }

  const ok = relays.length - failures.length;
  return [ok, failures];
};

const publishConcurrently = async <T>(event: Event, relays: string[]): Promise<[number, any[]]> => {
  const results = await Promise.allSettled(relays.map(async (relayUrl: string) =>
    timeLimit(async () => {
      const relay = await Relay.connect(relayUrl);
      await relay.publish(event);
    })
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

// TODO: remove and use store?
export type Capabilities = {
  nips?: number[];
  allow_auth?: boolean;
  allow_paid?: boolean;
};

export const supportedReadRelay = (required: Capabilities, info?: RelayInformation) => {
  const languages = store.languages;
  if (languages.length > 0 && info && info.language_tags && info.language_tags.length > 0) {
    for (const lang of languages) {
      if (!info.language_tags.includes(lang)) {
        console.log('UNSUPPORTED read relay', info);
        return false;
      }
    }
  }
  return true;
};

const supportedWriteRelay = (event: Event, required: Capabilities, info?: RelayInformation) => {
  if (!info) {
    return true;
  }

  if (!supportedReadRelay(required, info)) {
    return false;
  }

  if (required.nips && required.nips.filter(n => info.supported_nips.includes(n)).length !== required.nips.length) {
    return false;
  }

  /*const retention = info.retention;
  if (retention) {
      console.log('supportedWriteRelay 4.0');
    const available = retention.filter(r => {
      const disallowed = r.time? === 0 || r.count? === 0;
      const kindMatches = r.kinds.length === 0 || r.kinds.includes(event.kind);
      const kindRangeMatches = r.kinds.map((ks: number[]) => ks.length == 2 && event.kind >= ks[0] && event.kind <= ks[1]).length > 0;
      return disallowed && (kindMatches || kindRangeMatches);
    }).length === 0;
    if (!available) {
      console.log('supportedWriteRelay 4.1');
      return false;
    }
  }*/

  const limitation = info.limitation;
  if (limitation) {
    const allow_auth = required.allow_auth && required.allow_auth!;
    if (!allow_auth && limitation.auth_required && limitation.auth_required!) {
      return false;
    }
    const allow_paid = required.allow_paid && required.allow_paid!;
    if (!allow_paid && limitation.payment_required && limitation.payment_required!) {
      return false;
    }
    if (limitation.min_pow_difficulty && getPow(event.id) > limitation.min_pow_difficulty) {
      return false;
    }
    if (limitation.max_content_length && event.content.length > limitation.max_content_length) {
      return false;
    }
    if (limitation.max_message_length && ('["EVENT",' + JSON.stringify(event) + ']').length > limitation.max_message_length) {
      return false;
    }
  }

  return true;
};

export const publishEvent = async (event: Event, relays: string[], required: Capabilities = {}): Promise<[number, number]> => {
  //publishAttempt += 1;
  const relaysFromDb = await findAll('relayInfos');
  const supportedWriteRelayInfos = relaysFromDb.filter(r => supportedWriteRelay(event, required, r.info));

  //TODO: const supportedWriteRelays = supportedWriteRelayInfos.map(r => r.name);
  const supportedWriteRelays = relays;

  const pow = Math.min(...supportedWriteRelayInfos.map(r => r.info?.limitation?.min_pow_difficulty || 0));
  console.log('pow', pow); // TODO: use it
  const startTime = Date.now();
  const [ok, failures] = publishAttempt % 2 == 0 ? await publishConcurrently(event, supportedWriteRelays) : await publishSequentially(event, supportedWriteRelays);
  const deltaTime = Date.now() - startTime;
  const unsupported = relays.length - supportedWriteRelays.length;
  console.log(`[zapthreads] publish to ${supportedWriteRelays} ok=${ok} failed=${failures.length} unsupported=${unsupported} took ${deltaTime} ms`);
  failures.length > 0 && console.log(failures);
  return [ok, failures.length]
};

export const fetchRelayInformation = async (relay: string): Promise<RelayInformation> => await timeLimit(async () => await internalFetchRelayInformation(relay));
