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

export interface ProtonShareEntry {
    name: string;
    linkId: string;
    /** 1 = folder, 2 = file */
    type: number;
    size: number | null;
    mediaType: string | null;
}

export interface ProtonShareFile {
    name: string;
    bytes: Uint8Array;
    mediaType: string | null;
}

export class ProtonShareError extends Error {
    constructor(message: string, readonly code?: number) {
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
        throw new ProtonShareError(body?.Error || `Proton API ${res.status}`, body?.Code);
    }
    return body;
}

/** SRP handshake against the share; returns the session and unwrapped share key. */
async function openShare(token: string, password: string, customPassword = "") {
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

    return {
        authHeaders: { "x-pm-uid": auth.UID, authorization: `Bearer ${auth.AccessToken}` },
        volumeId: auth.Share.VolumeID as string,
        shareKey,
    };
}

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

async function decryptName(armored: string, shareKey: unknown): Promise<string> {
    const out: any = await CryptoProxy.decryptMessage({
        armoredMessage: armored,
        decryptionKeys: shareKey as any,
        verificationKeys: [],
    });
    return out.data;
}

/**
 * What a share link points at. A folder yields its immediate children so the
 * caller can let the user pick, without ever opening Proton's own web UI.
 */
export async function inspectProtonShare(url: string, customPassword = ""): Promise<{
    kind: "file" | "folder";
    name: string;
    entries: ProtonShareEntry[];
}> {
    const { token, password } = parseShareUrl(url);
    const { authHeaders, volumeId, shareKey } = await openShare(token, password, customPassword);

    const meta = (await api(`drive/urls/${token}`, { headers: authHeaders })).Token;
    const name = await decryptName(meta.Name, shareKey);

    if (meta.LinkType !== 1) {
        return {
            kind: "file",
            name,
            entries: [{ name, linkId: meta.LinkID, type: 2, size: meta.Size ?? null, mediaType: meta.MIMEType ?? null }],
        };
    }

    // A child's name is encrypted to its parent's node key, not to the share
    // key, so unwrap the folder's own key before reading the listing.
    const folderKey = await unwrapNodeKey(meta, shareKey);

    // The children endpoint answers with bare ids plus a cursor; the details
    // come from the same batch /links POST used for a file link.
    const linkIds: string[] = [];
    for (let anchor: string | undefined; ; ) {
        const page = await api(
            `drive/unauth/v2/volumes/${encodeURIComponent(volumeId)}/folders/${encodeURIComponent(meta.LinkID)}/children?`
            + (anchor ? `AnchorID=${encodeURIComponent(anchor)}` : ""),
            { headers: authHeaders },
        );
        linkIds.push(...(page.LinkIDs ?? []));
        if (!page.More || !page.AnchorID) break;
        anchor = page.AnchorID;
    }

    const entries: ProtonShareEntry[] = [];
    for (let i = 0; i < linkIds.length; i += 50) {
        const batch = await api(`drive/unauth/v2/volumes/${encodeURIComponent(volumeId)}/links`, {
            headers: authHeaders,
            json: { LinkIDs: linkIds.slice(i, i + 50) },
        });
        for (const item of batch.Links ?? []) {
            const raw = item.Link ?? item;
            entries.push({
                name: await decryptName(raw.Name, folderKey).catch(() => "(name unavailable)"),
                linkId: raw.LinkID,
                type: raw.Type,
                size: item.File?.ActiveRevision?.EncryptedSize ?? null,
                mediaType: item.File?.MediaType ?? null,
            });
        }
    }
    return { kind: "folder", name, entries };
}

/**
 * Fetch and decrypt one file from a share link. `linkId` selects a member of a
 * folder share; omit it for a link that points straight at a file.
 */
export async function downloadProtonShare(
    url: string,
    opts: { linkId?: string; customPassword?: string } = {},
): Promise<ProtonShareFile> {
    const { token, password } = parseShareUrl(url);
    const { authHeaders, volumeId, shareKey } = await openShare(token, password, opts.customPassword ?? "");

    const rootMeta = (await api(`drive/urls/${token}`, { headers: authHeaders })).Token;
    const nodeId = opts.linkId || rootMeta.LinkID;

    // Resolve the node: this POST is what yields the active revision id.
    const linksRes = await api(`drive/unauth/v2/volumes/${encodeURIComponent(volumeId)}/links`, {
        headers: authHeaders,
        json: { LinkIDs: [nodeId] },
    });
    const entry = (linksRes.Links ?? [])[0];
    if (!entry?.File?.ActiveRevision) {
        throw new ProtonShareError("That link is a folder, not a file");
    }

    // A node's key and name are wrapped by its PARENT's key. For the link's own
    // node that parent is the share; for a member of a folder share it is the
    // folder, so unwrap the folder first.
    const isChild = nodeId !== rootMeta.LinkID;
    const parentKey = isChild ? await unwrapNodeKey(rootMeta, shareKey) : shareKey;

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
