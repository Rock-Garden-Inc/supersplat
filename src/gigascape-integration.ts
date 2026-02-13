/**
 * GigaScape Integration for SuperSplat
 *
 * When SuperSplat is loaded with a `gsConfig` URL parameter, this module:
 * 1. Adds "Save to GigaScape" to the File menu
 * 2. Serializes the scene to PLY on save
 * 3. Uploads directly to GCS via signed URL (bypasses Vercel 4.5MB limit)
 * 4. Calls save-complete endpoint to update Firestore
 *
 * gsConfig is a base64-encoded JSON: { splatId, userId, apiOrigin, authToken }
 */

import { MemoryFileSystem } from '@playcanvas/splat-transform';

import { Events } from './events';
import { Splat } from './splat';
import { ElementType } from './element';
import { Scene } from './scene';
import { serializePly, SerializeSettings } from './splat-serialize';

interface GsConfig {
    splatId: string;
    userId: string;
    apiOrigin: string;
    authToken: string;
}

let gsConfig: GsConfig | null = null;

/**
 * Parse gsConfig from URL params. Returns null if not present.
 */
const parseGsConfig = (): GsConfig | null => {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get('gsConfig');
    if (!encoded) return null;

    try {
        const json = atob(encoded);
        const config = JSON.parse(json);

        // Validate required fields
        if (!config.splatId || !config.apiOrigin || !config.authToken) {
            console.warn('[GigaScape] gsConfig missing required fields');
            return null;
        }

        return config as GsConfig;
    } catch (e) {
        console.warn('[GigaScape] Failed to parse gsConfig:', e);
        return null;
    }
};

/**
 * Check if GigaScape integration is active.
 * Checks URL directly so it works before initGigaScapeIntegration() is called
 * (the menu is constructed before init runs).
 */
const isGigaScapeMode = (): boolean => {
    return new URLSearchParams(window.location.search).has('gsConfig');
};

/**
 * Serialize all visible splats to PLY bytes in memory.
 */
const serializeSceneToPly = async (scene: Scene): Promise<Uint8Array> => {
    const splats = (scene.getElementsByType(ElementType.splat) as Splat[])
        .filter(splat => splat.visible)
        .filter(splat => splat.numSplats > 0);

    if (splats.length === 0) {
        throw new Error('No splats to save');
    }

    const memFs = new MemoryFileSystem();
    const settings: SerializeSettings = {
        maxSHBands: 3
    };

    await serializePly(splats, settings, memFs);

    const data = memFs.results.get('output.ply');
    if (!data) {
        throw new Error('PLY serialization produced no output');
    }

    return data;
};

/**
 * Get a signed upload URL from the GigaScape API.
 */
const getUploadUrl = async (fileSize: number): Promise<{ uploadUrl: string; storagePath: string }> => {
    const res = await fetch(`${gsConfig!.apiOrigin}/api/supersplat/upload-url`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${gsConfig!.authToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            splatId: gsConfig!.splatId,
            fileSize
        })
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Failed to get upload URL (${res.status})`);
    }

    return res.json();
};

/**
 * Upload PLY bytes directly to GCS via signed URL.
 */
const uploadToGcs = async (uploadUrl: string, data: Uint8Array): Promise<void> => {
    const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/octet-stream'
        },
        body: new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' })
    });

    if (!res.ok) {
        throw new Error(`Upload to GCS failed (${res.status})`);
    }
};

/**
 * Notify GigaScape that the save is complete.
 */
const notifySaveComplete = async (storagePath: string): Promise<void> => {
    const res = await fetch(`${gsConfig!.apiOrigin}/api/supersplat/save-complete`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${gsConfig!.authToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            splatId: gsConfig!.splatId,
            storagePath
        })
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Save notification failed (${res.status})`);
    }
};

/**
 * Initialize GigaScape integration. Call once after the events system is ready.
 */
const initGigaScapeIntegration = (events: Events, scene: Scene): void => {
    gsConfig = parseGsConfig();

    if (!gsConfig) {
        return;
    }

    console.log('[GigaScape] Integration active for splat:', gsConfig.splatId);

    // Register the save handler
    events.function('gigascape:save', async () => {
        events.fire('startSpinner');

        try {
            // 1. Serialize scene to PLY
            const plyData = await serializeSceneToPly(scene);
            console.log(`[GigaScape] Serialized PLY: ${(plyData.byteLength / 1024 / 1024).toFixed(1)} MB`);

            // 2. Get signed upload URL
            const { uploadUrl, storagePath } = await getUploadUrl(plyData.byteLength);
            console.log(`[GigaScape] Got upload URL, path: ${storagePath}`);

            // 3. Upload directly to GCS
            await uploadToGcs(uploadUrl, plyData);
            console.log('[GigaScape] Upload complete');

            // 4. Notify GigaScape
            await notifySaveComplete(storagePath);
            console.log('[GigaScape] Save complete');

            // Show success
            await events.invoke('showPopup', {
                type: 'info',
                header: 'Saved to GigaScape',
                message: 'Your edited splat has been saved. Return to your library to create tiles.'
            });

        } catch (error: any) {
            console.error('[GigaScape] Save failed:', error);

            await events.invoke('showPopup', {
                type: 'error',
                header: 'Save Failed',
                message: error.message || 'Unknown error while saving to GigaScape'
            });
        } finally {
            events.fire('stopSpinner');
        }
    });
};

export { initGigaScapeIntegration, isGigaScapeMode };
