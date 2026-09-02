import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { TEMPERA_MAX_LAYER_IMAGES, type TemperaLayerImage } from '../types';
import {
    getTemperaLayerImage,
    prepareTemperaLayerImage,
    saveTemperaLayerImage,
    type StoredTemperaLayerImage,
} from './temperaLayerImages';

// src/services/temperaImageArchive.ts
// Moves the Tempera canvas-image pool in and out of a zip.
//
// The files themselves only ever live in IndexedDB keyed by `tempera_layer_image_${id}`; the
// tuning carries ids and placement, which is what makes it small enough to sync, and also what
// makes the pool invisible to every existing text export - a shortcode or a sync snapshot that
// carried the artwork would blow its own size budget. So the pool gets a binary sidecar: a zip
// holding the pool-wide settings plus the original bytes, rebuilt on import through the same
// `prepareTemperaLayerImage` path a drag-and-drop upload takes, thumbnails included.

const ARCHIVE_KIND = 'folia-tempera-pool';
const SCHEMA_VERSION = 1;

export interface TemperaImagePoolSnapshot {
    layerImages: TemperaLayerImage[];
    layerImageDepth: 'back' | 'front';
    layerImageFrequency: number;
}

export interface TemperaImageArchiveImportResult {
    layerImages: TemperaLayerImage[];
    layerImageDepth: 'back' | 'front';
    layerImageFrequency: number;
    /** Files that were skipped because they were not images the pool accepts. */
    skipped: number;
    /** Files dropped because the pool was already full. */
    truncated: number;
}

const EXTENSION_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
};

const encodeJson = (value: unknown) => strToU8(JSON.stringify(value, null, 2));

/** Rebuilds the on-disk name of an entry, falling back to the mime type for extension-less ids. */
const entryPath = (image: { id: string; name: string }, mimeType: string) => {
    const declared = image.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    const extension = declared && /^[a-z0-9]{1,5}$/.test(declared)
        ? declared
        : (EXTENSION_BY_MIME[mimeType] ?? 'bin');
    return `images/${image.id}.${extension}`;
};

const readJsonEntry = (files: Record<string, Uint8Array>, path: string): unknown => {
    const file = files[path];
    if (!file) throw new Error(`Tempera pool zip is missing ${path}`);
    return JSON.parse(strFromU8(file));
};

const asDepth = (value: unknown): 'back' | 'front' => (value === 'front' ? 'front' : 'back');

const asFrequency = (value: unknown) => (
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
);

/**
 * Reads the whole pool - settings and files - into a zip Blob. Entries whose file has gone
 * missing are dropped from the manifest instead of producing a zip with holes in it: importing
 * that back would restore placements that can never resolve to a picture.
 */
export const createTemperaImageArchiveBlob = async (
    snapshot: TemperaImagePoolSnapshot,
): Promise<Blob> => {
    const files: Record<string, Uint8Array> = {};
    const keptIds = new Set<string>();

    await Promise.all(snapshot.layerImages.map(async image => {
        const stored = await getTemperaLayerImage(image.id).catch(() => null);
        if (!stored?.blob) return;
        files[entryPath(image, stored.mimeType)] = new Uint8Array(await stored.blob.arrayBuffer());
        keptIds.add(image.id);
    }));

    // Order matters: the pool is rendered in array order and the pool-wide depth/frequency are
    // restored alongside it, so the zip replays the same pool rather than a shuffled one.
    const ordered = snapshot.layerImages.filter(image => keptIds.has(image.id));
    files['pool.json'] = encodeJson({
        layerImages: ordered,
        layerImageDepth: snapshot.layerImageDepth,
        layerImageFrequency: snapshot.layerImageFrequency,
    });
    files['meta.json'] = encodeJson({
        kind: ARCHIVE_KIND,
        schemaVersion: SCHEMA_VERSION,
        imageCount: ordered.length,
    });

    return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
};

const collectEntries = (
    files: Record<string, Uint8Array>,
    manifest: TemperaLayerImage[],
): Array<{ image: TemperaLayerImage; bytes: Uint8Array; mimeType: string }> => {
    const entries: Array<{ image: TemperaLayerImage; bytes: Uint8Array; mimeType: string }> = [];
    manifest.forEach(image => {
        const path = Object.keys(files).find(name => (
            name.startsWith(`images/${image.id}.`) && name.length > `images/${image.id}.`.length
        ));
        if (!path) return;
        const bytes = files[path];
        if (!bytes) return;
        const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const mimeType = Object.entries(EXTENSION_BY_MIME)
            .find(([, value]) => value === extension)?.[0] ?? 'application/octet-stream';
        entries.push({ image, bytes, mimeType });
    });
    return entries;
};

/**
 * Restores a pool from a zip. Rebuilds those bytes through `prepareTemperaLayerImage`
 * instead of storing them as-is, so an import arrives in exactly the state a fresh drag-and-drop
 * would leave it in - thumbnails and all - and so the shape is validated on the way in.
 */
export const readTemperaImageArchiveFile = async (
    file: File,
    options: { existing: TemperaLayerImage[]; maxImages?: number },
): Promise<TemperaImageArchiveImportResult> => {
    const maxImages = options.maxImages ?? TEMPERA_MAX_LAYER_IMAGES;
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const meta = readJsonEntry(files, 'meta.json') as { kind?: unknown; schemaVersion?: unknown } | null;
    if (!meta || meta.kind !== ARCHIVE_KIND || meta.schemaVersion !== SCHEMA_VERSION) {
        throw new Error('Not a Folia canvas-image backup');
    }

    const pool = readJsonEntry(files, 'pool.json') as {
        layerImages?: unknown;
        layerImageDepth?: unknown;
        layerImageFrequency?: unknown;
    };
    const manifest = Array.isArray(pool.layerImages) ? pool.layerImages as TemperaLayerImage[] : [];
    const entries = collectEntries(files, manifest);
    const existingIds = new Set(options.existing.map(image => image.id));
    // Files named by the manifest but absent from the archive: a backup edited by hand, or one
    // that lost entries to a partial write. Counted rather than thrown so the rest still imports.
    let skipped = manifest.length - entries.length;
    let truncated = 0;

    const layerImages: TemperaLayerImage[] = [];
    for (const entry of entries) {
        // A pool-size change means an older backup can hold more entries than fit now; those are
        // dropped rather than silently overflowing the pool.
        if (layerImages.length + options.existing.length >= maxImages) {
            truncated = entries.length - entries.indexOf(entry);
            break;
        }

        // The id travelled with the file, so importing the same backup twice would have the
        // second copy overwrite the first in IndexedDB instead of sitting next to it. A colliding
        // id is therefore minted afresh, leaving the existing record untouched.
        const source = new File(
            [new Uint8Array(entry.bytes) as unknown as BlobPart],
            entry.image.name || 'image',
            { type: entry.mimeType },
        );
        const prepared = await prepareTemperaLayerImage(source);
        const id = !existingIds.has(prepared.id) && !layerImages.some(image => image.id === prepared.id)
            ? prepared.id
            : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${prepared.name}`;
        const stored: StoredTemperaLayerImage = { ...prepared, id };
        await saveTemperaLayerImage(stored);
        layerImages.push({ ...entry.image, id, name: stored.name || entry.image.name });
        existingIds.add(id);
    }

    return {
        layerImages,
        layerImageDepth: asDepth(pool.layerImageDepth),
        layerImageFrequency: asFrequency(pool.layerImageFrequency),
        skipped,
        truncated,
    };
};
