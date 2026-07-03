# UGC Creator

AI-powered UGC video generator. Upload a product photo, and the app automatically generates TikTok/Reels-ready UGC videos by classifying your product, scraping viral videos, and applying face-swap + animation techniques.

## Prerequisites

- **Node.js 20+** ([download](https://nodejs.org/))
- **ffmpeg** installed system-wide (for video processing)
  - On macOS: `brew install ffmpeg`
  - On Ubuntu/Debian: `sudo apt-get install ffmpeg`
  - On Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html) or use `choco install ffmpeg`
- **Git** ([download](https://git-scm.com/))

## Quick Start

### 1. Clone the Repository

```bash
git clone <repository-url>
cd ugc-creator
```

### 2. Set Up Environment Variables

Copy the example environment file and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
# Claude (for product classification)
ANTHROPIC_API_KEY=your-key-here

# Face-swap provider (fal.ai, recommended)
FAL_KEY=your-key-here
SWAP_PROVIDER=fal

# AI avatar generation (KIE.AI — used when client chooses "generate" face)
KIE_API_KEY=your-key-here
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Python setup (TikTok scraper)

The TikTok scraper runs as a small Python sidecar. One-time setup:

1. Install Python 3.10 or newer.
2. From the project root:
   ```bash
   python -m venv venv
   source venv/bin/activate  # Windows: venv\Scripts\activate
   pip install -r python/requirements.txt
   ```
3. Leave the virtualenv activated (or set `PYTHON_BIN` to its python path)
   whenever you run the app, so `python` on your PATH resolves to this venv.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│ 1. Upload Product Photo                                 │
│    └→ Browser uploads to /api/upload                    │
├─────────────────────────────────────────────────────────┤
│ 2. Claude Classification                                │
│    └→ Claude analyzes product, determines category      │
├─────────────────────────────────────────────────────────┤
│ 3. Viral Video Scraping                                 │
│    └→ Python sidecar (Scrapling) finds TikTok clips     │
│       (≥1M views) in category                           │
├─────────────────────────────────────────────────────────┤
│ 4. Face-Swap & Animation                                │
│    └→ WAN 2.2 animates faces into viral video footage   │
├─────────────────────────────────────────────────────────┤
│ 5. ffmpeg Distinctiveness Pass                          │
│    └→ Post-processing for quality & uniqueness          │
├─────────────────────────────────────────────────────────┤
│ 6. Ready to Post                                        │
│    └→ Videos appear at /ready for manual posting        │
└─────────────────────────────────────────────────────────┘
```

## Workflow

1. **Upload**: Browse to localhost:3000 and upload a product photo.
2. **Process**: The pipeline runs automatically—monitor progress in the UI.
3. **Review**: Generated videos appear in the "Ready to Post" queue at `/ready`.
4. **Post Manually**: Download and post videos to TikTok, Instagram Reels, or your platform of choice. *No automatic posting.*

## Storage

All media files and database records are stored locally in the `media/` directory (git-ignored). No data leaves your machine.

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for product classification |
| `FAL_KEY` | If `SWAP_PROVIDER=fal` | FAL API key for face-swap |
| `REPLICATE_API_TOKEN` | If `SWAP_PROVIDER=replicate` | Replicate API key for face-swap |
| `BANANA_PRO_API_KEY` | No | Banana API key for video distinctiveness |
| `SWAP_PROVIDER` | No | Which face-swap service to use (`fal` or `replicate`, default: `fal`) |
| `PYTHON_BIN` | No | Path to Python executable for the TikTok scraper sidecar (default: `python` on PATH) |

## Troubleshooting

**ffmpeg not found**: Ensure ffmpeg is installed and available in your system PATH. Test with `ffmpeg -version`.

**API key errors**: Double-check that all required keys in `.env` are filled in and valid.

**Out of memory**: If processing large batches, the service may run out of memory. Restart with `npm run dev`.

## Support

For issues or questions, refer to the inline documentation in the codebase or reach out to the development team.
