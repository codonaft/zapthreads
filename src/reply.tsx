import { defaultPicture, generateTags, satsAbbrev, shortenEncodedId, updateProfiles, errorText } from "./util/ui.ts";
import { signAndPublishEvent, sign, pool, manualLogin, logout, validateWriteEvent } from "./util/network.ts";
import { Show, createEffect, createSignal } from "solid-js";
import { UnsignedEvent, Event } from "nostr-tools/core";
import { EventSigner, signersStore, store } from "./util/stores.ts";
import { currentTime } from "./util/date-time.ts";
import { generateSecretKey, getPublicKey, getEventHash, finalizeEvent } from "nostr-tools/pure";
import { Metadata, ShortTextNote, EventDeletion, Highlights, Reaction, Report, CommunityDefinition, Zap } from "nostr-tools/kinds";
import { createAutofocus } from "@solid-primitives/autofocus";
import { find, save, watch } from "./util/db.ts";
import { Profile, eventToNoteEvent } from "./util/models.ts";
import { Signal, newSignal } from "./util/solidjs.ts";
import { lightningSvg, likeSvg, nostrSvg, warningSvg } from "./thread.tsx";
import { decode, npubEncode } from "nostr-tools/nip19";
import { Relay } from "nostr-tools/relay";
import { normalizeURL } from "nostr-tools/utils";

export const ReplyEditor = (props: { comment: Signal<string>; replyTo?: string; onDone?: Function; }) => {
  const comment = () => props.comment();
  const setComment = (text: string) => props.comment(text);
  const [loading, setLoading] = createSignal(false);
  const [loggedInUser, setLoggedInUser] = createSignal<Profile>();
  const [errorMessage, setErrorMessage] = createSignal('');

  const anchor = () => store.anchor!;
  const profiles = store.profiles!;
  const readRelays = () => store.readRelays;
  const writeRelays = () => store.writeRelays;

  // Sessions

  const login = async () => {
    try {
      await manualLogin();
      setErrorMessage('');
    } catch (e) {
      onError(errorText(e));
    }
  };

  // Logged in user is a computed property of the active signer
  createEffect(async () => {
    if (signersStore.active) {
      const pk = signersStore.active.pk;
      let profile = profiles().find(p => p.pk === pk);
      if (!profile) {
        profile = { pk, l: 0, ts: 0 };
        await save('profiles', profile);
      }
      setLoggedInUser(profile);
      updateProfiles(new Set([pk]), readRelays(), profiles());
    } else {
      setLoggedInUser();
    }
  });

  // Publishing

  const onSuccess = async (event: Event, notice?: string) => {
    setLoading(false);
    // reset comment & error message (unless supplied)
    setComment('');
    setErrorMessage(notice ?? '');

    await save('events', eventToNoteEvent(event as Event), { immediate: true });

    // callback (closes the reply form)
    props.onDone?.call(this);
  };

  const onError = (message: string) => {
    setLoading(false);
    // set error message
    setErrorMessage(message);
  };

  const publish = async (profile?: Profile) => {
    let signer: EventSigner | undefined;
    if (profile) {
      signer = signersStore.active;
    } else {
      return;
    }

    if (!signer?.signEvent) {
      onError('User has no signer!');
      return;
    }

    const content = comment().trim();
    if (!content) return;

    const unsignedEvent: UnsignedEvent = {
      kind: ShortTextNote,
      created_at: currentTime(),
      content: content,
      pubkey: signer.pk,
      tags: generateTags(content),
    };

    try {
      validateWriteEvent({ ...unsignedEvent, id: undefined });
    } catch (e) {
      onError(errorText(e));
      return;
    }

    if (store.anchorAuthor && store.anchorAuthor !== unsignedEvent.pubkey) {
      // Add p tag from note author to notify them
      unsignedEvent.tags.push(['p', store.anchorAuthor!]);
    }

    if (store.externalAuthor) {
      try {
        const pubkey = decode(store.externalAuthor).data as string;
        unsignedEvent.tags.push(['p', pubkey]);
      } catch (_) { }
    }

    // If it is a reply, prepare root and reply tags
    if (props.replyTo) {
      const replyEvent = await find('events', IDBKeyRange.only(props.replyTo));
      if (replyEvent) {
        console.log('publishing reply');
        // If it is a reply, it must have a root
        unsignedEvent.tags.push(['e', replyEvent.ro!, '', 'root']);
        // If the user is not replying to themselves, add p to notify
        if (replyEvent.pk !== unsignedEvent.pubkey) {
          unsignedEvent.tags.push(['p', replyEvent.pk]);
        }
      }
      unsignedEvent.tags.push(['e', props.replyTo, '', 'reply']);
    } else {
      // Otherwise find the root
      const rootEventId = store.version || store.rootEventIds[0];
      if (rootEventId) {
        unsignedEvent.tags.push(['e', rootEventId, '', 'root']);
      } else if (anchor().type === 'http') {
        // If no root tag is present, create it to use as anchor
        const url = normalizeURL(anchor().value);
        const unsignedRootEvent: UnsignedEvent = {
          pubkey: signer.pk,
          created_at: currentTime(),
          kind: 8812,
          tags: [['r', url]],
          content: `Comments on ${url} ↴`
        };

        const rootEvent = await sign(unsignedRootEvent, signer);
        save('events', eventToNoteEvent(rootEvent));

        // Publish, store filter and get updated rootTag
        if (store.disableFeatures!.includes('publish')) {
          console.log('Publishing root event disabled', rootEvent);
        } else {
          console.log('publishing root event');
          pool.publishEvent(rootEvent);
        }
        // Update filter to this rootEvent
        store.filter = { "#e": [rootEvent.id] };
        unsignedEvent.tags.push(['e', rootEvent.id, '', 'root']);
      }
    }

    if (anchor().type === 'naddr') {
      unsignedEvent.tags.push(['a', anchor().value, '', 'root']);
    }

    if (store.language) {
      unsignedEvent.tags.push(['L', 'ISO-639-1']);
      unsignedEvent.tags.push(['l', store.language!, 'ISO-639-1']);
    }

    setLoading(true);
    if (store.disableFeatures!.includes('publish')) {
      // Simulate publishing
      const event = await sign(unsignedEvent, signer);
      setTimeout(() => onSuccess(event), 1000);
    } else {
      const { ok, failures, event } = await signAndPublishEvent(unsignedEvent, signer);
      if (ok === 0) {
        onError('Your comment was not published to any relay');
      } else {
        const msg = `Published to ${ok}/${writeRelays().length} relays (see console for more info)`;
        const notice = failures > 0 ? msg : undefined;
        onSuccess(event, notice);
      }
    }
  };

  // Only autofocus if 
  const autofocus = props.replyTo !== undefined;
  let ref!: HTMLTextAreaElement;
  createAutofocus(() => autofocus && ref);

  const maxCommentLength = () => store.maxCommentLength;
  const tooLong = () => comment().length > maxCommentLength();

  return <div class="ztr-reply-form">
    <textarea
      disabled={loading()}
      value={comment()}
      placeholder={store.replyPlaceholder || 'Add your comment...'}
      autofocus={autofocus}
      ref={ref}
      onInput={e => setComment(e.target.value)}
      classList={{'too-long': tooLong()}}
    />
      {comment().length > 0.98 * maxCommentLength() && <span classList={{'ztr-reply-error': tooLong()}}>{warningSvg()} Comment is limited to {maxCommentLength()} characters; you entered {comment().length}.</span>}
    <div class="ztr-reply-controls">
      {store.disableFeatures!.includes('publish') && <span>Publishing is disabled</span>}
      {errorMessage() && <span class="ztr-reply-error">{errorMessage()}</span>}

      <Show when={!loading()} fallback={
        <svg class="ztr-spinner" viewBox="0 0 50 50">
          <circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle>
        </svg>
      }>
        <div class="ztr-comment-info-picture">
          <img src={loggedInUser()?.i || defaultPicture} />
        </div>
      </Show>

      {loggedInUser() &&
        <button disabled={loading() || tooLong()} class="ztr-reply-button" onClick={() => publish(loggedInUser())}>
          Reply as {loggedInUser()!.n || shortenEncodedId(npubEncode(loggedInUser()!.pk))}
        </button>}

      {/*loggedInUser() &&
        <button class="ztr-reply-button" onClick={() => logout()}>Logout</button>*/}

      {!loggedInUser() &&
        <button class="ztr-reply-login-button" onClick={() => login()}>
          <div style="display: inline-grid; vertical-align: middle">{nostrSvg()}</div>&nbsp;Login</button>}
    </div>
  </div>;
};

export const RootComment = () => {
  const anchor = () => store.anchor!;

  const zapsAggregate = watch(() => ['aggregates', IDBKeyRange.only([anchor().value, 9735])]);
  const likesAggregate = watch(() => ['aggregates', IDBKeyRange.only([anchor().value, 7])]);
  const zapCount = () => zapsAggregate()?.sum ?? 0;
  const likeCount = () => likesAggregate()?.ids.length ?? 0;
  const comment = newSignal('');

  return <div class="ztr-comment-new">
    <div class="ztr-comment-body">
      <ul class="ztr-comment-actions">
        <Show when={!store.disableFeatures!.includes('likes')}>
          <li class="ztr-comment-action-like">
            {likeSvg()}
            <span>{likeCount()} likes</span>
          </li>
        </Show>
        <Show when={!store.disableFeatures!.includes('zaps')}>
          <li class="ztr-comment-action-zap">
            {lightningSvg()}
            <span>{satsAbbrev(zapCount())} sats</span>
          </li>
        </Show>
      </ul>
      <ReplyEditor comment={comment} />
    </div>
  </div>;
};
