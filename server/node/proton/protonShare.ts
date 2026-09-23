// Download a file from a Proton Drive public share link, server side, with no
// Proton account.
//
// Bundled to ../vendor/protonShare.mjs — see build.md in this folder. The
// bundle step is unavoidable: @protontech/crypto ships TypeScript source only
// and needs the `browser` export condition to resolve openpgp/lightweight.
// The resulting .mjs runs on plain Node with no special flags.
//
// Flow, as observed from Proton's own web client:
//   1. GET  drive/urls/{token}/info                     (no auth at all)
//   2. POST drive/urls/{token}/auth                     (SRP with the # fragment)
//   3. POST drive/unauth/v2/volumes/{volumeId}/links    (-> active revision id)
//   4. GET  drive/unauth/v2/volumes/{v}/files/{n}/revisions/{r}  (-> block urls)
//   5. GET  each block's BareURL with `pm-storage-token`, then decrypt
//
// Step 3 is a POST, not a GET. That is the part that cannot be guessed.
//
// Thumbnails follow @protontech/drive-sdk (internal/download/apiService.ts):
// ids come from File.ActiveRevision.Thumbnails on the links response, then
// POST drive/volumes/{volumeId}/thumbnails — `drive/unauth/...` on a public
// link — yields a BareURL + Token per id, and each thumbnail decrypts with the
// file's content session key.

import "@protontech/crypto/polyfill";
import { CryptoProxy } from "@protontech/crypto";
import { Api as CryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";
import { computeKeyPassword, getSrp } from "@protontech/crypto/srp";
import { createHash } from "node:crypto";

CryptoProxy.setEndpoint(new CryptoApi());

const BASE = "https://drive.proton.me/api";
// Proton's operational requirements: identify honestly, never impersonate a
// first-party client. https://github.com/ProtonDriveApps/sdk#operational-requirements
const APP_VERSION = "external-drive-pocketrisu@1.0.0-alpha";
const BLOCK_PAGE_SIZE = 50;
const LINKS_PER_REQUEST = 50;
/** The SDK's MAX_THUMBNAIL_IDS_PER_REQUEST. */
const THUMBNAILS_PER_REQUEST = 30;
/** Deeper than any real share; stops a crafted path from looping forever. */
const MAX_FOLDER_DEPTH = 32;

export interface ProtonShareEntry {
    name: string;
    linkId: string;
    /** 1 = folder, 2 = file */
    type: number;
    size: number | null;
    mediaType: string | null;
    /** Proton generated a small preview for this file (images, mostly). */
    hasThumbnail: boolean;
}

export interface ProtonFolderStep {
    linkId: string;
    name: string;
}

export interface ProtonShareFile {
    name: string;
    bytes: Uint8Array;
    mediaType: string | null;
}

export interface ProtonThumbnail {
    linkId: string;
    mediaType: string;
    bytes: Uint8Array;
}

export class ProtonShareError extends Error {
    constructor(message: string, readonly code?: number, readonly status?: number) {
        super(message);
        this.name = "ProtonShareError";
    }
}

/** `code` for a link this module rejected before ever calling Proton. */
export const PROTON_BAD_LINK = -1;

/** Split `https://drive.proton.me/urls/TOKEN#PASSWORD` into its two halves. */
export function parseShareUrl(url: string): { token: string; password: string } {
    const m = /drive\.proton\.me\/urls\/([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)/.exec(url.trim());
    if (!m) throw new ProtonShareError("Not a Proton Drive share link", PROTON_BAD_LINK);
    return { token: m[1], password: m[2] };
}

async function api(path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}) {
    const headers: Record<string, string> = {
        "x-pm-appversion": APP_VERSION,
        accept: "application/vnd.protonmail.v1+json",
        ...(opts.headers ?? {}),
    };
    if (opts.json !== undefined) headers["content-type"] = "application/json";

    const res = await fetch(`${BASE}/${path}`, {
        method: opts.json !== undefined ? "POST" : "GET",
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    });
    const body: any = await res.json().catch(() => ({}));
    if (body?.Code !== 1000) {
        throw new ProtonShareError(body?.Error || `Proton API ${res.status}`, body?.Code, res.status);
    }
    return body;
}

// ─── Session ────────────────────────────────────────────────────────────────
// Opening a share is an SRP handshake plus a bcrypt key derivation, which is
// the slow part of every request. Browsing a folder makes many requests in a
// row (list, thumbnails, open a subfolder, download), so a session is reused
// for a few minutes instead of repeating that handshake for each one.

interface ResolvedFolder {
    linkId: string;
    key: unknown;
    trail: ProtonFolderStep[];
}

interface ShareSession {
    authHeaders: Record<string, string>;
    volumeId: string;
    shareKey: unknown;
    rootMeta: any;
    rootName: string;
    folders: Map<string, Promise<ResolvedFolder>>;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 16;
const sessions = new Map<string, { session: Promise<ShareSession>; expires: number }>();

function sessionId(token: string, password: string, customPassword: string): string {
    // Hashed so the passwords are not kept around as readable map keys.
    return createHash("sha256").update(`${token}\n${password}\n${customPassword}`).digest("hex");
}

/** SRP handshake against the share; returns the session and unwrapped share key. */
async function openShare(token: string, password: string, customPassword = ""): Promise<ShareSession> {
    const info = await api(`drive/urls/${token}/info`);

    // Flag bit 0 means the sharer added a password on top of the fragment.
    if ((info.Flags & 1) === 1 && !customPassword) {
        throw new ProtonShareError("This link needs the password its owner set", 2026);
    }
    const srpPassword = `${password}${customPassword}`;

    const srp = await getSrp(
        {
            Version: info.Version,
            Modulus: info.Modulus,
            ServerEphemeral: info.ServerEphemeral,
            Salt: info.UrlPasswordSalt,
        },
        { password: srpPassword },
    );
    const auth = await api(`drive/urls/${token}/auth`, {
        json: {
            ClientProof: srp.clientProof,
            ClientEphemeral: srp.clientEphemeral,
            SRPSession: info.SRPSession,
        },
    });

    const computed = await computeKeyPassword(srpPassword, auth.Share.SharePasswordSalt);
    const sharePassphrase: any = await CryptoProxy.decryptMessage({
        armoredMessage: auth.Share.SharePassphrase,
        passwords: [computed],
    });
    const shareKey = await CryptoProxy.importPrivateKey({
        armoredKey: auth.Share.ShareKey,
        passphrase: sharePassphrase.data,
    });

    const authHeaders = { "x-pm-uid": auth.UID, authorization: `Bearer ${auth.AccessToken}` };
    const rootMeta = (await api(`drive/urls/${token}`, { headers: authHeaders })).Token;
    const rootName = await decryptName(rootMeta.Name, shareKey);

    return {
        authHeaders,
        volumeId: auth.Share.VolumeID as string,
        shareKey,
        rootMeta,
        rootName,
        folders: new Map(),
    };
}

/**
 * Run `work` against a share session, reusing a recent one. A reused session
 * that fails is thrown away and the work retried once on a fresh handshake,
 * since the usual cause is an access token that expired in the meantime.
 */
async function withSession<T>(url: string, customPassword: string, work: (session: ShareSession) => Promise<T>): Promise<T> {
    const { token, password } = parseShareUrl(url);
    const id = sessionId(token, password, customPassword);
    const now = Date.now();

    for (const [key, entry] of sessions) {
        if (entry.expires <= now) sessions.delete(key);
    }

    const cached = sessions.get(id);
    if (cached) {
        try {
            return await work(await cached.session);
        } catch (error) {
            // Only an expired or revoked token (HTTP 401/403) or a dropped
            // connection is worth a new handshake. Anything else is a verdict on
            // the request itself (a bad id, a key that does not open) and would
            // fail the same way again.
            const stale = error instanceof ProtonShareError
                ? error.status === 401 || error.status === 403
                : error instanceof TypeError;
            if (!stale) throw error;
            sessions.delete(id);
            console.warn("[protonShare] retrying with a fresh session:", (error as Error).message);
        }
    }

    const session = openShare(token, password, customPassword);
    if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next();
        if (!oldest.done) sessions.delete(oldest.value);
    }
    sessions.set(id, { session, expires: now + SESSION_TTL_MS });
    session.catch(() => sessions.delete(id));
    return work(await session);
}

// ─── Keys and links ─────────────────────────────────────────────────────────

/** Unwrap a node's private key using the key of whatever wraps it. */
async function unwrapNodeKey(node: { NodeKey: string; NodePassphrase: string }, parentKey: unknown) {
    const passphrase: any = await CryptoProxy.decryptMessage({
        armoredMessage: node.NodePassphrase,
        decryptionKeys: parentKey as any,
        verificationKeys: [],
    });
    return CryptoProxy.importPrivateKey({
        armoredKey: node.NodeKey,
        passphrase: passphrase.data,
    });
}

async function decryptName(armored: string, parentKey: unknown): Promise<string> {
    const out: any = await CryptoProxy.decryptMessage({
        armoredMessage: armored,
        decryptionKeys: parentKey as any,
        verificationKeys: [],
    });
    return out.data;
}

/** Link details for a set of ids, keyed by id (the API does not promise order). */
async function fetchLinks(session: ShareSession, linkIds: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    for (let i = 0; i < linkIds.length; i += LINKS_PER_REQUEST) {
        const batch = await api(`drive/unauth/v2/volumes/${encodeURIComponent(session.volumeId)}/links`, {
            headers: session.authHeaders,
            json: { LinkIDs: linkIds.slice(i, i + LINKS_PER_REQUEST) },
        });
        for (const item of batch.Links ?? []) {
            const link = item.Link ?? item;
            if (link?.LinkID) out.set(link.LinkID, item);
        }
    }
    return out;
}

/**
 * Walk from the shared folder down `path` (folder link ids, outermost first)
 * and return the last folder's key. A node's key is wrapped by its parent's,
 * so every level has to be unwrapped in order; a path that does not follow
 * the real tree fails to decrypt rather than reaching anything outside it.
 */
async function resolveFolder(session: ShareSession, path: readonly string[]): Promise<ResolvedFolder> {
    if (session.rootMeta.LinkType !== 1) {
        throw new ProtonShareError("This link points at a file, not a folder");
    }
    if (path.length > MAX_FOLDER_DEPTH) {
        throw new ProtonShareError("That folder is nested too deeply");
    }

    const cacheKey = path.join("/");
    let pending = session.folders.get(cacheKey);
    if (!pending) {
        pending = (async (): Promise<ResolvedFolder> => {
            if (path.length === 0) {
                return {
                    linkId: session.rootMeta.LinkID,
                    key: await unwrapNodeKey(session.rootMeta, session.shareKey),
                    trail: [],
                };
            }
            const parent = await resolveFolder(session, path.slice(0, -1));
            const linkId = path[path.length - 1];
            const item = (await fetchLinks(session, [linkId])).get(linkId);
            const link = item?.Link ?? item;
            if (!link || link.Type !== 1) {
                throw new ProtonShareError("That item is not a folder in this share");
            }
            if (link.ParentLinkID && link.ParentLinkID !== parent.linkId) {
                throw new ProtonShareError("That folder is not inside this share");
            }
            const name = await decryptName(link.Name, parent.key);
            return {
                linkId,
                key: await unwrapNodeKey(link, parent.key),
                trail: [...parent.trail, { linkId, name }],
            };
        })();
        session.folders.set(cacheKey, pending);
        pending.catch(() => session.folders.delete(cacheKey));
    }
    return pending;
}

function smallThumbnail(item: any): string | null {
    const thumbnails: any[] = item?.File?.ActiveRevision?.Thumbnails ?? [];
    // Type 1 is the small preview; the SDK does not support the others yet.
    return thumbnails.find((thumbnail) => thumbnail?.Type === 1 && thumbnail.ThumbnailID)?.ThumbnailID ?? null;
}

// ─── Public operations ──────────────────────────────────────────────────────

/**
 * What a share link points at. A folder yields the children of the folder at
 * `path` (empty for the shared folder itself) so the caller can browse it
 * without ever opening Proton's own web UI.
 */
export async function inspectProtonShare(url: string, customPassword = "", path: readonly string[] = []): Promise<{
    kind: "file" | "folder";
    name: string;
    trail: ProtonFolderStep[];
    entries: ProtonShareEntry[];
}> {
    return withSession(url, customPassword, async (session) => {
        const meta = session.rootMeta;
        if (meta.LinkType !== 1) {
            return {
                kind: "file",
                name: session.rootName,
                trail: [],
                entries: [{
                    name: session.rootName,
                    linkId: meta.LinkID,
                    type: 2,
                    size: meta.Size ?? null,
                    mediaType: meta.MIMEType ?? null,
                    hasThumbnail: false,
                }],
            };
        }

        const folder = await resolveFolder(session, path);

        // The children endpoint answers with bare ids plus a cursor; the details
        // come from the same batch /links POST used for a file link.
        const linkIds: string[] = [];
        for (let anchor: string | undefined; ; ) {
            const page = await api(
                `drive/unauth/v2/volumes/${encodeURIComponent(session.volumeId)}/folders/${encodeURIComponent(folder.linkId)}/children?`
                + (anchor ? `AnchorID=${encodeURIComponent(anchor)}` : ""),
                { headers: session.authHeaders },
            );
            linkIds.push(...(page.LinkIDs ?? []));
            if (!page.More || !page.AnchorID) break;
            anchor = page.AnchorID;
        }

        const details = await fetchLinks(session, linkIds);
        const entries: ProtonShareEntry[] = [];
        for (const linkId of linkIds) {
            const item = details.get(linkId);
            if (!item) continue;
            const raw = item.Link ?? item;
            // Drafts (a file whose upload never finished) have no content yet.
            if (raw.Type === 2 && !item.File?.ActiveRevision) continue;
            entries.push({
                name: await decryptName(raw.Name, folder.key).catch(() => "(name unavailable)"),
                linkId: raw.LinkID,
                type: raw.Type,
                size: item.File?.ActiveRevision?.EncryptedSize ?? null,
                mediaType: item.File?.MediaType ?? null,
                hasThumbnail: smallThumbnail(item) !== null,
            });
        }
        return { kind: "folder", name: session.rootName, trail: folder.trail, entries };
    });
}

/**
 * Small previews for files in the folder at `path`. Best effort: a file whose
 * preview cannot be fetched or decrypted is simply left out.
 */
export async function fetchProtonThumbnails(
    url: string,
    opts: { linkIds: readonly string[]; path?: readonly string[]; customPassword?: string },
): Promise<ProtonThumbnail[]> {
    return withSession(url, opts.customPassword ?? "", async (session) => {
        const folder = await resolveFolder(session, opts.path ?? []);
        const details = await fetchLinks(session, [...opts.linkIds]);

        const wanted: { linkId: string; thumbnailId: string; sessionKey: unknown }[] = [];
        for (const [linkId, item] of details) {
            const link = item.Link ?? item;
            const thumbnailId = smallThumbnail(item);
            if (!thumbnailId || !item.File?.ContentKeyPacket) continue;
            if (link.ParentLinkID && link.ParentLinkID !== folder.linkId) continue;
            try {
                const nodeKey = await unwrapNodeKey(link, folder.key);
                const sessionKey = await CryptoProxy.decryptSessionKey({
                    binaryMessage: (Uint8Array as any).fromBase64(item.File.ContentKeyPacket),
                    decryptionKeys: nodeKey,
                });
                wanted.push({ linkId, thumbnailId, sessionKey });
            } catch (error) {
                console.warn("[protonShare] thumbnail key skipped:", (error as Error).message);
            }
        }

        const out: ProtonThumbnail[] = [];
        for (let i = 0; i < wanted.length; i += THUMBNAILS_PER_REQUEST) {
            const batch = wanted.slice(i, i + THUMBNAILS_PER_REQUEST);
            const result = await api(`drive/unauth/volumes/${encodeURIComponent(session.volumeId)}/thumbnails`, {
                headers: session.authHeaders,
                json: { ThumbnailIDs: batch.map((entry) => entry.thumbnailId) },
            });
            for (const thumbnail of result.Thumbnails ?? []) {
                const entry = batch.find((candidate) => candidate.thumbnailId === thumbnail.ThumbnailID);
                if (!entry || !thumbnail.BareURL) continue;
                try {
                    const res = await fetch(thumbnail.BareURL, {
                        headers: { "pm-storage-token": thumbnail.Token, "x-pm-appversion": APP_VERSION },
                    });
                    if (!res.ok) continue;
                    const plain: any = await CryptoProxy.decryptMessage({
                        binaryMessage: new Uint8Array(await res.arrayBuffer()),
                        sessionKeys: entry.sessionKey as any,
                        verificationKeys: [],
                        format: "binary",
                    });
                    out.push({ linkId: entry.linkId, mediaType: sniffImageType(plain.data), bytes: plain.data });
                } catch (error) {
                    console.warn("[protonShare] thumbnail skipped:", (error as Error).message);
                }
            }
        }
        return out;
    });
}

/**
 * Fetch and decrypt one file from a share link. `linkId` selects a member of a
 * folder share, with `path` naming the folders it sits in; omit both for a
 * link that points straight at a file.
 */
export async function downloadProtonShare(
    url: string,
    opts: { linkId?: string; path?: readonly string[]; customPassword?: string } = {},
): Promise<ProtonShareFile> {
    return withSession(url, opts.customPassword ?? "", async (session) => {
        const { authHeaders, volumeId, shareKey, rootMeta } = session;
        const nodeId = opts.linkId || rootMeta.LinkID;

        // Resolve the node: this POST is what yields the active revision id.
        const entry = (await fetchLinks(session, [nodeId])).get(nodeId);
        if (!entry?.File?.ActiveRevision) {
            throw new ProtonShareError("That link is a folder, not a file");
        }

        // A node's key and name are wrapped by its PARENT's key. For the link's
        // own node that parent is the share; for a member of a folder share it
        // is whichever folder `path` leads to.
        const isChild = nodeId !== rootMeta.LinkID;
        let parentKey: unknown = shareKey;
        if (isChild) {
            const folder = await resolveFolder(session, opts.path ?? []);
            const link = entry.Link ?? entry;
            if (link.ParentLinkID && link.ParentLinkID !== folder.linkId) {
                throw new ProtonShareError("That file is not inside this folder");
            }
            parentKey = folder.key;
        }

        const link = entry.Link ?? rootMeta;
        const name = await decryptName(link.Name ?? rootMeta.Name, parentKey);
        const nodeKey = await unwrapNodeKey(link, parentKey);
        const sessionKey = await CryptoProxy.decryptSessionKey({
            binaryMessage: (Uint8Array as any).fromBase64(entry.File.ContentKeyPacket),
            decryptionKeys: nodeKey,
        });

        const revisionId = entry.File.ActiveRevision.RevisionID;
        const parts: Uint8Array[] = [];
        const encryptedHashes: Uint8Array[] = [];

        for (let fromIndex = 1; ; ) {
            const revision = (await api(
                `drive/unauth/v2/volumes/${encodeURIComponent(volumeId)}/files/${encodeURIComponent(nodeId)}`
                + `/revisions/${encodeURIComponent(revisionId)}?PageSize=${BLOCK_PAGE_SIZE}&FromBlockIndex=${fromIndex}`,
                { headers: authHeaders },
            )).Revision;

            const blocks = revision.Blocks ?? [];
            if (blocks.length === 0) break;

            for (const block of blocks) {
                const res = await fetch(block.BareURL, {
                    headers: { "pm-storage-token": block.Token, "x-pm-appversion": APP_VERSION },
                });
                if (!res.ok) throw new ProtonShareError(`Block ${block.Index} failed (${res.status})`);
                const encrypted = new Uint8Array(await res.arrayBuffer());
                encryptedHashes.push(new Uint8Array(createHash("sha256").update(encrypted).digest()));

                let signature: Uint8Array | undefined;
                if (block.EncSignature) {
                    const sig: any = await CryptoProxy.decryptMessage({
                        armoredMessage: block.EncSignature,
                        decryptionKeys: nodeKey,
                        format: "binary",
                    });
                    signature = sig.data;
                }
                const plain: any = await CryptoProxy.decryptMessage({
                    binaryMessage: encrypted,
                    binarySignature: signature,
                    sessionKeys: sessionKey,
                    verificationKeys: [],
                    format: "binary",
                });
                parts.push(plain.data);
            }

            if (blocks.length < BLOCK_PAGE_SIZE) break;
            fromIndex += blocks.length;
        }

        // Integrity: the manifest signs the concatenated SHA-256 of each encrypted
        // block. Proton omits it on some revisions, so verify only when present and
        // never fail the download on a missing one.
        const manifestSignature = entry.File.ActiveRevision.ManifestSignature;
        if (manifestSignature) {
            const manifest = concat(encryptedHashes);
            try {
                const verified: any = await CryptoProxy.verifyMessage({
                    binaryData: manifest,
                    armoredSignature: manifestSignature,
                    verificationKeys: [nodeKey],
                });
                if (verified.verificationStatus !== 2) {
                    throw new ProtonShareError("The file's integrity signature did not verify");
                }
            } catch (error) {
                if (error instanceof ProtonShareError) throw error;
                // A signature we cannot check is not a signature that failed.
                console.warn("[protonShare] manifest verification skipped:", (error as Error).message);
            }
        }

        return { name, bytes: concat(parts), mediaType: entry.File.MediaType ?? null };
    });
}

function sniffImageType(bytes: Uint8Array): string {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
    return "image/jpeg";
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
