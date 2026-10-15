# README screenshots

These are real captures of the ScriptBridge 3.0.0 extension, using a disposable Chromium profile and six disabled documentation examples. They do not include personal scripts, local account paths or pairing credentials. The companion is not launched or paired.

- `dashboard.png`: script cards, filters and tags
- `editor.png`: syntax-highlighted Reading Mode example
- `companion.png`: unpaired companion page with an empty token field
- `guide.png`: built-in usage and security guide

The images are 1440 by 900 pixels. The repository README displays a large dashboard preview and a two-column gallery; each image links to its full-size file.

## Regenerate

Requires Python with Playwright and an installed Chromium build that supports loading unpacked extensions:

```powershell
python tests/capture_screenshots.py --browser "C:\path\to\chromium\chrome.exe"
python -m unittest discover -s tests -p "test_readme_screenshots.py"
```

The capture script uses the actual extension storage and UI. It checks that the example scripts stay disabled, the pairing token is absent, the pages have no JavaScript errors and the captures contain no local account paths or internal links. Non-extension page requests are blocked. Its temporary profile is removed when capture finishes.

Visually review every regenerated image before publishing. Do not use an installed browser profile or real scripts for public documentation.
