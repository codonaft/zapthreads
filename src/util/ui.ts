import { NestedNoteEvent } from "./nest.ts";
import { Anchor, UrlPrefixesKeys, PreferencesStore } from "./stores.ts";
import { decode } from "nostr-tools/nip19";
import { Filter } from "nostr-tools/filter";
import { Event } from "nostr-tools/core";
import { matchAll, replaceAll } from "nostr-tools/nip27";
import nmd from "nano-markdown";
import { findAll, save } from "./db.ts";
import { store } from "./stores.ts";
import { NoteEvent, Profile, Eid, ReactionEvent } from "./models.ts";
import { pool, rankRelays } from "./network.ts";
import { currentTime } from "./date-time.ts";

// Misc profile helpers

export const updateProfiles = async (pubkeys: Set<string>, relays: string[], profiles: Profile[]): Promise<void> => {
  const kind = 0;
  const now = +new Date;
  const sixHours = 21600000;

  const _profiles = new Map(profiles.map(p => [p.pk, p]));
  const pubkeysToUpdate = new Set([...pubkeys].filter(pubkey => {
    const profile = _profiles.get(pubkey);
    if (profile?.l && profile!.l > now - sixHours) {
      // console.log(profile!.lastChecked, now - sixHours, profile!.lastChecked < now - sixHours);
      return false;
    } else {
      return true;
    }
  }).filter(e => !!e));

  if (pubkeysToUpdate.size === 0) {
    return;
  }

  const { fastRelays, slowRelays } = await rankRelays(relays, { kind });
  const filters = [{ kinds: [kind], authors: [...pubkeysToUpdate] }];
  const update = async (relays: string[]) => {
    if (relays.length === 0) return;
    await pool.subscribeManyEose(relays, filters, {
      onevent(e: Event) {
        const pubkey = e.pubkey;
        if (!pubkeysToUpdate.has(pubkey)) return;
        try {
          const payload = JSON.parse(e.content);
          const updatedProfile = {
            pk: pubkey,
            ts: e.created_at,
            i: payload.image || payload.picture,
            n: payload.displayName || payload.display_name || payload.name,
          };
          const storedProfile = _profiles.get(pubkey);
          const updated = !storedProfile || !storedProfile?.i || !storedProfile?.n || storedProfile!.ts < updatedProfile.ts;
          if (updated) {
            const newProfile = storedProfile
              ? { ...storedProfile, ...updatedProfile, l: now }
              : { ...updatedProfile, l: now };
            _profiles.set(pubkey, newProfile);
            save('profiles', newProfile);
            console.log(`[zapthreads] updated profile ${pubkey}`);
          }
        } catch (err) {
          console.error(err);
        }
      },
    });
  };

  await update(fastRelays);
  update(slowRelays);
};

export const getRelayLatest = async (anchor: Anchor) => {
  const relaysForAnchor = await findAll('relays', anchor.value, { index: 'a' });
  const hour = 3600;
  const now = currentTime();
  return Object.fromEntries(relaysForAnchor.map(r => {
    const updatedLongTimeAgo = r.l + hour < now;
    const since = Math.max(0, updatedLongTimeAgo ? r.l + 1 : r.l - hour); // make sure we don't miss events sent from machines with poor network or poor time sync
    return [r.n, since];
  }));
};

// Calculate and save latest created_at to be used as `since`
// on subsequent relay requests (we use created_at to be a bit safer than with +Date.now)
// This since only applies to filter queries
// ({ "#e": store.rootEventIds }, { "#a": [anchor().value] })
// and not to aggregate or root event queries
export const saveRelayLatestForFilter = async (anchor: Anchor, events: (NoteEvent | ReactionEvent)[]) => {
  if (anchor.type !== 'http' && !store.anchorAuthor) return;

  const obj: { [url: string]: number; } = {};
  for (const e of events) {
    const relaysForEvent = pool.seenOn.get(e.id);
    if (relaysForEvent) {
      for (const relayUrl of relaysForEvent) {
        if (e.ts > (obj[relayUrl] || 0)) {
          obj[relayUrl] = e.ts;
        }
      }
    }
  }

  const relays = await findAll('relays', anchor.value, { index: 'a' });
  for (const name in obj) {
    const relay = relays.find(r => r.n === name);
    if (relay) {
      if (obj[name] > relay.l) {
        // update
        relay.l = obj[name];
        save('relays', relay);
      }
    } else {
      // create new
      save('relays', { n: name, a: anchor.value, l: obj[name] });
    }
  }
};

export const encodedEntityToFilter = (entity: string): Filter => {
  const decoded = decode(entity);
  switch (decoded.type) {
    case 'nevent': return {
      'kinds': [1],
      'ids': [decoded.data.id]
    };
    case 'note': return {
      'kinds': [1],
      'ids': [decoded.data]
    };
    case 'naddr': return {
      'kinds': [decoded.data.kind],
      'authors': [decoded.data.pubkey],
      "#d": [decoded.data.identifier]
    };
    default: return {};
  }
};

const URL_REGEX = /(?<=^|\s)https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&\/\/=]*)/gi;
const IMAGE_REGEX = /(\S*(?:png|jpg|jpeg|gif|webp))/gi;
const BAD_NIP27_REGEX = /(?<=^|\s)@?((naddr|npub|nevent|note)[a-z0-9]{20,})/g;
const BACKTICKS_REGEX = /\`(.*?)\`/g;

const ANY_HASHTAG = /\B\#([a-zA-Z0-9]+\b)(?!;)/g;

export const parseContent = (e: NoteEvent, store: PreferencesStore, articles: NoteEvent[] = []): string => {
  let content = e.c;
  const urlPrefixes = store.urlPrefixes!;
  const profiles = store.profiles!;

  // replace http(s) links + images
  content = content.replace(URL_REGEX, (url) => {
    if (url.match(IMAGE_REGEX)) {
      return `![image](${url})`;
    }
    return `[${url}](${url})`;
  });

  // turn hashtags into links (does not match hashes in URLs)
  const hashtags = [...new Set(e.t)];
  if (hashtags.length > 0) {
    const re = new RegExp(`(^|\\s)\\#(${hashtags.join('|')})`, 'gi');
    content = content.replaceAll(re, `$1[#$2](${urlPrefixes.tag}$2)`);
  }

  // NIP-27 attempts => NIP-27
  content = content.replaceAll(BAD_NIP27_REGEX, 'nostr:$1');

  // NIP-27 => Markdown
  content = replaceAll(content, ({ decoded, value }) => {
    switch (decoded.type) {
      case 'nprofile':
        let p1 = profiles().find(p => p.pk === decoded.data.pubkey);
        const text1 = p1?.n || shortenEncodedId(value);
        return `[@${text1}](${urlPrefixes.nprofile}${value})`;
      case 'npub':
        let p2 = profiles().find(p => p.pk === decoded.data);
        const text2 = p2?.n || shortenEncodedId(value);
        return `[@${text2}](${urlPrefixes.npub}${value})`;
      case 'note':
        return `[@${shortenEncodedId(value)}](${urlPrefixes.note}${value})`;
      case 'naddr':
        const d = decoded.data;
        const article = articles.find(a => a.pk === d.pubkey && a.d === d.identifier);
        if (article && article.tl) {
          return `[${article.tl}](${urlPrefixes.naddr}${value})`;
        }
        return `[@${shortenEncodedId(value)}](${urlPrefixes.naddr}${value})`;
      case 'nevent':
        return `[@${shortenEncodedId(value)}](${urlPrefixes.nevent}${value})`;
      default: return value;
    }
  });

  // Replace backticks with code
  content = content.replaceAll(BACKTICKS_REGEX, '<code>$1</code>');

  // Markdown => HTML
  return nmd(content.trim());
};

export const generateTags = (content: string): string[][] => {
  const result = [];
  // generate p and e tags in content
  const nostrMatches = matchAll(content);

  for (const m of nostrMatches) {
    if (m.decoded.type === 'npub') {
      result.push(['p', m.decoded.data]);
    }
    if (m.decoded.type === 'naddr') {
      const data = m.decoded.data;
      result.push(['a', `${data.kind}:${data.pubkey}:${data.identifier}`, '', 'mention']);
    }
    if (m.decoded.type === 'nevent') {
      result.push(['e', m.decoded.data.id]);
    }
    if (m.decoded.type === 'note') {
      result.push(['e', m.decoded.data]);
    }
  }

  // add t tags from hashtags in content
  const hashtagMatches = content.matchAll(ANY_HASHTAG);
  const hashtags = new Set([...hashtagMatches].map(m => m[1].toLowerCase()));
  for (const t of hashtags) {
    result.push(['t', t]);
  }

  return result;
};

export const parseUrlPrefixes = (value: string = '') => {
  const result: { [key in UrlPrefixesKeys]?: string; } = {
    naddr: 'https://nostr.com/',
    npub: 'https://nostr.com/',
    nprofile: 'https://nostr.com/',
    nevent: 'https://nostr.com/',
    note: 'https://nostr.com/',
    tag: 'https://snort.social/t/'
  };

  for (const pair of value.split(',')) {
    const [key, value] = pair.split(':');
    if (value) {
      result[key as UrlPrefixesKeys] = `https://${value}`;
    }
  }
  return result;
};

export const shortenEncodedId = (encoded: string) => {
  return encoded.substring(0, 8) + '...' + encoded.substring(encoded.length - 4);
};

export const svgWidth = 20;
export const defaultPicture = 'data:image/svg+xml;utf-8,<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><circle cx="512" cy="512" r="512" fill="%23333" fill-rule="evenodd" /></svg>';

export const satsAbbrev = (sats: number): string => {
  if (sats < 10000) {
    return sats.toString();
  } else if (sats < 1000000) {
    return Math.round(sats / 1000) + 'k';
  } else {
    return Math.round(sats / 1000000) + 'M';
  }
};

export const totalChildren = (event: NestedNoteEvent): number => {
  return event.children.reduce<number>((acc, c) => {
    return acc + totalChildren(c);
  }, event.children.length);
};

const removeSlashesRegex = /\/+$/;

export const normalizeURL = (url: string, removeSlashes: boolean = true): string => {
  const u = new URL(url);
  u.hash = "";
  if (removeSlashes) {
    u.pathname = u.pathname.replace(removeSlashesRegex, '');
  }
  return u.toString();
};

export const errorText = <T>(exception: T) => {
  const err = (exception as any)?.reason;
  return err?.message || String(err);
};
