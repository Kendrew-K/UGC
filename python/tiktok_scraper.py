"""CLI: search TikTok or resolve+download a single video, using Scrapling.

Confirmed against live TikTok (2026-07-03): the search page does NOT embed
results in server-rendered HTML (only app config) -- results are fetched
by the browser via an XHR call to /api/search/general/full/ after page
load, with request signing (X-Bogus/X-Gnarly) handled by TikTok's own JS.
So `search` uses Scrapling's capture_xhr to grab that in-browser API
response instead of parsing embedded JSON. The video-detail page (used by
`resolve`) DOES embed full item data server-side, so that path still parses
__UNIVERSAL_DATA_FOR_REHYDRATION__ directly. The CDN video URL is signed
and cookie/session-bound (a plain out-of-session fetch 403s), so `resolve`
downloads the video bytes inside the same authenticated browser session via
page_action, rather than fetching the URL separately.
"""
import json
import re
import sys
from pathlib import Path

REHYDRATION_RE = re.compile(
    r'<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>',
    re.S,
)


def extract_universal_data(html: str) -> dict:
    """Parse the JSON blob TikTok embeds in every server-rendered page.

    TikTok hydrates its React app from a single <script> tag; this is the
    one stable place to read search results / video metadata without
    executing JS.
    """
    match = REHYDRATION_RE.search(html)
    if not match:
        raise ValueError('__UNIVERSAL_DATA_FOR_REHYDRATION__ not found in page')
    return json.loads(match.group(1))


def _candidate_from_item(item: dict) -> dict:
    """Map one TikTok API item object to our internal candidate shape."""
    author = item.get('author', {}).get('uniqueId', '')
    video_id = item.get('id', '')
    # music.original == False means the clip uses a known/trending sound
    # rather than the creator's own recorded audio, which usually means
    # there IS a spoken voice-over on top of it -> hasVoice = not original.
    original_sound = item.get('music', {}).get('original', True)
    return {
        'url': f'https://www.tiktok.com/@{author}/video/{video_id}',
        'views': item.get('stats', {}).get('playCount', 0),
        'durationS': item.get('video', {}).get('duration', 0),
        'coverUrl': item.get('video', {}).get('cover', ''),
        'downloadUrl': '',
        'hasVoice': not original_sound,
        'platform': 'tiktok',
        'title': item.get('desc', ''),
        'hashtags': [c.get('title', '') for c in item.get('challenges', [])],
    }


def _is_downloadable(item: dict) -> bool:
    """Whether `resolve` has any real chance of getting a video for this item.

    'imagePost' means it's a photo-carousel post -- no video exists at all.
    author.downloadSetting != 0 means the creator disabled downloads, which
    TikTok enforces by withholding the CDN URL server-side (confirmed live:
    downloadSetting == 3 always returns an empty playAddr on the video page).
    isAd means it's sponsored/ad content, which never exposes a downloadable
    CDN URL either (confirmed live: no bitrateInfo at all, unlike normal
    videos, and an empty playAddr on the video page).
    Missing video.bitrateInfo is itself the general signal TikTok gives at
    search time for "no CDN URL later" -- confirmed live (2026-07-03) it also
    catches TikTok Shop / ecommerce clips (encodeUserTag
    'ecom_hiddenwm_item_only') that isAd/downloadSetting miss, and correlates
    perfectly with an empty playAddr on the video-detail page.
    """
    if 'imagePost' in item:
        return False
    if item.get('author', {}).get('downloadSetting', 0) != 0:
        return False
    if item.get('isAd'):
        return False
    if 'bitrateInfo' not in item.get('video', {}):
        return False
    return True


def parse_search_api_response(payload: dict) -> list[dict]:
    """Map one page of TikTok's /api/search/general/full/ JSON response to
    our internal candidate shape.

    Items that can never be downloaded (photo posts, download-disabled
    creators) are dropped here rather than surfaced as a pickable candidate
    that fails later at resolve time.

    downloadUrl is always '' here: this response's video.playAddr is
    session-bound and expires quickly, so the real download happens later,
    inside an authenticated browser session, via `resolve`.
    """
    entries = payload.get('data', [])
    items = [e['item'] for e in entries if 'item' in e]
    return [_candidate_from_item(item) for item in items if _is_downloadable(item)]


def _photo_candidate_from_item(item: dict) -> dict:
    """Map one TikTok photo-carousel item to our internal candidate shape.

    Photo posts have no audio track of their own (music is an overlay the
    final picture never inherits), so hasVoice is always False. downloadUrl
    is the first image's CDN URL — unlike video playAddr, these tplv image
    URLs are signed in the URL itself and fetchable outside the browser
    session (same mechanism as the cover thumbnails the ranker already
    fetches remotely).
    """
    author = item.get('author', {}).get('uniqueId', '')
    post_id = item.get('id', '')
    image_post = item.get('imagePost', {})
    image_urls = [
        urls[0]
        for img in image_post.get('images', [])
        if (urls := img.get('imageURL', {}).get('urlList', []))
    ]
    cover_urls = image_post.get('cover', {}).get('imageURL', {}).get('urlList', [])
    return {
        'url': f'https://www.tiktok.com/@{author}/photo/{post_id}',
        'views': item.get('stats', {}).get('playCount', 0),
        'coverUrl': cover_urls[0] if cover_urls else (image_urls[0] if image_urls else ''),
        'downloadUrl': image_urls[0] if image_urls else '',
        'imageUrls': image_urls,
        'hasVoice': False,
        'platform': 'tiktok',
        'title': item.get('desc', ''),
        'hashtags': [c.get('title', '') for c in item.get('challenges', [])],
    }


def parse_search_photos_response(payload: dict) -> list[dict]:
    """Map one page of TikTok's search JSON to photo-post candidates.

    Mirror image of parse_search_api_response: keeps ONLY imagePost items
    (video items are dropped) and drops carousels with no usable image URL.
    """
    entries = payload.get('data', [])
    items = [e['item'] for e in entries if 'item' in e]
    photo_items = [i for i in items if 'imagePost' in i]
    candidates = [_photo_candidate_from_item(i) for i in photo_items]
    return [c for c in candidates if c['imageUrls']]


def parse_video_detail(html: str) -> dict:
    """Extract the downloadable CDN URL from a single TikTok video page."""
    data = extract_universal_data(html)
    item = (
        data.get('__DEFAULT_SCOPE__', {})
        .get('webapp.video-detail', {})
        .get('itemInfo', {})
        .get('itemStruct', {})
    )
    download_url = item.get('video', {}).get('playAddr', '')
    if not download_url:
        raise ValueError('no downloadable video URL found on page')
    return {'downloadUrl': download_url}


# TikTok pages regularly take >30s (Playwright's default goto timeout) to
# reach 'load' on slow routes — confirmed live 2026-07-05 with repeated
# spurious "Timeout 30000ms exceeded" failures.
PAGE_TIMEOUT_MS = 90_000

# 3, not 6: each scroll is another /api/search XHR from the same IP, and heavy
# per-query request volume is what trips TikTok's rate-throttling (200 OK but an
# empty/withheld search response). 3 scrolls still yield ~40+ items per query.
SEARCH_SCROLLS = 3

# TikTok intermittently serves the search page but withholds the search XHR
# (a soft anti-bot block). Like cmd_resolve, a fresh browser context on a retry
# usually gets through, so don't hard-fail the whole query on the first block.
SEARCH_ATTEMPTS = 3


def _scroll_for_more_results(page):
    """Scroll the search page so TikTok fetches additional result pages
    (each scroll past the fold triggers another /api/search XHR of ~12 items;
    confirmed live 2026-07-05 that capture_xhr collects all of them)."""
    for _ in range(SEARCH_SCROLLS):
        page.mouse.wheel(0, 6000)
        page.wait_for_timeout(1200)
    return page


def _run_search(query: str, parse_page) -> None:
    """Drive one stealth-browser search and print candidates parsed by `parse_page`.

    Both video and photo search share the same page + XHR endpoint; only the
    per-page parser differs. Retries on a block (no XHR captured) or a browser
    crash with a fresh context, mirroring cmd_resolve; an empty-but-captured
    result is a genuine "no results", not a block, so it is returned as [].
    """
    from urllib.parse import quote
    from scrapling.fetchers import StealthyFetcher

    last_error: Exception | None = None
    for _ in range(SEARCH_ATTEMPTS):
        try:
            page = StealthyFetcher.fetch(
                f'https://www.tiktok.com/search?q={quote(query)}',
                capture_xhr='api/search/general/full',
                network_idle=True,
                wait=3000,
                page_action=_scroll_for_more_results,
                timeout=PAGE_TIMEOUT_MS,
            )
        except Exception as exc:  # browser crash mid-fetch; retry with a fresh context
            last_error = exc
            continue
        if not page.captured_xhr:
            last_error = ValueError('no search API response captured (page may have been blocked)')
            continue
        candidates = []
        for xhr in page.captured_xhr:
            candidates.extend(parse_page(json.loads(xhr.body)))
        print(json.dumps(candidates))
        return

    raise last_error if last_error else ValueError('search failed for an unknown reason')


def cmd_search(query: str) -> None:
    _run_search(query, parse_search_api_response)


def cmd_search_photos(query: str) -> None:
    _run_search(query, parse_search_photos_response)


RESOLVE_ATTEMPTS = 3


def cmd_resolve(tiktok_url: str, dest_path: str) -> None:
    """Download tiktok_url's video to dest_path.

    The CDN video URL is signed and cookie/session-bound (a plain fetch from
    outside the browser session that fetched it gets a 403), so the download
    happens inside a page_action callback, reusing the same authenticated
    browser context that loaded the video page.

    Confirmed live (2026-07-03): the headless browser occasionally crashes
    mid-download ("Target crashed" / "Connection closed while reading from
    the driver") for some videos, which then surfaces as an unrelated
    __UNIVERSAL_DATA_FOR_REHYDRATION__ parse error on Scrapling's own retry.
    Retrying the whole fetch here (fresh browser context each time) works
    around that instability.
    """
    from scrapling.fetchers import StealthyFetcher

    last_error: Exception | None = None
    for _ in range(RESOLVE_ATTEMPTS):
        outcome: dict = {}

        def download_in_session(page):
            html = page.content()
            info = parse_video_detail(html)
            # Default 30s timeout is too short to pull a multi-MB video over a
            # slow route to TikTok's CDN (confirmed live 2026-07-05: 200 OK but
            # body read exceeded 30s, causing spurious retries/failures).
            response = page.context.request.get(
                info['downloadUrl'],
                headers={'Referer': 'https://www.tiktok.com/'},
                timeout=180_000,
            )
            if response.status != 200:
                outcome['error'] = f'video download failed: HTTP {response.status}'
                return page
            Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
            Path(dest_path).write_bytes(response.body())
            outcome['path'] = dest_path
            return page

        try:
            StealthyFetcher.fetch(
                tiktok_url,
                network_idle=True,
                wait=2000,
                page_action=download_in_session,
                timeout=PAGE_TIMEOUT_MS,
            )
        except Exception as exc:  # browser crash mid-action; retry with a fresh context
            last_error = exc
            continue
        if 'path' not in outcome:
            # Scrapling swallows exceptions raised inside page_action (only logs
            # them), so a page_action failure like "no downloadable video URL
            # found on page" leaves outcome empty rather than raising here.
            last_error = ValueError(outcome.get('error', 'page_action did not produce a download'))
            continue
        print(json.dumps({'path': outcome['path']}))
        return

    raise last_error if last_error else ValueError('resolve failed for an unknown reason')


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        if command == 'search':
            cmd_search(sys.argv[2])
        elif command == 'search-photos':
            cmd_search_photos(sys.argv[2])
        elif command == 'resolve':
            cmd_resolve(sys.argv[2], sys.argv[3])
        else:
            print(f'unknown command: {command}', file=sys.stderr)
            sys.exit(1)
    except Exception as exc:  # surfaced to Node as stderr + non-zero exit
        print(str(exc), file=sys.stderr)
        sys.exit(1)
