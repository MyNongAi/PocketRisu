// Proton Drive public share downloader
// Implements SRP auth + PGP key chain decryption for zero-knowledge file retrieval

const nodeCrypto = require('crypto');
const bcrypt = require('bcryptjs');

let _openpgp = null;
async function getOpenpgp() {
    if (!_openpgp) _openpgp = require('openpgp');
    return _openpgp;
}

const API_BASE = 'https://drive.proton.me/api';
const PROTON_HEADERS = {
    'Accept': 'application/vnd.protonmail.v1+json',
    'Content-Type': 'application/json',
    'x-pm-appversion': 'web-drive@5.0.0',
};

// ─── URL Parsing ──────────────────────────────────────────────────────────────

function parseProtonShareUrl(url) {
    const match = url.match(/drive\.proton\.me\/urls\/([A-Za-z0-9_-]+)#(.+)/);
    if (!match) throw new Error('Invalid Proton Drive share URL');
    return { token: match[1], urlPassword: decodeURIComponent(match[2]) };
}

// ─── BigInt Utilities ─────────────────────────────────────────────────────────

function bigIntToBytes(n, len) {
    const hex = n.toString(16).padStart(len * 2, '0');
    return Buffer.from(hex, 'hex');
}

function bytesToBigInt(bytes) {
    if (bytes.length === 0) return 0n;
    return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

function modPow(base, exp, mod) {
    if (mod === 1n) return 0n;
    base = ((base % mod) + mod) % mod;
    let result = 1n;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

// ─── SRP Password Hashing ────────────────────────────────────────────────────

function computeKeyPassword(password, salt) {
    const hashed = bcrypt.hashSync(password, '$2y$10$' + salt);
    return hashed.slice(-31);
}

function expandHash(input) {
    const result = Buffer.alloc(256);
    let buf = Buffer.from(input, 'binary');
    let offset = 0;
    while (offset < 256) {
        buf = nodeCrypto.createHash('sha512').update(buf).digest();
        const copyLen = Math.min(64, 256 - offset);
        buf.copy(result, offset, 0, copyLen);
        offset += copyLen;
    }
    return result;
}

function hashPasswordForSRP(keyPassword, salt) {
    const saltBytes = Buffer.from(salt, 'base64');
    const saltBinaryStr = String.fromCharCode(...saltBytes);
    const normalizedSalt = Buffer.from(saltBytes).toString('base64');
    const bcryptHash = bcrypt.hashSync(keyPassword, '$2y$10$' + normalizedSalt);
    return expandHash(saltBinaryStr + bcryptHash);
}

// ─── SRP Proof Generation ─────────────────────────────────────────────────────

async function extractModulus(armoredModulus) {
    const openpgp = await getOpenpgp();
    const msg = await openpgp.readCleartextMessage({ cleartextMessage: armoredModulus });
    const text = msg.getText().trim();
    return Buffer.from(text, 'base64');
}

function srpHashBN(len, ...bigints) {
    const bufs = bigints.map(v => {
        if (typeof v === 'bigint') return bigIntToBytes(v, len);
        return Buffer.from(v);
    });
    const combined = Buffer.concat(bufs);
    const hash = nodeCrypto.createHash('sha256').update(combined).digest();
    return bytesToBigInt(hash);
}

async function generateSRPProofs(modulusBytes, hashedPasswordBytes, serverEphemeralBytes) {
    const len = modulusBytes.length;
    const N = bytesToBigInt(modulusBytes);
    const g = 2n;
    const B = bytesToBigInt(serverEphemeralBytes);
    const x = bytesToBigInt(hashedPasswordBytes);

    if (B % N === 0n) throw new Error('Invalid server ephemeral');

    const k = srpHashBN(len, N, g);

    let a, A;
    do {
        a = bytesToBigInt(nodeCrypto.randomBytes(len));
        A = modPow(g, a, N);
    } while (A % N === 0n);

    const u = srpHashBN(len, A, B);
    if (u === 0n) throw new Error('Invalid SRP scrambling parameter');

    const gx = modPow(g, x, N);
    const kgx = (k * gx) % N;
    let base = (B - kgx) % N;
    if (base < 0n) base += N;
    const S = modPow(base, a + u * x, N);

    const K = nodeCrypto.createHash('sha256').update(bigIntToBytes(S, len)).digest();
    const M1 = nodeCrypto.createHash('sha256')
        .update(Buffer.concat([bigIntToBytes(A, len), bigIntToBytes(B, len), K]))
        .digest();
    const M2 = nodeCrypto.createHash('sha256')
        .update(Buffer.concat([bigIntToBytes(A, len), M1, K]))
        .digest();

    return {
        clientEphemeral: bigIntToBytes(A, len).toString('base64'),
        clientProof: M1.toString('base64'),
        expectedServerProof: M2.toString('base64'),
    };
}

// ─── API Client ───────────────────────────────────────────────────────────────

async function protonFetch(url, options = {}) {
    const headers = { ...PROTON_HEADERS, ...options.headers };
    const resp = await fetch(url, { ...options, headers });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Proton API ${resp.status}: ${text.slice(0, 300)}`);
    }
    return resp;
}

async function protonGet(path, auth) {
    const headers = auth ? {
        'Authorization': `Bearer ${auth.accessToken}`,
        'x-pm-uid': auth.uid,
    } : {};
    const resp = await protonFetch(`${API_BASE}${path}`, { headers });
    return resp.json();
}

async function protonPost(path, body, auth) {
    const headers = auth ? {
        'Authorization': `Bearer ${auth.accessToken}`,
        'x-pm-uid': auth.uid,
    } : {};
    const resp = await protonFetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    return resp.json();
}

// ─── SRP Authentication Flow ──────────────────────────────────────────────────

async function srpAuthenticate(token, urlPassword) {
    const info = await protonGet(`/drive/urls/${token}/info`);
    const srpInfo = info.SRPHandshake || info;

    const modulus = srpInfo.Modulus;
    const serverEphemeral = srpInfo.ServerEphemeral;
    const salt = srpInfo.UrlPasswordSalt;
    const session = srpInfo.SRPSession;
    const version = srpInfo.Version || 4;

    const modulusBytes = await extractModulus(modulus);
    const keyPassword = computeKeyPassword(urlPassword, salt);
    const hashedPassword = hashPasswordForSRP(keyPassword, salt);
    const serverEphemeralBytes = Buffer.from(serverEphemeral, 'base64');

    const proofs = await generateSRPProofs(modulusBytes, hashedPassword, serverEphemeralBytes);

    const authResult = await protonPost(`/drive/urls/${token}/auth`, {
        SRPSession: session,
        ClientEphemeral: proofs.clientEphemeral,
        ClientProof: proofs.clientProof,
    });

    if (authResult.ServerProof !== proofs.expectedServerProof) {
        throw new Error('SRP server proof verification failed');
    }

    return {
        accessToken: authResult.AccessToken,
        uid: authResult.UID,
        keyPassword,
    };
}

// ─── Key Chain Decryption ─────────────────────────────────────────────────────

async function decryptSharePassphrase(shareData, urlPassword) {
    const openpgp = await getOpenpgp();

    const sharePasswordSalt = shareData.SharePasswordSalt;
    const keyPassword = sharePasswordSalt
        ? computeKeyPassword(urlPassword, sharePasswordSalt)
        : urlPassword;

    const passphraseKeyPacket = shareData.SharePassphraseKeyPacket;
    const passphrase = shareData.SharePassphrase;

    let message;
    if (passphraseKeyPacket && passphrase) {
        const keyPacketBuf = Buffer.from(passphraseKeyPacket, 'base64');
        const dataBuf = Buffer.from(passphrase, 'base64');
        message = await openpgp.readMessage({ binaryMessage: Buffer.concat([keyPacketBuf, dataBuf]) });
    } else if (passphrase) {
        try {
            message = await openpgp.readMessage({ armoredMessage: passphrase });
        } catch {
            message = await openpgp.readMessage({ binaryMessage: Buffer.from(passphrase, 'base64') });
        }
    } else {
        throw new Error('No share passphrase data found');
    }

    const { data } = await openpgp.decrypt({
        message,
        passwords: [keyPassword],
        format: 'utf8',
    });
    return data;
}

async function unlockPrivateKey(armoredKey, passphrase) {
    const openpgp = await getOpenpgp();
    const privateKey = await openpgp.readPrivateKey({ armoredKey });
    return openpgp.decryptKey({ privateKey, passphrase });
}

async function decryptWithKey(encryptedData, decryptionKey) {
    const openpgp = await getOpenpgp();

    let message;
    try {
        message = await openpgp.readMessage({ armoredMessage: encryptedData });
    } catch {
        message = await openpgp.readMessage({
            binaryMessage: Buffer.from(encryptedData, 'base64'),
        });
    }

    const { data } = await openpgp.decrypt({
        message,
        decryptionKeys: [decryptionKey],
        format: 'utf8',
    });
    return data;
}

async function getContentSessionKey(contentKeyPacketBase64, nodeKey) {
    const openpgp = await getOpenpgp();
    const keyPacket = Buffer.from(contentKeyPacketBase64, 'base64');
    const message = await openpgp.readMessage({ binaryMessage: keyPacket });
    const sessionKeys = await openpgp.decryptSessionKeys({
        message,
        decryptionKeys: [nodeKey],
    });
    if (!sessionKeys || sessionKeys.length === 0) {
        throw new Error('Failed to decrypt content session key');
    }
    return sessionKeys[0];
}

async function decryptFileName(encryptedName, nodeKey) {
    try {
        return await decryptWithKey(encryptedName, nodeKey);
    } catch {
        return null;
    }
}

// ─── File Download & Decryption ───────────────────────────────────────────────

async function downloadAndDecryptFile(token, link, sessionKey, auth) {
    const openpgp = await getOpenpgp();
    const linkID = link.LinkID;

    const blocksResp = await protonGet(`/drive/urls/${token}/files/${linkID}`, auth);
    const blocks = blocksResp.Blocks || blocksResp.RevisionBlocks || [];

    if (blocks.length === 0) throw new Error('No file blocks found');

    blocks.sort((a, b) => (a.Index || 0) - (b.Index || 0));

    const decryptedParts = [];
    for (const block of blocks) {
        const blockUrl = block.BareURL || block.URL;
        const storageToken = block.Token;

        const headers = {};
        if (storageToken) headers['pm-storage-token'] = storageToken;

        const blockResp = await fetch(blockUrl, { headers });
        if (!blockResp.ok) {
            throw new Error(`Block download failed: ${blockResp.status}`);
        }
        const encryptedData = new Uint8Array(await blockResp.arrayBuffer());

        const message = await openpgp.readMessage({ binaryMessage: encryptedData });
        const { data } = await openpgp.decrypt({
            message,
            sessionKeys: [sessionKey],
            format: 'binary',
        });
        decryptedParts.push(data);
    }

    const totalLen = decryptedParts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of decryptedParts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

async function downloadFromProtonDrive(url) {
    const { token, urlPassword } = parseProtonShareUrl(url);

    const auth = await srpAuthenticate(token, urlPassword);

    const metadata = await protonGet(`/drive/urls/${token}`, auth);

    const shareURLData = metadata.ShareURL || metadata;
    const shareData = {
        SharePassphraseKeyPacket: shareURLData.SharePassphraseKeyPacket,
        SharePassphrase: shareURLData.SharePassphrase,
        SharePasswordSalt: shareURLData.SharePasswordSalt,
    };

    const shareInfo = metadata.Share || {};
    const link = metadata.Link || {};
    const shareKeyArmored = shareInfo.Key;
    const nodeKeyArmored = link.NodeKey;
    const nodePassphraseEncrypted = link.NodePassphrase;
    const contentKeyPacket = link.FileProperties?.ContentKeyPacket || link.ContentKeyPacket;

    if (!shareKeyArmored) throw new Error('Share key not found in metadata');
    if (!nodeKeyArmored) throw new Error('Node key not found in metadata');
    if (!contentKeyPacket) throw new Error('Content key packet not found in metadata');

    const sharePassphrase = await decryptSharePassphrase(shareData, urlPassword);
    const shareKey = await unlockPrivateKey(shareKeyArmored, sharePassphrase);
    const nodePassphrase = await decryptWithKey(nodePassphraseEncrypted, shareKey);
    const nodeKey = await unlockPrivateKey(nodeKeyArmored, nodePassphrase);
    const sessionKey = await getContentSessionKey(contentKeyPacket, nodeKey);

    let fileName = link.Name;
    if (fileName) {
        const decrypted = await decryptFileName(fileName, nodeKey);
        if (decrypted) fileName = decrypted;
    }
    if (!fileName) fileName = 'downloaded_character';

    const fileData = await downloadAndDecryptFile(token, link, sessionKey, auth);

    return { name: fileName, data: fileData };
}

module.exports = { downloadFromProtonDrive, parseProtonShareUrl };
