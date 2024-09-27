# zapthreads-codonaft

NIP-07-only fork of original [ZapThreads](https://github.com/franzaps/zapthreads#readme) web commenting system built on Nostr.

Test it here: https://codonaft.com/improved-zapthreads

![](https://codonaft.com/assets/img/zapthreads-codonaft.webp)

## Main Changes
- [x] Voting for comments (Reddit and YouTube-like)
- [x] Comment removal
  - limited, comments won't disappear for those who already loaded them
- [x] Auto thread collapsing for too long discussions
- [x] Customizable comments filtering, sanitizing and ranking
  - by NIP-13 PoW, replies number, language, etc.
  - Replies are always sorted by time in ascending order
  - Optional filtering using [spam.nostr.band](https://spam.nostr.band)
- [x] Moderation (reporting and mute-listing, moderators retrieval from community)
- [x] Relays retrieval from NIP-07 browser extension and from NIP-65 relay list as fallback
- [x] Optional persistent user sessions
- [x] Optional relay capabilities testing using NIP-11
- [x] Callbacks for better website integration
- [x] Bugfixes and performance optimizations

Some of the stuff I may work on later:
- [ ] Voting for author's root post
- [ ] Label author's answers and reactions with avatar, similar to YouTube
- [ ] (API for) Logout button
- [ ] (API for) Follow author's profile button
- [ ] Show Report button when hovering on comment only
- [ ] Button that resends your comment to the previously failed relays
- [ ] Rank by reports from other users
- [ ] Fix comments and replies counters
  - currently they ignore filtered out (due to moderation) comments
- [ ] <kbd>Ctrl</kbd> + <kbd>↵</kbd> / <kbd>⌘</kbd> + <kbd>↵</kbd> hotkey to reply
- [ ] Faster NIP-13 PoW implementation
- [ ] [Gossip](https://github.com/frnandu/yana/blob/master/GOSSIP.md) model
- [ ] Turn all animated avatars into static pictures, animate them on hover only
- [ ] Optional comment preview (GitHub-like)
- Zaps
    - [ ] Zap comment
    - [ ] Rank comments by zaps
- Moderation
    - [x] Approve messages written by users that are followed by current user/author/moderator by default
        - limited, may require page reload for now
    - [ ] Make moderated comments filtering instant
      - currently some lag is still possible
    - [ ] Blur images from comments reported as NSFW, unblur on hover
    - [ ] Blur avatars from users reported as NSFW, unblur on hover
    - [ ] Show comments with a negative vote rating more transparent
      - the lower the rating—the lower opacity
      - normal opacity on hover

Your [⚡zaps](https://codonaft.com/sponsor) help me allocate time on these! 🙏🏼

PRs are also welcome!

## Usage

```bash
npm i

node_modules/.bin/vite build
# node_modules/.bin/vite build --minify false --mode debug
```

```html
<script type="text/javascript" src="dist/zapthreads.iife.js"></script>

<zap-threads
  anchor="naddr1qqxnzd3cxqmrzv3exgmr2wfeqgsxu35yyt0mwjjh8pcz4zprhxegz69t4wr9t74vk6zne58wzh0waycrqsqqqa28pjfdhz"
  relays="wss://relay.nostr.band,wss://nostr-pub.wellorder.net/"
  disable="likes,singleVoteCounter"
  />

<script>
ZapThreads.start();
</script>
```

Arguments:

 - `anchor`:
   - Required!
   - NIP-19 naddr, note, nevent or URL from where to retrieve events
 - `version`
   - ID of the event to show in case a naddr (long-form note) has multiple versions
 - `relays`: comma-separated list of relays, unset by default (will not load any content)
   - if any relays are set in the NIP-07 extension — `relays` will be overwritten after logging in
 - `author`:
   - This npub will be added as a `p` tag to all comments
   - Useful for notifying the author of a website (http anchor)
 - `community`: retrieve trusted moderators from here
   - anchor author (including `author`) is automatically a moderator
   - comments reported by moderator and logged in user are hidden
 - `disable`: comma-separated string of features to disable, all enabled by default
   - `likes`
   - `votes`
   - `singleVoteCounter`
   - `zaps`
   - `reply` (when disabled the component becomes read-only)
   - `publish` (when disabled does not send event to relays, useful for testing)
   - `watch` (when disabled queries relays and closes the connection immediately on EOSE)
   - `hideContent` (when disabled it shows the content if the anchor is a naddr)
   - `relayInformation` (when disabled NIP-11 relay filtering is off)
   - `spamNostrBand`
   - `followIsApproval`
 - `urls`: comma-separated pairs of URLs
   - defaults to `naddr:nostr.at/,npub:nostr.at/,nprofile:nostr.at/,nevent:nostr.at/,note:nostr.at/,tag:snort.social/t/`
   - `https://` will be automatically prepended
 - `language`: allowed language, no restrictions by default
   - ISO-639-1 two-letter code only
   - ignores relays with unsupported language (unless `disable="relayInformation"` is set)
   - labels comments sent from the client with the language tag
     - note: there's no validation whether user actually sent message in this language, use `onEvent` to validate it
 - `client`: string with client name (like `zapthreads-codonaft` or your domain name, etc.)
   - adds client tag, unset by default
 - `max-comment-length`: limit comment length, disabled by default
 - `min-read-pow` and `max-write-pow`: difficulty boundaries that determine how warm we make our planet while desperately fighting spam, `0` by default
   - ignores events sent with difficulty less than `min-read-pow`
     - difficulty validation is done on client if any read relay doesn't implement NIP-13 or doesn't have required difficulty limitation
   - write pow difficulty is determined as maximum of
     - `min-read-pow`
     - current minimal pow of write relays limitations (unless `disable="relayInformation"` is set), bounded by `max-write-pow`
   - `anchor` difficulty is ignored, it can be `0`
   - such message will be visible even with too low PoW if moderator/author/current user follows the commenter
     - unless (`disable="followIsApproval"` is set)

## Customize

### CSS

Available CSS variables (define in `zap-threads`):
  - `--ztr-font`
  - `--ztr-font-size`
  - `--ztr-text-color`
  - `--ztr-link-color`
  - `--ztr-action-color`
  - `--ztr-action-hover-color`
  - `--ztr-background-color`
  - `--ztr-icon-color`

For more advanced CSS control via `shadowRoot`:

```js
const style = document.createElement('style');
style.innerHTML = '#ztr-root { font-size: 12em; }';
document.querySelector('zap-threads').shadowRoot.appendChild(style);
```

### Callbacks
```js
ZapThreads
  .onLogin(async ({ knownUser }) => {
    if (!knownUser) {
      // annoy with consent dialog here
    }
    return { accepted: true, autoLogin: true };
  })
  .onRemove(async ({}) => {
    return { accepted: true };
  })
  .onReport(async ({}) => {
    return { accepted: true, list: 'event', type: 'other', reason: '' };
  })
  .onEvent(({ rankable, kind, content, replies, upvotes, downvotes, pow, language, client, followedByModerator }) => {
    if (kind === 1 && content.includes('poker')) {
      throw new Error("No spamming please, we're discussing important things here");
    }

    let rank;
    if (rankable) {
      rank = (content.length > 1000 ? -1 : 0) + (upvotes - downvotes) * 100;
    }

    return {
      sanitizedContent: content.replaceAll('perkele', 'mind-blowing'),
      showReportButton: content.includes('https://'),
      rank,
    };
  })
  .onPublish(async ({ relays }) => {
    if (relays.length === 0) {
      // no available write relays, perhaps they are not set
    }
    return { accepted: true };
  })
  .start();
```

## Icons
- [Font Awesome](https://fontawesome.com/license/free)

## LICENSE

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org/>
