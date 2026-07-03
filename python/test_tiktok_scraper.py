# python/test_tiktok_scraper.py
import unittest
from tiktok_scraper import extract_universal_data, parse_search_api_response, parse_video_detail

# Shape confirmed against live TikTok on 2026-07-03: /api/search/general/full/
# returns {"data": [{"type": 1, "item": {...}}, ...], ...}.
SEARCH_API_RESPONSE = {
    'data': [
        {
            'type': 1,
            'item': {
                'id': '123',
                'desc': 'cool jacket #fit',
                'stats': {'playCount': 5000000},
                'video': {'playAddr': 'https://cdn.example/v1.mp4'},
                'music': {'original': False},
                'challenges': [{'title': 'fit'}],
                'author': {'uniqueId': 'someuser'},
            },
        }
    ]
}

VIDEO_HTML = '''<html><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
{"__DEFAULT_SCOPE__": {"webapp.video-detail": {"itemInfo": {"itemStruct":
  {"video": {"playAddr": "https://cdn.example/v2.mp4"}}
}}}}
</script>
</body></html>'''


class TestExtractUniversalData(unittest.TestCase):
    def test_extracts_embedded_json(self):
        data = extract_universal_data(VIDEO_HTML)
        self.assertIn('__DEFAULT_SCOPE__', data)

    def test_raises_when_blob_missing(self):
        with self.assertRaises(ValueError):
            extract_universal_data('<html><body>no data here</body></html>')

    def test_matches_script_tag_regardless_of_attribute_order(self):
        # TikTok/Playwright may serialize the type attribute before id.
        html = (
            '<script type="application/json" id="__UNIVERSAL_DATA_FOR_REHYDRATION__">'
            '{"__DEFAULT_SCOPE__": {"x": 1}}</script>'
        )
        data = extract_universal_data(html)
        self.assertEqual(data['__DEFAULT_SCOPE__']['x'], 1)


class TestParseSearchApiResponse(unittest.TestCase):
    def test_maps_items_to_candidates(self):
        candidates = parse_search_api_response(SEARCH_API_RESPONSE)
        self.assertEqual(len(candidates), 1)
        c = candidates[0]
        self.assertEqual(c['url'], 'https://www.tiktok.com/@someuser/video/123')
        self.assertEqual(c['views'], 5000000)
        self.assertEqual(c['downloadUrl'], '')
        self.assertTrue(c['hasVoice'])  # music.original == False -> no known sound -> voice heuristic true
        self.assertEqual(c['platform'], 'tiktok')
        self.assertEqual(c['title'], 'cool jacket #fit')
        self.assertEqual(c['hashtags'], ['fit'])

    def test_skips_entries_without_an_item(self):
        candidates = parse_search_api_response({'data': [{'type': 2}]})
        self.assertEqual(candidates, [])

    def test_skips_photo_carousel_posts(self):
        payload = {'data': [{'item': {
            'id': '1', 'author': {'uniqueId': 'a', 'downloadSetting': 0},
            'imagePost': {'images': []}, 'video': {}, 'stats': {}, 'music': {},
        }}]}
        self.assertEqual(parse_search_api_response(payload), [])

    def test_skips_download_disabled_creators(self):
        payload = {'data': [{'item': {
            'id': '1', 'author': {'uniqueId': 'a', 'downloadSetting': 3},
            'video': {}, 'stats': {}, 'music': {},
        }}]}
        self.assertEqual(parse_search_api_response(payload), [])

    def test_skips_ad_content(self):
        payload = {'data': [{'item': {
            'id': '1', 'author': {'uniqueId': 'a', 'downloadSetting': 0},
            'isAd': True, 'video': {}, 'stats': {}, 'music': {},
        }}]}
        self.assertEqual(parse_search_api_response(payload), [])


class TestParseVideoDetail(unittest.TestCase):
    def test_extracts_download_url(self):
        result = parse_video_detail(VIDEO_HTML)
        self.assertEqual(result['downloadUrl'], 'https://cdn.example/v2.mp4')


if __name__ == '__main__':
    unittest.main()
