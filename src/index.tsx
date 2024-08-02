import { JSX, createComputed, createEffect, createMemo, createSignal, on, onMount, onCleanup, batch } from "solid-js";
import { customElement } from 'solid-element';
import { createVisibilityObserver } from "@solid-primitives/intersection-observer";
import style from './styles/index.css?raw';
import { updateProfiles, totalChildren, parseUrlPrefixes, parseContent, normalizeURL, errorText } from "./util/ui.ts";
import { normalizeURL as nostrNormalizeURL } from "nostr-tools/utils";
import { fetchRelayInformation, infoExpired, powIsOk, pool, loginIfKnownUser, NOTE_KINDS, CONTENT_KINDS, validateWriteEvent } from "./util/network.ts";
import { nest } from "./util/nest.ts";
import { store, isDisableType, signersStore } from "./util/stores.ts";
import { HOUR_IN_SECS, DAY_IN_SECS, WEEK_IN_SECS, sortByDate, currentTime } from "./util/date-time.ts";
import { Thread, ellipsisSvg } from "./thread.tsx";
import { RootComment } from "./reply.tsx";
import { decode as bolt11Decode } from "light-bolt11-decoder";
import { clear as clearCache, find, findAll, save, remove, watchAll, onSaved } from "./util/db.ts";
import { decode, npubEncode } from "nostr-tools/nip19";
import { RelayRecord } from "nostr-tools/relay";
import { Event } from "nostr-tools/core";
import { Metadata, ShortTextNote, EventDeletion, Highlights, Reaction, Report, CommunityDefinition, Zap } from "nostr-tools/kinds";
import { finalizeEvent, getPublicKey, UnsignedEvent  } from "nostr-tools/pure";
import { Filter } from "nostr-tools/filter";
import { SubCloser } from "nostr-tools/pool";
import { AggregateEvent, NoteEvent, eventToNoteEvent, eventToReactionEvent, voteKind, RelayInfo, Eid, Pk, Block } from "./util/models.ts";
import { applyBlock, updateBlockFilters, loadBlockFilters } from "./util/block-lists.ts";
import { validateAndSetLanguage } from "./util/language.ts";

const ZapThreads = (props: { [key: string]: string; }) => {
  const minReadPow = () => +props.minReadPow;
  const maxWritePow = () => +props.maxWritePow;

  createComputed(() => {
    store.anchor = (() => {
      const anchor = props.anchor.trim();
      try {
        if (anchor.startsWith('http')) {
          const removeSlashes = !props.legacyUrl; // remove slashes if legacyUrl boolean not present
          return { type: 'http', value: normalizeURL(anchor, removeSlashes) };
        }

        const decoded = decode(anchor);
        switch (decoded.type) {
          case 'nevent': return { type: 'note', value: decoded.data.id };
          case 'note': return { type: 'note', value: decoded.data };
          case 'naddr':
            const d = decoded.data;
            return { type: 'naddr', value: `${d.kind}:${d.pubkey}:${d.identifier}` };
        }
      } catch (e) {
        console.error(e);
        return { type: 'error', value: `Malformed anchor: ${anchor}` };
      }
    })();

    if ((props.author || '').startsWith('npub')) {
      store.externalAuthor = props.author;
    }

    store.disableFeatures = props.disable.split(',').map(e => e.trim()).filter(isDisableType);
    store.urlPrefixes = parseUrlPrefixes(props.urls);
    store.replyPlaceholder = props.replyPlaceholder;
    store.maxCommentLength = +props.maxCommentLength || Infinity;
    store.minReadPow = minReadPow();
    store.maxWritePow = maxWritePow();
    store.writePowDifficulty = Math.max(store.writePowDifficulty, minReadPow());
    store.community = props.community;
    validateAndSetLanguage(props.language);

    const client = props.client.trim();
    if (client) {
      store.client = client;
    }
  });

  onMount(async () => {
    window.addEventListener('beforenostrupdate', (e) => {
      signersStore.active = undefined;
    });

    if (signersStore.active) return;
    await loginIfKnownUser();
    await pool.updateRelays(props.relays);
  });

  const anchor = () => store.anchor!;
  const readRelays = () => store.readRelays;
  const disableFeatures = () => store.disableFeatures!;
  const requestedVersion = () => props.version;

  store.profiles = watchAll(() => ['profiles']);

  const closeOnEose = () => disableFeatures().includes('watch');

  // Anchors -> root events -> events

  // clear version on anchor change
  createComputed(on([anchor], () => {
    store.version = requestedVersion();
  }));

  // Anchors -> root events
  createComputed(on([anchor, readRelays], async () => {
    if (store.rootEventIds.length > 0 || anchor().type === 'error') return;

    let filterForRemoteRootEvents: Filter;
    let localRootEvents: NoteEvent[];

    // Find root events from anchor
    // We sort by date so that the IDs are kept in order before discarding the timestamp
    switch (anchor().type) {
      case 'http':
        localRootEvents = await findAll('events', anchor().value, { index: 'r' });
        store.rootEventIds = sortByDate(localRootEvents).map(e => e.id);
        const rf = props.legacyUrl ? [anchor().value] : [anchor().value, `${anchor().value}/`];
        filterForRemoteRootEvents = { '#r': rf, kinds: [ShortTextNote, 8812] };
        break;
      case 'note':
        // In the case of note we only have one possible anchor, so return if found
        const e = await find('events', IDBKeyRange.only(anchor().value));
        store.rootEventIds = [anchor().value];
        if (e) {
          store.anchorAuthor = e.pk;
        }
        return;
      case 'naddr':
        const [kind, pubkey, identifier] = anchor().value.split(':');
        localRootEvents = (await findAll('events', identifier, { index: 'd' })).filter(e => e.pk === pubkey);
        if (localRootEvents.length > 0) {
          store.rootEventIds = sortByDate(localRootEvents).map(e => e.id);
          store.anchorAuthor = localRootEvents[0].pk;
        }
        filterForRemoteRootEvents = { authors: [pubkey], kinds: [parseInt(kind)], '#d': [identifier] };
        break;
      default: throw 'error';
    }

    const _relays = readRelays();
    if (_relays.length === 0) return;

    // No `since` here as we are not keeping track of a since for root events
    const remoteRootEvents = await pool.querySync(_relays, { ...filterForRemoteRootEvents });

    const remoteRootNoteEvents = remoteRootEvents.map(eventToNoteEvent);
    for (const e of remoteRootNoteEvents) {
      if (anchor().type == 'http') {
        // make sure it's an actual anchor and not a random comment with that URL
        if ((e.k == ShortTextNote && e.c.includes('↴')) || e.k == 8812) {
          save('events', e);
        }
      } else {
        save('events', e);
      }
    }

    switch (anchor().type) {
      case 'http':
      case 'naddr':
        const events = [...localRootEvents, ...remoteRootNoteEvents];
        const sortedEventIds = sortByDate([...events]).map(e => e.id);
        // only set root event ids if we have a newer event from remote
        if ((sortedEventIds.length > 0 && sortedEventIds[0]) !== store.rootEventIds[0]) {
          store.rootEventIds = sortedEventIds;
        }
        break;
      case 'note':
        store.rootEventIds = remoteRootNoteEvents.map(e => e.id);
        break;
    }

    if (remoteRootNoteEvents.length > 0) {
      store.anchorAuthor = remoteRootNoteEvents[0].pk;
    }
  }));

  const rootEventIds = () => store.rootEventIds;

  // Root events -> filter
  createComputed(on([rootEventIds, requestedVersion], () => {
    // set the filter for finding actual comments
    switch (anchor().type) {
      case 'http':
      case 'note':
        if ((store.filter['#e'] ?? []).toString() !== rootEventIds().toString()) {
          store.filter = { "#e": rootEventIds() };
        }
        return;
      case 'naddr':
        const existingAnchor = store.filter['#a'] && store.filter['#a'][0];
        if (anchor().value !== existingAnchor) {
          store.filter = { "#a": [anchor().value] };
        }

        // Version only applicable to naddr - get provided version or default to most recent root event ID
        store.version = requestedVersion() || rootEventIds()[0];
        return;
    }
  }, { defer: true }));

  // Subscription

  const filter = createMemo(() => {
    return store.filter;
  }, { defer: true });

  let sub: SubCloser | null;

  // Filter -> remote events, content
  createEffect(on([filter, readRelays], async () => {
    // Fix values to this effect
    const _filter = filter();
    const _readRelays = readRelays();
    const _anchor = anchor();
    const _events = events();
    const _reactions = reactions();
    const _profiles = store.profiles();

    if (Object.entries(_filter).length === 0 || _readRelays.length === 0) {
      return;
    }

    const { communityFilter, lastUpdateBlockFilters } = await loadBlockFilters();

    // Ensure clean subs
    sub?.close();
    sub = null;

    onCleanup(() => {
      console.log('[zapthreads] unsubscribing and cleaning up', _anchor.value);
      sub?.close();
      sub = null;
    });

    console.log(`[zapthreads] subscribing to ${_anchor.value} on`, [..._readRelays]);

    const queryNoteRootEvent = !store.anchorAuthor && anchor().type === 'note';
    const rootEventFilter: Filter[] = queryNoteRootEvent ? [{ ids: [anchor().value], kinds: NOTE_KINDS, limit: 1 }] : [];

    const reactionsDisabled = store.disableFeatures!.includes('votes') && store.disableFeatures!.includes('likes');
    const zapsDisabled = store.disableFeatures!.includes('zaps');
    const kinds = CONTENT_KINDS.filter(k => {
      let result = true;
      if (reactionsDisabled) result &&= k !== Reaction;
      if (zapsDisabled) result &&= k !== Zap;
      return result;
    });
    const request = (url: string) => [url, [...communityFilter, ...rootEventFilter, { ..._filter, kinds }]];

    const newLikeIds = new Set<string>();
    const newZaps: { [id: string]: string; } = {};
    let newPks = new Set<Pk>();
    const requestedProfileUpdate = new Set<Pk>();

    sub = await pool.subscribeManyMap(
      Object.fromEntries(_readRelays.map(request)),
      {
        onevent(e) {
          (async () => {
            if (NOTE_KINDS.includes(e.kind)) {
              const noteEvent = eventToNoteEvent(e);
              const isNoteRootEvent = queryNoteRootEvent && !store.anchorAuthor && e.id === anchor().value;
              if (isNoteRootEvent) {
                console.log(`[zapthreads] anchor author is ${e.pubkey}`);
                store.anchorAuthor = e.pubkey;
              }
              save('events', noteEvent);
              newPks.add(e.pubkey);
            } else if (e.kind === Reaction) {
              newLikeIds.add(e.id);
              const reactionEvent = eventToReactionEvent(e, _anchor.value);
              if (voteKind(reactionEvent) !== 0) { // remove this condition if you want to track all reactions
                save('reactions', reactionEvent);
              }
            } else if (e.kind === Zap) {
              const invoiceTag = e.tags.find(t => t[0] === "bolt11");
              invoiceTag && invoiceTag[1] && (newZaps[e.id] = invoiceTag[1]);
            } else if (e.kind === CommunityDefinition) {
              const moderators = e
                .tags
                .filter(t => t.length >= 4 && t[0] === 'p' && t[3] === 'moderator')
                .map(t => t[1]);
              save('communities', { community: store.community!, moderators, l: currentTime() });
            }
          })()
        },
        oneoseOnRelay(relay) {
          newPks = new Set([...newPks].filter(pk => !requestedProfileUpdate.has(pk)));
          newPks.forEach(pk => requestedProfileUpdate.add(pk));
          updateProfiles(newPks, _readRelays, _profiles);
          newPks.clear();
        },
        oneose() {
          (async () => {
            const likesAggregate: AggregateEvent = await find('aggregates', IDBKeyRange.only([_anchor.value, Reaction]))
              ?? { eid: _anchor.value, ids: [], k: Reaction };
            likesAggregate.ids = [...new Set([...likesAggregate.ids, ...newLikeIds])];
            save('aggregates', likesAggregate);

            const zapsAggregate: AggregateEvent = await find('aggregates', IDBKeyRange.only([_anchor.value, Zap]))
              ?? { eid: _anchor.value, ids: [], k: Zap, sum: 0 };
            zapsAggregate.sum = Object.entries(newZaps).reduce((acc, entry) => {
              if (zapsAggregate.ids.includes(entry[0])) return acc;
              const decoded = bolt11Decode(entry[1]);
              const amount = decoded.sections.find((e: { name: string; }) => e.name === 'amount');
              const sats = Number(amount.value) / 1000;
              return acc + sats;
            }, zapsAggregate.sum ?? 0);

            zapsAggregate.ids = [...new Set([...zapsAggregate.ids, ...Object.keys(newZaps)])];
            save('aggregates', zapsAggregate);
          })();

          onSaved(async () => {
            await pool.estimateWriteRelayLatencies();
            await updateBlockFilters(lastUpdateBlockFilters);
            await pool.updateRelayInfos();

            if (closeOnEose()) {
              sub?.close();
              const writeRelays = new Set(store.writeRelays);
              pool.close(_readRelays.filter(r => !writeRelays.has(r)));
            }

            console.log('[zapthreads] oneose has finished');
          });
        }
      }
    );
  }, { defer: true }));

  const articles = watchAll(() => ['events', 30023, { index: 'k' }]);

  const content = createMemo(() => {
    if (store.disableFeatures!.includes('hideContent') && anchor().type === 'naddr') {
      const [_, pubkey, identifier] = anchor().value.split(':');
      const contentEvent = articles().find(e => e.d === identifier && e.pk === pubkey);

      if (contentEvent) {
        const c = `# ${contentEvent.tl}\n ${contentEvent.c}`;
        return parseContent({ ...contentEvent, c }, store);
      }
    }
  });

  // Build JSX

  // Watch all events
  const eventsWatcher = createMemo(() => {
    switch (anchor().type) {
      case 'http':
      case 'note':
        return watchAll(() => ['events', store.rootEventIds, { index: 'ro' }]);
      case 'naddr':
        return watchAll(() => ['events', anchor().value, { index: 'a' }]);
      default: // error
        return () => [];
    }
  });
  const events = () => eventsWatcher()();

  const nestedEvents = createMemo(() => {
    if (store.rootEventIds && store.rootEventIds.length) {
      const _events = events();
      return nest(_events).filter(e => {
        // remove all highlights without children (we only want those that have comments on them)
        return !(e.k === Highlights && e.children.length === 0);
      });
    }
    return [];
  });

  // Filter -> local events
  const topNestedEvents = () => {
    const userStartedReadingComments = store.userStartedReadingComments;

    // Put all new comments on top until user starts to read the comments section.
    // Then put all new messages (besides our own) to the bottom, to avoid sudden unwanted shifts of contents.
    const topNestedEvents = nestedEvents().filter(e => !userStartedReadingComments || signersStore.active?.pk == e.pk || store.topRootEventIds.has(e.id));
    topNestedEvents.forEach(e => store.topRootEventIds.add(e.id));
    return topNestedEvents;
  };

  const bottomNestedEvents = () => {
    return nestedEvents().filter(e => !store.topRootEventIds.has(e.id));
  };

  const commentsLength = () => {
    return nestedEvents().reduce((acc, n) => acc + totalChildren(n), nestedEvents().length);
  };

  const firstLevelComments = () => nestedEvents().filter(n => !n.parent).length;

  const reactions = watchAll(() => ['reactions', anchor().value, { index: 'a' }]);
  const votes = createMemo(() => reactions().filter(r => voteKind(r) !== 0));

  let rootElement: HTMLDivElement | undefined;
  const visible = createVisibilityObserver({ threshold: 0.0 })(() => rootElement);
  let userStartedReadingCommentsTimer: any;

  createEffect(on([visible, firstLevelComments], () => {
    if (!store.userStartedReadingComments && visible() && firstLevelComments() > 0) {
      store.userObservedComments = true;
      let userStartedReadingCommentsTimer = setTimeout(() => {
        store.userStartedReadingComments = true;
      }, 3000);
    }
  }));

  onCleanup(() => {
    clearTimeout(userStartedReadingCommentsTimer);
  });

  return <>
    <div ref={rootElement} id="ztr-root">
      <style>{style}</style>
      {content() && <div id="ztr-content" innerHTML={content()}></div>}
      {anchor().type === 'error' && <>
        <h1>Error!</h1>
        <div class="ztr-comment-text">
          <pre>{anchor().value}</pre>
          <p>
            Only properly formed NIP-19 naddr, note and nevent encoded entities and URLs are supported.</p>
        </div>
      </>}
      {anchor().type !== 'error' && <>
        {!store.disableFeatures!.includes('reply') && <RootComment />}
        <h2 id="ztr-title">
          {commentsLength() > 0 && `${commentsLength()} comment${commentsLength() == 1 ? '' : 's'}`}
        </h2>
        <Thread topNestedEvents={topNestedEvents} bottomNestedEvents={bottomNestedEvents} articles={articles} votes={votes} firstLevelComments={firstLevelComments} />
      </>}
    </div></>;
};

export default ZapThreads;

// NOTE that the element seems to lose reactivity (in Solid, at least)
// when using multiple word attributes
customElement<ZapThreadsAttributes>('zap-threads', {
  anchor: "",
  community: "",
  version: "",
  relays: "",
  author: "",
  disable: "",
  urls: "",
  'reply-placeholder': "",
  'legacy-url': "",
  language: '',
  client: '',
  'max-comment-length': '',
  'min-read-pow': '',
  'max-write-pow': '',
}, (props) => {
  return <ZapThreads
    anchor={props['anchor'] ?? ''}
    version={props['version'] ?? ''}
    relays={props['relays'] ?? ''}
    author={props['author'] ?? ''}
    community={props['community'] ?? ''}
    disable={props['disable'] ?? ''}
    urls={props['urls'] ?? ''}
    replyPlaceholder={props['reply-placeholder'] ?? ''}
    legacyUrl={props['legacy-url'] ?? ''}
    language={props['language'] ?? ''}
    client={props['client'] ?? ''}
    maxCommentLength={props['max-comment-length'] ?? ''}
    minReadPow={props['min-read-pow'] ?? ''}
    maxWritePow={props['max-write-pow'] ?? ''}
  />;
});

export type ZapThreadsAttributes = {
  [key in 'anchor' | 'version' | 'relays' | 'author' | 'community' | 'disable' | 'urls' | 'reply-placeholder' | 'legacy-url' | 'language' | 'client' | 'max-comment-length' | 'min-read-pow' | 'max-write-pow']?: string;
} & JSX.HTMLAttributes<HTMLElement>;

ZapThreads.onLogin = function (cb?: (options: { knownUser: boolean; }) => Promise<{ accepted: boolean; autoLogin: boolean; }>) {
  store.onLogin = cb;
  return ZapThreads;
};

ZapThreads.onEvent = function (cb?: (event: { rankable: boolean; kind: number; content: string; replies: number; upvotes: number; downvotes: number; pow: number; language?: string; client?: string; }) => { sanitizedContent: string; rank?: number; showReportButton?: boolean; }) {
  store.onEvent = cb;
  return ZapThreads;
};

ZapThreads.onRemove = function (cb?: (event: { content: string; }) => Promise<{ accepted: boolean; }>) {
  store.onRemove = cb;
  return ZapThreads;
};

ZapThreads.onReport = function (cb?: (event: {}) => Promise<{ accepted?: boolean; list?: 'event' | 'pubkey'; type?: 'nudity' | 'malware' | 'profanity' | 'illegal' | 'spam' | 'impersonation' | 'other'; reason?: string; }>) {
  store.onReport = cb;
  return ZapThreads;
};
