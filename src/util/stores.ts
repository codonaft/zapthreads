import { Event } from "nostr-tools/core";
import { UnsignedEvent } from "nostr-tools/pure";
import { Filter } from "nostr-tools/filter";
import { WindowNostr } from "nostr-tools/nip07";
import { Profile, Eid, Pk } from "./models.ts";
import { createMutable } from "solid-js/store";
import { Accessor, Setter } from "solid-js";
import { ReactiveSet } from "@solid-primitives/set";
import { Signal } from "./solidjs.ts";
import { NestedNoteEvent } from "./nest.ts";

export const store = createMutable<PreferencesStore>({
  readRelays: [],
  writeRelays: [],
  rootEventIds: [],
  topRootEventIds: new Set,
  userObservedComments: false,
  userStartedReadingComments: false,
  commentContexts: new Map,

  maxCommentLength: 0,
  writePowDifficulty: 0,
  minReadPow: 0,
  maxWritePow: 0,
  blocks: {
    events: new Set,
    pubkeys: new Set,
    checkUpdates: true,
  },
  ranks: new Map,
  showReportButton: new Set,
  moderators: new ReactiveSet,

  filter: {},
  profiles: () => [],
});

export const signersStore = createMutable<SignersStore>({});

// Signing

export type SignersStore = {
  active?: EventSigner;
};
export type SignEvent = (event: UnsignedEvent) => Promise<{ sig: string; }>;
export type EventSigner = {
  pk: string,
  signEvent?: SignEvent;
};

export type UrlPrefixesKeys = 'naddr' | 'nevent' | 'note' | 'npub' | 'nprofile' | 'tag';

const _types = ['reply', 'likes', 'votes', 'singleVoteCounter', 'zaps', 'publish', 'watch', 'replyAnonymously', 'hideContent', 'relayInformation', 'spamNostrBand'] as const;
type DisableType = typeof _types[number];
export const isDisableType = (type: string): type is DisableType => {
  return _types.includes(type as DisableType);
};

export type CommentContext = {
  thread: {
    collapsed: Accessor<boolean | undefined>;
    setCollapsed: Setter<boolean| undefined>;
    trigger: () => void;
  },
  text: {
    value: string;
    overflowed: Signal<boolean | undefined>;
    collapsed: Signal<boolean>;
  },
  votes: {
    upvotesCount: Signal<number>;
    downvotesCount: Signal<number>;
  },
  reply: {
    text: Signal<string>;
    isOpen: Signal<boolean>;
  }
};

export type PreferencesStore = {
  anchor?: Anchor, // derived from anchor prop
  readRelays: string[];
  writeRelays: string[];
  version?: string;  // derived from version prop
  rootEventIds: string[];  // derived from anchor prop
  topRootEventIds: Set<Eid>,
  userObservedComments: boolean,
  userStartedReadingComments: boolean,
  commentContexts: Map<Eid, CommentContext>,

  client?: string;
  language?: string,
  maxCommentLength: number,
  writePowDifficulty: number;
  minReadPow: number;
  maxWritePow: number;
  blocks: {
    events: Set<Eid>;
    pubkeys: Set<Pk>;
    checkUpdates: boolean,
  };
  ranks: Map<Eid, number>,
  showReportButton: Set<Eid>;

  filter: Filter;  // derived from anchor prop
  externalAuthor?: string; // prop, mostly used with http anchor type
  disableFeatures?: DisableType[]; // prop
  urlPrefixes?: { [key in UrlPrefixesKeys]?: string }, // prop
  replyPlaceholder?: string,

  anchorAuthor?: string;
  community?: string;
  moderators: ReactiveSet<Pk>;
  profiles: () => Profile[];
  onLogin?: (options: { knownUser: boolean; }) => Promise<{ accepted: boolean; autoLogin?: boolean }>;
  onEvent?: (event: { kind: number; content: string; replies: number; upvotes: number; downvotes: number; pow: number; language?: string; client?: string; }) => { sanitizedContent?: string; rank?: number; showReportButton?: boolean; };
  onRemove?: (event: { content: string; }) => Promise<{ accepted: boolean }>;
  onReport?: (event: {}) => Promise<{ accepted?: boolean; list?: 'event' | 'pubkey'; type?: 'nudity' | 'malware' | 'profanity' | 'illegal' | 'spam' | 'impersonation' | 'other'; reason?: string; }>;
};

export type Anchor = { type: 'http' | 'naddr' | 'note' | 'error', value: string; };

// Globals

declare global {
  interface Window {
    nostr?: WindowNostr & {
      signEvent: SignEvent;
    };
  }
}
