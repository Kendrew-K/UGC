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
        'downloadUrl': '',
        'hasVoice': not original_sound,
        'platform': 'tiktok',
        'title': item.get('desc', ''),
        'hashtags': [c.get('title', '') for c in item.get('challenges', [])],
    }


def parse_search_api_response(payload: dict) -> list[dict]:
    """Map one page of TikTok's /api/search/general/full/ JSON response to
    our internal candidate shape.

    downloadUrl is always '' here: this response's video.playAddr is
    session-bound and expires quickly, so the real download happens later,
    inside an authenticated browser session, via `resolve`.
    """
    entries = payload.get('data', [])
    return [_candidate_from_item(e['item']) for e in entries if 'item' in e]


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


def cmd_search(query: str) -> None:
    from urllib.parse import quote
    from scrapling.fetchers import StealthyFetcher

    page = StealthyFetcher.fetch(
        f'https://www.tiktok.com/search?q={quote(query)}',
        capture_xhr='api/search/general/full',
        network_idle=True,
        wait=3000,
    )
    if not page.captured_xhr:
        raise ValueError('no search API response captured (page may have been blocked)')
    candidates = []
    for xhr in page.captured_xhr:
        candidates.extend(parse_search_api_response(json.loads(xhr.body)))
    print(json.dumps(candidates))


def cmd_resolve(tiktok_url: str, dest_path: str) -> None:
    """Download tiktok_url's video to dest_path.

    The CDN video URL is signed and cookie/session-bound (a plain fetch from
    outside the browser session that fetched it gets a 403), so the download
    happens inside a page_action callback, reusing the same authenticated
    browser context that loaded the video page.
    """
    from scrapling.fetchers import StealthyFetcher

    outcome: dict = {}

    def download_in_session(page):
        html = page.content()
        info = parse_video_detail(html)
        response = page.context.request.get(
            info['downloadUrl'], headers={'Referer': 'https://www.tiktok.com/'}
        )
        if response.status != 200:
            outcome['error'] = f'video download failed: HTTP {response.status}'
            return page
        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        Path(dest_path).write_bytes(response.body())
        outcome['path'] = dest_path
        return page

    StealthyFetcher.fetch(tiktok_url, network_idle=True, wait=2000, page_action=download_in_session)
    if 'error' in outcome:
        raise ValueError(outcome['error'])
    print(json.dumps({'path': outcome['path']}))


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        if command == 'search':
            cmd_search(sys.argv[2])
        elif command == 'resolve':
            cmd_resolve(sys.argv[2], sys.argv[3])
        else:
            print(f'unknown command: {command}', file=sys.stderr)
            sys.exit(1)
    except Exception as exc:  # surfaced to Node as stderr + non-zero exit
        print(str(exc), file=sys.stderr)
        sys.exit(1)
