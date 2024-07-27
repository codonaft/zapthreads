import { DBSchema, IDBPDatabase, StoreNames } from "idb";
import { parse } from "nostr-tools/nip10";
import { RelayInformation } from "nostr-tools/nip11";
import { UnsignedEvent } from "nostr-tools/pure";

// models

export type NoteEvent = {
  id: string;
  k: 1 | 8812 | 9802 | 30023;
  c: string;
  ts: number;
  pk: string;
  // tags
  ro?: string; // e root
  re?: string; // e reply
  me?: string[]; // e mentions
  p?: string[];
  a?: string; // a tag
  am?: boolean; // was a tag a mention?
  r?: string; // r tag
  t?: string[]; // t tags
  d?: string; // d tag
  tl?: string; // title
  pow: number;
  client?: string;
};

export type NoteId = string;
export type Pk = string;
export type Eid = string;
export type VoteKind = -1 | 0 | 1;
export type ReactionEvent = {
  id: Eid;
  noteId: NoteId;
  content: string;
  pk: Pk;
  ts: number;
  pow: number;
  a: string;
};

export const voteKind = (r: ReactionEvent): VoteKind => {
  if (r.content === '-') {
    return -1;
  } else if (r.content.length === 0 || r.content === '+') {
    return 1;
  } else {
    return 0;
  }
}

export type AggregateEvent = {
  eid: string;
  k: 7 | 9735;
  sum?: number; // useful for counting zaps (likes are ids.length)
  ids: string[]; // source ids
};

export type Profile = {
  pk: string,
  ts: number,
  l: number, // last checked
  n?: string,
  i?: string;
};

export type Session = {
  pk: string;
  autoLogin: number;
};

export type Relay = {
  key: string;
  l: number; // latest result
};

export type RelayInfo = {
  name: string;
  info?: RelayInformation;
  l?: number;
  readAuth?: boolean;
  writeOnly?: boolean;
};

export type RelayStats = {
  name: string;
  kind: number;
  serial: number;
  latency: number;
  ts: number;
};

export type BlockName = 'eventsBlocked' | 'pubkeysBlocked';
export type Block = {
  id: string;
  addedAt: number;
  used: boolean;
  reason?: string;
};

export type Community = {
  community: string;
  moderators: Pk[];
  l: number;
};

// DB schema

export interface ZapthreadsSchema extends DBSchema {
  events: {
    key: string;
    value: NoteEvent;
    indexes: {
      'pk': string;
      'a': string;
      'ro': string;
      'r': string;
      'd': string;
      'k': number;
    };
  };
  reactions: {
    key: string;
    value: ReactionEvent;
    indexes: {
      'a': string;
    };
  };
  aggregates: {
    key: string[];
    value: AggregateEvent;
  },
  profiles: {
    key: string;
    value: Profile;
    indexes: {
      'l': number;
    };
  };
  sessions: {
    key: string;
    value: Session;
    indexes: {
      'autoLogin': number;
    };
  };
  relays: {
    key: string;
    value: Relay;
    indexes: {
      'a': string;
    };
  };
  relayInfos: {
    key: string;
    value: RelayInfo;
  };
  relayStats: {
    key: string[];
    value: RelayStats;
    indexes: {
      'by-name': string;
    };
  };
  eventsBlocked: {
    key: string;
    value: Block;
  };
  pubkeysBlocked: {
    key: string;
    value: Block;
  };
  communities: {
    key: string;
    value: Community;
  };
}

export const indices: { [key in StoreNames<ZapthreadsSchema>]: any } = {
  'events': 'id',
  'reactions': 'id',
  'aggregates': ['eid', 'k'],
  'profiles': ['pk'],
  'sessions': 'pk',
  'relays': 'key',
  'relayInfos': 'name',
  'relayStats': ['name', 'kind', 'serial'],
  'eventsBlocked': 'id',
  'pubkeysBlocked': 'id',
  'communities': 'community',
};

export const upgrade = async (db: IDBPDatabase<ZapthreadsSchema>, currentVersion: number) => {
  if (currentVersion <= 1) {
    const names = [...db.objectStoreNames];
    await Promise.all(names.map(n => db.deleteObjectStore(n)));
  }

  const events = db.createObjectStore('events', { keyPath: indices['events'] });
  events.createIndex('pk', 'pk');
  events.createIndex('a', 'a');
  events.createIndex('ro', 'ro');
  events.createIndex('r', 'r');
  events.createIndex('d', 'd');
  events.createIndex('k', 'k');

  const reactions = db.createObjectStore('reactions', { keyPath: indices['reactions'] });
  reactions.createIndex('a', 'a');

  db.createObjectStore('aggregates', { keyPath: indices['aggregates'] });

  const profiles = db.createObjectStore('profiles', { keyPath: indices['profiles'] });
  profiles.createIndex('l', 'l');

  const sessions = db.createObjectStore('sessions', { keyPath: indices['sessions'] });
  sessions.createIndex('autoLogin', 'autoLogin');

  const relays = db.createObjectStore('relays', { keyPath: indices['relays'] });

  const relayInfos = db.createObjectStore('relayInfos', { keyPath: indices['relayInfos'] });

  const relayStats = db.createObjectStore('relayStats', { keyPath: indices['relayStats'] });
  relayStats.createIndex('by-name', 'name');

  const pubkeysBlocked = db.createObjectStore('pubkeysBlocked', { keyPath: indices['pubkeysBlocked'] });

  const eventsBlocked = db.createObjectStore('eventsBlocked', { keyPath: indices['eventsBlocked'] });

  const communities = db.createObjectStore('communities', { keyPath: indices['communities'] });
};

// util

export const parseClient = (tags: string[][]) => tags.filter(tag => tag.length === 2 && tag[0] === 'client').map(tag => tag[1])[0];

export const eventToNoteEvent = (e: UnsignedEvent & { id?: string; }): NoteEvent => {
  const nip10result = parse(e);

  const aTag = e.tags.find(t => t[0] === 'a');
  const a = aTag && aTag[1];
  const am = aTag && aTag[3] === 'mention';
  const rTag = e.tags.find(t => t[0] === 'r');
  const r = rTag && rTag[1];
  const tTags = e.tags.filter(t => t[0] === 't');
  const t = [...new Set(tTags.map(t => t[1]))]; // dedup tags
  const dTag = e.tags.find(t => t[0] === 'd');
  const d = dTag && dTag[1];
  const titleTag = e.tags.find(t => t[0] === 'title');
  const tl = titleTag && titleTag[1];
  const nonce = e.tags.find(t => t.length > 2 && t[0] === 'nonce');
  const pow = nonce && +nonce[2] || 0;
  const client = parseClient(e.tags);

  return {
    id: e.id ?? "",
    k: e.kind as 1 | 9802 | 30023,
    c: e.content,
    ts: e.created_at,
    pk: e.pubkey,
    ro: nip10result.root?.id,
    re: nip10result.reply?.id,
    me: nip10result.mentions.map(m => m.id),
    p: nip10result.profiles.map(p => p.pubkey),
    a,
    am,
    r,
    t,
    d,
    tl,
    pow,
    client,
  };
};

export const eventToReactionEvent = (e: UnsignedEvent & { id?: string; }, anchor: string): ReactionEvent => {
  const nip10result = parse(e);

  // extracting note id we reply to, otherwise root note id
  const eTags = e.tags.filter(t => t.length > 1 && t[0] === 'e');
  const tags = eTags.filter(t => t.length > 2);
  const noteId = tags
    .filter(t => t[3] === 'reply')
    .concat(tags.filter(t => t[3] === 'root'))
    .map(t => t[1])
    .concat(eTags.length > 0 && eTags[0].length > 1 && [eTags[0][1]] || [])[0];
  const nonce = e.tags.find(t => t.length > 2 && t[0] === 'nonce');
  const pow = nonce && +nonce[2] || 0;

  return {
    id: e.id ?? '',
    noteId,
    pk: e.pubkey,
    content: e.content,
    ts: e.created_at,
    pow,
    a: anchor,
  };
}
