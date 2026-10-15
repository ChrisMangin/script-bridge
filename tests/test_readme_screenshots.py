"""Offline README image checks; standard library only, no browser or network."""
from html.parser import HTMLParser
from pathlib import Path
import struct
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {'dashboard.png', 'editor.png', 'companion.png', 'guide.png'}


class Images(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.images = []
        self.links = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'img' and values.get('src', '').startswith('docs/screenshots/'):
            self.images.append(values)
        if tag == 'a':
            self.links.append(values.get('href', ''))


class ReadmeScreenshots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / 'README.md').read_text(encoding='utf-8')
        cls.html = Images(cls.text)

    def test_hero_and_gallery(self):
        images = self.html.images
        self.assertEqual(len(images), 5)
        self.assertEqual(images[0]['src'], 'docs/screenshots/dashboard.png')
        self.assertEqual(images[0]['width'], '860')
        self.assertEqual({Path(i['src']).name for i in images[1:]}, EXPECTED)
        self.assertTrue(all(i['width'] == '420' for i in images[1:]))

    def test_alt_text_and_full_size_links(self):
        for image in self.html.images:
            with self.subTest(image=image['src']):
                self.assertGreater(len(image.get('alt', '')), 20)
                self.assertIn(image['src'], self.html.links)
                self.assertTrue((ROOT / image['src']).is_file())

    def test_png_integrity_and_dimensions(self):
        for name in sorted(EXPECTED):
            with self.subTest(image=name):
                data = (ROOT / 'docs' / 'screenshots' / name).read_bytes()
                self.assertTrue(data.startswith(b'\x89PNG\r\n\x1a\n'))
                self.assertLess(len(data), 1_000_000)
                offset, chunks, pixels = 8, [], b''
                while offset < len(data):
                    size = struct.unpack('>I', data[offset:offset + 4])[0]
                    kind = data[offset + 4:offset + 8]
                    body = data[offset + 8:offset + 8 + size]
                    crc = struct.unpack('>I', data[offset + 8 + size:offset + 12 + size])[0]
                    self.assertEqual(zlib.crc32(kind + body) & 0xffffffff, crc)
                    chunks.append(kind)
                    if kind == b'IHDR':
                        self.assertEqual(struct.unpack('>II', body[:8]), (1440, 900))
                    elif kind == b'IDAT':
                        pixels += body
                    offset += size + 12
                self.assertEqual(offset, len(data))
                self.assertEqual(chunks[0], b'IHDR')
                self.assertEqual(chunks[-1], b'IEND')
                self.assertFalse({b'tEXt', b'zTXt', b'iTXt', b'eXIf'} & set(chunks))
                self.assertGreater(len(zlib.decompress(pixels)), 1440 * 900)

    def test_sample_data_and_unpaired_state_disclosed(self):
        self.assertIn('disabled documentation examples', self.text)
        self.assertIn('unpaired, with no token entered', self.text)

    def test_gallery_near_top_and_security_warning_retained(self):
        self.assertLess(self.text.index('## Screenshots'), self.text.index('## Features'))
        self.assertIn('Read [SECURITY.md](SECURITY.md) before use.', self.text)
        self.assertIn('Native scripts still run with your Windows account', self.text)


if __name__ == '__main__':
    unittest.main()
