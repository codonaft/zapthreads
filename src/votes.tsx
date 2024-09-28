import { Index, Show, createEffect, createComputed, createMemo, createSignal, onCleanup, batch, on, onMount } from "solid-js";
import { defaultPicture, parseContent, shortenEncodedId, svgWidth, totalChildren, errorText, getSigner } from "./util/ui.ts";
import { DAY_IN_SECS, WEEK_IN_SECS, currentTime, sortByDate, timeAgo } from "./util/date-time.ts";
import { signAndPublishEvent, manualLogin, validateNestedNoteEvent } from "./util/network.ts";
import { noteEncode, npubEncode } from "nostr-tools/nip19";
import { UnsignedEvent, Event } from "nostr-tools/core";
import { Relay } from "nostr-tools/relay";
import { Metadata, ShortTextNote, EventDeletion, Highlights, Reaction, Report, CommunityDefinition, Mutelist, Zap } from "nostr-tools/kinds";
import { EventSigner, signersStore, store, CommentContext } from "./util/stores.ts";
import { NoteEvent, Profile, Pk, ReactionEvent, VoteKind, Eid, voteKind } from "./util/models.ts";
import { remove } from "./util/db.ts";
import { newSignal, Signal, trigger } from "./util/solidjs.ts";
import { getOrSetOrUpdate } from "./util/collections.ts";
import { applyBlock } from "./util/block-lists.ts";

export const Votes = (props: {
  eventId: () => Eid;
  rootEventId: () => Eid;
  voteCounts: () => {
    upvotesCount: Signal<number>;
    downvotesCount: Signal<number>;
  };
  votes: () => ReactionEvent[];
}) => {
  const eventId = () => props.eventId();
  const rootEventId = () => props.rootEventId();
  const votes = () => props.votes();

  const hasVotes = newSignal(false);
  const currentUserVote = newSignal(0);
  const currentNoteVotes = () => props.votes().filter(r => r.noteId === eventId());
  const currentNoteVotesDeduplicatedByPks = () => {
    const grouped = new Map<Pk, ReactionEvent[]>();
    currentNoteVotes().forEach((r: ReactionEvent) => {
      getOrSetOrUpdate(grouped, r.pk, () => [], g => [...g, r]);
    });
    //const grouped = Map.groupBy(currentNoteVotes(), r => r.pk); // doesn't work on firefox esr
    return [...grouped.values()].map(reactionEvents => sortByDate(reactionEvents)[0]);
  };

  createEffect(() => {
    batch(() => {
      const votes = currentNoteVotesDeduplicatedByPks();
      hasVotes(votes.length > 0);

      const upvotes = votes
        .map(r => +(voteKind(r) === 1))
        .reduce((sum, i) => sum + i, 0);
      const downvotes = votes
        .map(r => +(voteKind(r) === -1))
        .reduce((sum, i) => sum + i, 0);
      props.voteCounts().upvotesCount(upvotes);
      props.voteCounts().downvotesCount(downvotes);

      const signer = signersStore.active;
      const kind: VoteKind = (signer && votes.filter(r => r.pk === signer!.pk).map(r => voteKind(r))[0]) || 0;
      currentUserVote(kind);
    });
  });

  const toggleVote = async (reaction: VoteKind) => {
    const s = await getSigner();
    if (!s) {
      return;
    }
    const signer = s!;
    const latestVote = currentUserVote();
    const newVote = latestVote === reaction ? 0 : reaction;

    const publishVote = async () => {
      const tags = [];
      if (rootEventId()) {
        tags.push(['e', rootEventId(), '', 'root']);
      }

      await signAndPublishEvent({
        kind: Reaction,
        created_at: currentTime(),
        content: newVote === -1 ? '-' : '+',
        pubkey: signer.pk,
        tags: [
          ...tags,
          ['e', eventId(), '', 'reply'],
          ['p', signer.pk],
        ],
      }, signer);
    };

    const unpublishOutdatedEvents = async () => {
      const eids: Eid[] = sortByDate(currentNoteVotes().filter(r => r.pk === signer!.pk))
        .reverse()
        .map(i => i.id);
      if (eids.length === 0) {
        return;
      }
      const sentRequest = await signAndPublishEvent({
        kind: EventDeletion,
        created_at: currentTime(),
        content: '',
        pubkey: signer.pk,
        tags: [...eids.map(eid => ['e', eid]), ...eids.map(_ => ['k', `${Reaction}`])],
      }, signer);
      if (sentRequest) {
        remove('reactions', eids);
      }
    };

    await unpublishOutdatedEvents();
    if ([-1, 1].includes(newVote)) {
      await publishVote();
    }
  };

  return <Show when={!store.disableFeatures!.includes('votes')}>
    <li class="ztr-comment-action-upvote" classList={{selected: currentUserVote() === 1}} onClick={() => toggleVote(1)}>
      {currentUserVote() === 1 ? upvoteSelectedSvg() : upvoteSvg()}
      <Show when={store.disableFeatures!.includes('singleVoteCounter') && hasVotes()}>
        <span>{props.voteCounts().upvotesCount()}</span>
      </Show>
    </li>
    <Show when={!store.disableFeatures!.includes('singleVoteCounter') || !hasVotes()}>
      <li class="ztr-comment-action-votes">
        <span>{hasVotes() ? (props.voteCounts().upvotesCount() - props.voteCounts().downvotesCount()) : 'Vote'}</span>
      </li>
    </Show>
    <li class="ztr-comment-action-downvote" classList={{selected: currentUserVote() === -1}} onClick={() => toggleVote(-1)}>
      {currentUserVote() === -1 ? downvoteSelectedSvg() : downvoteSvg()}
      <Show when={store.disableFeatures!.includes('singleVoteCounter') && hasVotes()}>
        <span>{props.voteCounts().downvotesCount()}</span>
      </Show>
    </li>
  </Show>;
};

const upvoteSvg = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M323.8 34.8c-38.2-10.9-78.1 11.2-89 49.4l-5.7 20c-3.7 13-10.4 25-19.5 35l-51.3 56.4c-8.9 9.8-8.2 25 1.6 33.9s25 8.2 33.9-1.6l51.3-56.4c14.1-15.5 24.4-34 30.1-54.1l5.7-20c3.6-12.7 16.9-20.1 29.7-16.5s20.1 16.9 16.5 29.7l-5.7 20c-5.7 19.9-14.7 38.7-26.6 55.5c-5.2 7.3-5.8 16.9-1.7 24.9s12.3 13 21.3 13L448 224c8.8 0 16 7.2 16 16c0 6.8-4.3 12.7-10.4 15c-7.4 2.8-13 9-14.9 16.7s.1 15.8 5.3 21.7c2.5 2.8 4 6.5 4 10.6c0 7.8-5.6 14.3-13 15.7c-8.2 1.6-15.1 7.3-18 15.2s-1.6 16.7 3.6 23.3c2.1 2.7 3.4 6.1 3.4 9.9c0 6.7-4.2 12.6-10.2 14.9c-11.5 4.5-17.7 16.9-14.4 28.8c.4 1.3 .6 2.8 .6 4.3c0 8.8-7.2 16-16 16H286.5c-12.6 0-25-3.7-35.5-10.7l-61.7-41.1c-11-7.4-25.9-4.4-33.3 6.7s-4.4 25.9 6.7 33.3l61.7 41.1c18.4 12.3 40 18.8 62.1 18.8H384c34.7 0 62.9-27.6 64-62c14.6-11.7 24-29.7 24-50c0-4.5-.5-8.8-1.3-13c15.4-11.7 25.3-30.2 25.3-51c0-6.5-1-12.8-2.8-18.7C504.8 273.7 512 257.7 512 240c0-35.3-28.6-64-64-64l-92.3 0c4.7-10.4 8.7-21.2 11.8-32.2l5.7-20c10.9-38.2-11.2-78.1-49.4-89zM32 192c-17.7 0-32 14.3-32 32V448c0 17.7 14.3 32 32 32H96c17.7 0 32-14.3 32-32V224c0-17.7-14.3-32-32-32H32z"/></svg>;
const downvoteSvg = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M323.8 477.2c-38.2 10.9-78.1-11.2-89-49.4l-5.7-20c-3.7-13-10.4-25-19.5-35l-51.3-56.4c-8.9-9.8-8.2-25 1.6-33.9s25-8.2 33.9 1.6l51.3 56.4c14.1 15.5 24.4 34 30.1 54.1l5.7 20c3.6 12.7 16.9 20.1 29.7 16.5s20.1-16.9 16.5-29.7l-5.7-20c-5.7-19.9-14.7-38.7-26.6-55.5c-5.2-7.3-5.8-16.9-1.7-24.9s12.3-13 21.3-13L448 288c8.8 0 16-7.2 16-16c0-6.8-4.3-12.7-10.4-15c-7.4-2.8-13-9-14.9-16.7s.1-15.8 5.3-21.7c2.5-2.8 4-6.5 4-10.6c0-7.8-5.6-14.3-13-15.7c-8.2-1.6-15.1-7.3-18-15.2s-1.6-16.7 3.6-23.3c2.1-2.7 3.4-6.1 3.4-9.9c0-6.7-4.2-12.6-10.2-14.9c-11.5-4.5-17.7-16.9-14.4-28.8c.4-1.3 .6-2.8 .6-4.3c0-8.8-7.2-16-16-16H286.5c-12.6 0-25 3.7-35.5 10.7l-61.7 41.1c-11 7.4-25.9 4.4-33.3-6.7s-4.4-25.9 6.7-33.3l61.7-41.1c18.4-12.3 40-18.8 62.1-18.8H384c34.7 0 62.9 27.6 64 62c14.6 11.7 24 29.7 24 50c0 4.5-.5 8.8-1.3 13c15.4 11.7 25.3 30.2 25.3 51c0 6.5-1 12.8-2.8 18.7C504.8 238.3 512 254.3 512 272c0 35.3-28.6 64-64 64l-92.3 0c4.7 10.4 8.7 21.2 11.8 32.2l5.7 20c10.9 38.2-11.2 78.1-49.4 89zM32 384c-17.7 0-32-14.3-32-32V128c0-17.7 14.3-32 32-32H96c17.7 0 32 14.3 32 32V352c0 17.7-14.3 32-32 32H32z"/></svg>;
const upvoteSelectedSvg = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M313.4 32.9c26 5.2 42.9 30.5 37.7 56.5l-2.3 11.4c-5.3 26.7-15.1 52.1-28.8 75.2H464c26.5 0 48 21.5 48 48c0 18.5-10.5 34.6-25.9 42.6C497 275.4 504 288.9 504 304c0 23.4-16.8 42.9-38.9 47.1c4.4 7.3 6.9 15.8 6.9 24.9c0 21.3-13.9 39.4-33.1 45.6c.7 3.3 1.1 6.8 1.1 10.4c0 26.5-21.5 48-48 48H294.5c-19 0-37.5-5.6-53.3-16.1l-38.5-25.7C176 420.4 160 390.4 160 358.3V320 272 247.1c0-29.2 13.3-56.7 36-75l7.4-5.9c26.5-21.2 44.6-51 51.2-84.2l2.3-11.4c5.2-26 30.5-42.9 56.5-37.7zM32 192H96c17.7 0 32 14.3 32 32V448c0 17.7-14.3 32-32 32H32c-17.7 0-32-14.3-32-32V224c0-17.7 14.3-32 32-32z"/></svg>;
const downvoteSelectedSvg = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M313.4 479.1c26-5.2 42.9-30.5 37.7-56.5l-2.3-11.4c-5.3-26.7-15.1-52.1-28.8-75.2H464c26.5 0 48-21.5 48-48c0-18.5-10.5-34.6-25.9-42.6C497 236.6 504 223.1 504 208c0-23.4-16.8-42.9-38.9-47.1c4.4-7.3 6.9-15.8 6.9-24.9c0-21.3-13.9-39.4-33.1-45.6c.7-3.3 1.1-6.8 1.1-10.4c0-26.5-21.5-48-48-48H294.5c-19 0-37.5 5.6-53.3 16.1L202.7 73.8C176 91.6 160 121.6 160 153.7V192v48 24.9c0 29.2 13.3 56.7 36 75l7.4 5.9c26.5 21.2 44.6 51 51.2 84.2l2.3 11.4c5.2 26 30.5 42.9 56.5 37.7zM32 384H96c17.7 0 32-14.3 32-32V128c0-17.7-14.3-32-32-32H32C14.3 96 0 110.3 0 128V352c0 17.7 14.3 32 32 32z"/></svg>;
