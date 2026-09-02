import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createTemperaImageArchiveBlob,
    readTemperaImageArchiveFile,
} from '@/services/temperaImageArchive';

// test/unit/services/temperaImageArchive.test.ts
// Covers the pool zip: settings round-trip, id remapping on a second import, and the pool cap.

const mocks = vi.hoisted(() => ({
    getTemperaLayerImage: vi.fn(),
    saveTemperaLayerImage: vi.fn(),
}));

vi.mock('@/services/db', () => ({ getFromCache: vi.fn(), removeFromCache: vi.fn(), saveToCache: vi.fn() }));
vi.mock('@/services/temperaLayerImages', async importOriginal => {
    const actual = await importOriginal<typeof import('@/services/temperaLayerImages')>();
    return {
        ...actual,
        getTemperaLayerImage: mocks.getTemperaLayerImage,
        saveTemperaLayerImage: mocks.saveTemperaLayerImage,
    };
});

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const storedImage = (id: string, name: string) => ({
    id,
    name,
    mimeType: 'image/png',
    blob: new Blob([pngBytes], { type: 'image/png' }),
});

const placement = (id: string, name = `${id}.png`) => ({
    id,
    name,
    align: 'center' as const,
    verticalAlign: 'bottom' as const,
    scale: 0.7,
    opacity: 1,
});

describe('tempera image archive', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getTemperaLayerImage.mockResolvedValue(null);
        mocks.saveTemperaLayerImage.mockResolvedValue(undefined);
    });

    it('round-trips the pool settings and leaves out placements whose file is gone', async () => {
        mocks.getTemperaLayerImage.mockImplementation(async (id: string) => (
            id === 'kept' ? storedImage('kept', 'kept.png') : null
        ));

        const blob = await createTemperaImageArchiveBlob({
            layerImages: [placement('kept'), placement('lost')],
            layerImageDepth: 'front',
            layerImageFrequency: 0.25,
        });
        const result = await readTemperaImageArchiveFile(
            new File([blob], 'pool.zip', { type: 'application/zip' }),
            { existing: [] },
        );

        expect(result.layerImageDepth).toBe('front');
        expect(result.layerImageFrequency).toBeCloseTo(0.25);
        expect(result.layerImages.map(image => image.id)).toHaveLength(1);
        expect(result.layerImages[0].scale).toBeCloseTo(0.7);
        // The export drops the placement rather than shipping a manifest that points at nothing.
        expect(result.skipped).toBe(0);
        expect(result.truncated).toBe(0);
    });

    it('counts manifest entries with no file in the archive', async () => {
        const { zipSync, strToU8 } = await import('fflate');
        const blob = new Blob([zipSync({
            'meta.json': strToU8('{"kind":"folia-tempera-pool","schemaVersion":1}'),
            'pool.json': strToU8(JSON.stringify({ layerImages: [placement('ghost')] })),
        })], { type: 'application/zip' });

        const result = await readTemperaImageArchiveFile(
            new File([blob], 'pool.zip', { type: 'application/zip' }),
            { existing: [] },
        );

        expect(result.layerImages).toHaveLength(0);
        expect(result.skipped).toBe(1);
    });

    it('mints a fresh id when the same backup is imported twice', async () => {
        mocks.getTemperaLayerImage.mockImplementation(async (id: string) => storedImage(id, `${id}.png`));
        const blob = await createTemperaImageArchiveBlob({
            layerImages: [placement('first')],
            layerImageDepth: 'back',
            layerImageFrequency: 0,
        });

        const first = await readTemperaImageArchiveFile(
            new File([blob], 'pool.zip', { type: 'application/zip' }),
            { existing: [] },
        );
        const second = await readTemperaImageArchiveFile(
            new File([blob], 'pool.zip', { type: 'application/zip' }),
            { existing: first.layerImages },
        );

        expect(second.layerImages[0].id).not.toBe(first.layerImages[0].id);
        // Importing twice must not overwrite the record the first import wrote.
        expect(mocks.saveTemperaLayerImage).toHaveBeenCalledTimes(2);
    });

    it('reports the entries it had to leave out when the pool is full', async () => {
        mocks.getTemperaLayerImage.mockImplementation(async (id: string) => storedImage(id, `${id}.png`));
        const blob = await createTemperaImageArchiveBlob({
            layerImages: [placement('a'), placement('b'), placement('c')],
            layerImageDepth: 'back',
            layerImageFrequency: 0,
        });

        const result = await readTemperaImageArchiveFile(
            new File([blob], 'pool.zip', { type: 'application/zip' }),
            { existing: [placement('taken')], maxImages: 2 },
        );

        expect(result.layerImages).toHaveLength(1);
        expect(result.truncated).toBe(2);
    });

    it('rejects a zip that is not a pool backup', async () => {
        const { zipSync, strToU8 } = await import('fflate');
        const blob = new Blob([zipSync({ 'meta.json': strToU8('{"kind":"something-else"}') })], {
            type: 'application/zip',
        });

        await expect(readTemperaImageArchiveFile(
            new File([blob], 'other.zip', { type: 'application/zip' }),
            { existing: [] },
        )).rejects.toThrow();
    });
});
