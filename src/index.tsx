import { JSX, createComputed, createEffect, createMemo, createSignal, on, onCleanup, batch } from "solid-js";
import { modifyMutable, produce } from "solid-js/store";
import { customElement } from 'solid-element';
import { createVisibilityObserver } from "@solid-primitives/intersection-observer";
import style from './styles/index.css?raw';
import { saveRelayLatestForFilter, updateProfiles, totalChildren, parseUrlPrefixes, parseContent, normalizeURL } from "./util/ui.ts";
import { normalizeURL as nostrNormalizeURL } from "nostr-tools/utils";
import { fetchRelayInformation, infoExpired, powIsOk, pool } from "./util/network.ts";
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
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { Filter } from "nostr-tools/filter";
import { SubCloser } from "nostr-tools/pool";
import { AggregateEvent, NoteEvent, eventToNoteEvent, eventToReactionEvent, voteKind, RelayInfo, Eid, Pk, Spam } from "./util/models.ts";
import { updateSpamFilters, loadSpamFilters, useSpamBlock } from "./util/spam.ts";

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
    store.languages = props.languages.split(',').map(e => e.trim()).filter(i => i.length > 0);
    store.maxCommentLength = +props.maxCommentLength || Infinity;
    store.writePowDifficulty = Math.max(store.writePowDifficulty, minReadPow());
    store.maxWritePow = maxWritePow();
  });

  const rawReadRelays = () => props.readRelays;

  const updateRelays = async () => {
    const now = currentTime();

    const rawRelays: RelayRecord =
      signersStore.active && window.nostr
      ? await window.nostr.getRelays()
      : Object.fromEntries(
          (props.readRelays || '')
            .split(',')
            .map(i => i.trim())
            .filter(i => i.length > 0)
            .map(r => [r, {read: true, write: false}]));

    const relays: RelayRecord = Object.fromEntries(
      Object
       .entries(rawRelays)
       .map(([relayUrl, options]: [string, any]) => [relayUrl.trim(), options])
       .filter(([relayUrl, options]) => relayUrl.length > 0)
       .map(([relayUrl, options]) => [nostrNormalizeURL(new URL(relayUrl).toString()), options]));

    const entries = Object.entries(relays);
    const readRelays = entries.filter(([relayUrl, options]) => options.read).map(([r, _]) => r);
    modifyMutable(store, produce((store) => {
      store.writeRelays = entries.filter(([relayUrl, options]) => options.write).map(([r, _]) => r);
      if (JSON.stringify(store.readRelays) !== JSON.stringify(readRelays)) {
        store.readRelays = readRelays;
      }
    }));
    await pool.updateWritePow(minReadPow());
  };

  createEffect(on([rawReadRelays], updateRelays));

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
    const _relays = readRelays();
    if (_relays.length === 0) return;

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
        filterForRemoteRootEvents = { '#r': rf, kinds: [1, 8812] };
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

    // No `since` here as we are not keeping track of a since for root events
    const remoteRootEvents = await pool.querySync(_relays, { ...filterForRemoteRootEvents });

    const remoteRootNoteEvents = remoteRootEvents.map(eventToNoteEvent);
    for (const e of remoteRootNoteEvents) {
      if (anchor().type == 'http') {
        // make sure it's an actual anchor and not a random comment with that URL
        if ((e.k == 1 && e.c.includes('↴')) || e.k == 8812) {
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

  const validEvent = async (id: string, pk: Pk, powOrTags: number | string[][], kind: number, content: string) => {
    if (store.validatedEvents.has(id)) {
      return store.validatedEvents.get(id)!;
    }

    const spamEvent = store.spam.events.has(id);
    if (spamEvent) {
      useSpamBlock('eventsSpam', id);
    }

    const spamPk = store.spam.pubkeys.has(pk);
    if (spamPk) {
      useSpamBlock('pubkeysSpam', pk);
    }

    const valid =
      (content.length <= store.maxCommentLength) &&
      !spamEvent &&
      !spamPk &&
      powIsOk(id, powOrTags, minReadPow()) &&
      (!store.onReceive || (await store.onReceive(id, kind, content)));
    store.validatedEvents.set(id, valid);
    return valid;
  };

  let sub: SubCloser | null;

  // Filter -> remote events, content
  createEffect(on([filter, readRelays], async () => {
    // Fix values to this effect
    const _filter = filter();
    const _readRelays = readRelays();
    const _anchor = anchor();
    const _events = events();
    const _profiles = store.profiles();

    if (Object.entries(_filter).length === 0 || _readRelays.length === 0) {
      return;
    }

    const lastUpdateSpamFilters = await loadSpamFilters();

    // Ensure clean subs
    sub?.close();
    sub = null;

    onCleanup(() => {
      console.log('[zapthreads] unsubscribing and cleaning up', _anchor.value);
      sub?.close();
      sub = null;
    });

    const noteKinds = [1, 9802];
    const kinds = [...noteKinds, 7, 9735];
    // TODO restore with a specific `since` for aggregates
    // (leaving it like this will fail when re-enabling likes/zaps)
    // if (!store.disableFeatures().includes('likes')) {
    //   kinds.push(7);
    // }
    // if (!store.disableFeatures().includes('zaps')) {
    //   kinds.push(9735);
    // }

    console.log(`[zapthreads] subscribing to ${_anchor.value} on`, [..._readRelays]);

    const queryNoteRootEvent = !store.anchorAuthor && anchor().type === 'note';
    const rootEventFilter = queryNoteRootEvent ? [{ ids: [anchor().value], kinds: noteKinds, limit: 1 }] : [];
    const request = (url: string) => [url, [...rootEventFilter, { ..._filter, kinds }]];

    const newLikeIds = new Set<string>();
    const newZaps: { [id: string]: string; } = {};

    sub = await pool.subscribeManyMap(
      Object.fromEntries(_readRelays.map(request)),
      {
        onevent(e) {
          (async () => {
            const valid = await validEvent(e.id, e.pubkey, e.tags, e.kind, e.content);
            if (noteKinds.includes(e.kind)) {
              const isNoteRootEvent = queryNoteRootEvent && !store.anchorAuthor && e.id === anchor().value;
              if (isNoteRootEvent || (valid && e.content.trim())) {
                if (isNoteRootEvent) {
                  console.log(`[zapthreads] anchor author is ${e.pubkey}`);
                  store.anchorAuthor = e.pubkey;
                }
                save('events', eventToNoteEvent(e));
              } else {
                remove('events', [e.id]);
              }
            } else if (e.kind === 7) {
              newLikeIds.add(e.id);
              if (e.content.trim()) {
                const reactionEvent = eventToReactionEvent(e, _anchor.value);
                if (voteKind(reactionEvent) !== 0) { // remove this condition if you want to track all reactions
                  if (valid) {
                    save('reactions', reactionEvent);
                  } else {
                    remove('reactions', [e.id]); // FIXME: may not work after setting "since"
                  }
                }
              }
            } else if (e.kind === 9735) {
              const invoiceTag = e.tags.find(t => t[0] === "bolt11");
              invoiceTag && invoiceTag[1] && (newZaps[e.id] = invoiceTag[1]);
            }
          })()
        },
        oneose() {
          (async () => {
            const likesAggregate: AggregateEvent = await find('aggregates', IDBKeyRange.only([_anchor.value, 7]))
              ?? { eid: _anchor.value, ids: [], k: 7 };
            likesAggregate.ids = [...new Set([...likesAggregate.ids, ...newLikeIds])];
            save('aggregates', likesAggregate);

            const zapsAggregate: AggregateEvent = await find('aggregates', IDBKeyRange.only([_anchor.value, 9735]))
              ?? { eid: _anchor.value, ids: [], k: 9735, sum: 0 };
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
            // Update profiles of current events (includes anchor author)
            await updateProfiles(new Set([..._events.map(e => e.pk)]), _readRelays, _profiles);

            // Save latest received events for each relay
            saveRelayLatestForFilter(_anchor, _events);

            await updateSpamFilters(lastUpdateSpamFilters);
            await pool.estimateWriteRelayLatencies();
            await pool.updateRelayInfos(minReadPow());

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

  // Login external npub/nsec
  const npubOrNsec = () => props.user;

  // Auto login when external pubkey supplied
  createComputed(on(npubOrNsec, (_) => {
    if (_) {
      let pubkey: string;
      let sk: Uint8Array | undefined;
      if (_.startsWith('nsec')) {
        /*sk = decode(_).data as Uint8Array;
        pubkey = getPublicKey(sk);*/
        return;
      } else if (_.startsWith('npub')) {
        pubkey = decode(_).data as string;
      } else {
        pubkey = _;
      }
      signersStore.external = {
        pk: pubkey,
        signEvent: async (event) => {
          // Sign with private key if nsec was provided
          if (sk) {
            return { sig: finalizeEvent(event, sk).sig };
          }

          // We validate here in order to delay prompting the user as much as possible
          if (!window.nostr) {
            alert('Please log in with a NIP-07 extension such as Alby or nos2x');
            signersStore.active = undefined;
            throw 'No extension available';
          }

          const extensionPubkey = await window.nostr!.getPublicKey();
          const loggedInPubkey = pubkey;
          if (loggedInPubkey !== extensionPubkey) {
            // If zapthreads was passed a different pubkey then error
            const error = `ERROR: Event not signed. Supplied pubkey does not match extension pubkey. ${loggedInPubkey} !== ${extensionPubkey}`;
            signersStore.active = undefined;
            alert(error);
            throw error;
          } else {
            return window.nostr!.signEvent(event);
          }

        }
      };
      signersStore.active = signersStore.external;
      updateRelays();
    }
  }));

  // Log out when external npub/nsec is absent
  createComputed(on(npubOrNsec, (_) => {
    if (!_) {
      signersStore.active = undefined;
    }
  }, { defer: true }));

  const articles = watchAll(() => ['events', 30023, { index: 'k' }]);

  const content = createMemo(() => {
    if (store.disableFeatures!.includes('hideContent') && anchor().type === 'naddr') {
      const [_, pubkey, identifier] = anchor().value.split(':');
      const contentEvent = articles().find(e => e.d === identifier && e.pk === pubkey);

      if (contentEvent) {
        const c = `# ${contentEvent.tl}\n ${contentEvent.c}`;
        return parseContent({ ...contentEvent, c }, store, []);
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
      (async () => { for (const e of _events) {
        if (!(await validEvent(e.id, e.pk, e.pow, e.k, e.c)) && (anchor().type !== 'note' || store.anchorAuthor !== e.pk)) {
          // TODO: if pow has changed - reset "since"?
          remove('events', [e.id]);
        }
      } })();
      return nest(_events).filter(e => {
        // remove all highlights without children (we only want those that have comments on them)
        return !(e.k === 9802 && e.children.length === 0);
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
  const votes = createMemo(() => reactions().filter(r => voteKind(r) !== 0 && (!store.validatedEvents.has(r.id) || store.validatedEvents.get(r.id))));

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
  version: "",
  'read-relays': "",
  user: "",
  author: "",
  disable: "",
  urls: "",
  'reply-placeholder': "",
  'legacy-url': "",
  languages: '',
  'max-comment-length': '',
  'min-read-pow': '',
  'max-write-pow': '',
}, (props) => {
  return <ZapThreads
    anchor={props['anchor'] ?? ''}
    version={props['version'] ?? ''}
    readRelays={props['read-relays'] ?? ''}
    user={props['user'] ?? ''}
    author={props['author'] ?? ''}
    disable={props['disable'] ?? ''}
    urls={props['urls'] ?? ''}
    replyPlaceholder={props['reply-placeholder'] ?? ''}
    legacyUrl={props['legacy-url'] ?? ''}
    languages={props['languages'] ?? ''}
    maxCommentLength={props['max-comment-length'] ?? ''}
    minReadPow={props['min-read-pow'] ?? ''}
    maxWritePow={props['max-write-pow'] ?? ''}
  />;
});

export type ZapThreadsAttributes = {
  [key in 'anchor' | 'version' | 'read-relays' | 'user' | 'author' | 'disable' | 'urls' | 'reply-placeholder' | 'legacy-url' | 'languages' | 'max-comment-length' | 'min-read-pow' | 'max-write-pow']?: string;
} & JSX.HTMLAttributes<HTMLElement>;

ZapThreads.onLogin = function (cb?: () => Promise<boolean>) {
  store.onLogin = cb;
  return ZapThreads;
};

ZapThreads.onPublish = function (cb?: (id: Eid, kind: number, content: string) => Promise<boolean>) {
  store.onPublish = cb;
  return ZapThreads;
};

ZapThreads.onReceive = function (cb?: (id: Eid, kind: number, content: string) => Promise<boolean>) {
  store.onReceive = cb;
  return ZapThreads;
};
