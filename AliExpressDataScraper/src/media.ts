// Product media extraction — images and videos from the AliExpress PDP gallery.
//
// The gallery lives in `.image-view-v2--wrap`: a vertical strip of thumbnails
// (`.slider--item` › `.slider--img` › `img`) plus a large preview pane that holds the
// `<video>` element (with a poster) when the product has one. We deliberately read from the
// thumbnail strip rather than the large preview because the strip lists *every* media item up
// front, whereas the preview only shows whichever item is currently selected.
//
// AliExpress serves thumbnails at a fixed display size by appending a transform suffix to the
// CDN URL, e.g. `.../kf/HASH.jpg_220x220q75.jpg_.avif`. The original, full-resolution asset is
// the URL with that suffix stripped (`.../kf/HASH.jpg`), so we normalize every thumbnail back
// to its source before recording it.
import type { Page } from 'playwright';

import type { Media, ProductImage, ProductVideo } from './types.js';

// Each gallery thumbnail. Class names are content-hashed per build, so we match on the stable
// `slider--item` / `slider--img` prefixes rather than the exact suffixed names.
const GALLERY_IMAGE_SELECTOR = '[class*="slider--item"] [class*="slider--img"] img';

// The video element + poster live in the preview pane. Fall through progressively looser
// selectors so a markup tweak that drops the `video--wrap` class still yields the source.
const VIDEO_SELECTOR = '[class*="video--wrap"] video, .image-view-v2--previewWrap video, video';

// A CDN transform suffix is everything after the real file extension, e.g. the
// `_220x220q75.jpg_.avif` in `HASH.jpg_220x220q75.jpg_.avif`. Stripping it yields the original.
const CDN_TRANSFORM_SUFFIX = /\.(jpg|jpeg|png|webp|gif|bmp)_.*$/i;

/** Promote a protocol-relative URL (`//host/…`) to https; pass everything else through. */
function ensureAbsolute(url: string): string {
    return url.startsWith('//') ? `https:${url}` : url;
}

/**
 * Strip the AliExpress CDN transform suffix to recover the full-resolution source URL.
 *
 * `…/kf/HASH.jpg_220x220q75.jpg_.avif` → `…/kf/HASH.jpg`. URLs without a transform suffix
 * (already-original, or non-CDN) are returned unchanged.
 */
export function toFullResImageUrl(url: string): string {
    return ensureAbsolute(url.trim()).replace(CDN_TRANSFORM_SUFFIX, '.$1');
}

/**
 * Stable per-asset key used to de-duplicate the gallery (the same image often appears more than
 * once — e.g. the active thumbnail is repeated). We use the CDN filename without its extension,
 * which is a content hash, so identical assets collapse regardless of transform suffix.
 */
export function imageDedupeKey(url: string): string {
    const path = url.split('?')[0];
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const stem = filename.replace(/\.[a-z0-9]+$/i, '');
    return stem || url;
}

/** Raw gallery data read out of the DOM, before normalization. */
interface RawMedia {
    images: { src: string }[];
    videos: { src: string; poster: string }[];
}

/** Read the raw image/video URLs from the gallery DOM in a single round-trip. */
async function readRawMedia(page: Page): Promise<RawMedia> {
    return page.evaluate(
        ({ imageSelector, videoSelector }) => {
            const images = Array.from(document.querySelectorAll<HTMLImageElement>(imageSelector))
                .map((img) => ({ src: img.getAttribute('src') ?? '' }))
                .filter((entry) => entry.src);

            const videos = Array.from(document.querySelectorAll<HTMLVideoElement>(videoSelector))
                .map((video) => ({
                    src: video.querySelector('source')?.getAttribute('src') ?? video.getAttribute('src') ?? '',
                    poster: video.getAttribute('poster') ?? '',
                }))
                .filter((entry) => entry.src);

            return { images, videos };
        },
        { imageSelector: GALLERY_IMAGE_SELECTOR, videoSelector: VIDEO_SELECTOR },
    );
}

/**
 * Extract product images and videos from the gallery.
 *
 * Images are normalized to full resolution and de-duplicated by content hash (preserving the
 * gallery's order). Videos record both the playable source and its (full-resolution) poster
 * frame.
 */
export async function extractMedia(page: Page): Promise<Media> {
    const raw = await readRawMedia(page).catch(() => ({ images: [], videos: [] }) as RawMedia);

    const images: ProductImage[] = [];
    const seen = new Set<string>();
    for (const { src } of raw.images) {
        const url = toFullResImageUrl(src);
        const dedupeKey = imageDedupeKey(url);
        if (seen.has(dedupeKey)) {
            // Same asset seen again (e.g. the active thumbnail is repeated) — skip it.
            continue;
        }
        seen.add(dedupeKey);
        images.push({ url });
    }

    const videoSeen = new Set<string>();
    const videos: ProductVideo[] = [];
    for (const { src, poster } of raw.videos) {
        const url = ensureAbsolute(src.trim());
        if (videoSeen.has(url)) {
            continue;
        }
        videoSeen.add(url);
        videos.push({ url, poster: poster ? toFullResImageUrl(poster) : null });
    }

    return { images, videos };
}
