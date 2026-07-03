"""CLI: search TikTok or resolve+download a single video, using Scrapling."""
import json
import re
import sys
from pathlib import Path

REHYDRATION_RE = re.compile(
    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>',
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


def parse_search_results(html: str) -> list[dict]:
    """Map a TikTok search results page to our internal candidate shape.

    downloadUrl is always '' here because the search page only exposes a
    CDN playAddr that expires quickly; the real download URL is fetched
    later via parse_video_detail on the video's own page.
    """
    data = extract_universal_data(html)
    items = (
        data.get('__DEFAULT_SCOPE__', {})
        .get('webapp.search-detail', {})
        .get('searchResult', {})
        .get('item_list', [])
    )
    candidates = []
    for item in items:
        author = item.get('author', {}).get('uniqueId', '')
        video_id = item.get('id', '')
        # music.original == False means the clip uses a known/trending sound
        # rather than the creator's own recorded audio, which usually means
        # there IS a spoken voice-over on top of it -> hasVoice = not original.
        original_sound = item.get('music', {}).get('original', True)
        candidates.append({
            'url': f'https://www.tiktok.com/@{author}/video/{video_id}',
            'views': item.get('stats', {}).get('playCount', 0),
            'downloadUrl': '',
            'hasVoice': not original_sound,
            'platform': 'tiktok',
            'title': item.get('desc', ''),
            'hashtags': [c.get('title', '') for c in item.get('challenges', [])],
        })
    return candidates


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
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(f'https://www.tiktok.com/search?q={query}')
    print(json.dumps(parse_search_results(page.html_content)))


def cmd_resolve(tiktok_url: str, dest_path: str) -> None:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(tiktok_url)
    info = parse_video_detail(page.html_content)
    video_page = StealthyFetcher.fetch(info['downloadUrl'])
    Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
    Path(dest_path).write_bytes(video_page.body)
    print(json.dumps({'path': dest_path}))


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
