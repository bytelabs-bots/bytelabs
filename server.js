const http = require("http");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Writable, PassThrough } = require("stream");
const { spawnSync } = require("child_process");
const rateLimit = require("express-rate-limit");
const { WebSocketServer } = require("ws");
require("dotenv").config();
const { encrypt, decrypt } = require("./crypto");
const speakeasy = require("speakeasy");
const { Client } = require("discord.js-selfbot-v13");
const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioResource,
    createAudioPlayer,
    StreamType,
    EndBehaviorType,
    VoiceConnectionStatus
} = require("@discordjs/voice");
const prism = require("prism-media");
let mic = null;
let Speaker = null;

const HEADLESS_ENV = Boolean(process.env.RENDER || process.env.DISABLE_VOICE === "true" || process.env.DISABLE_LOCAL_AUDIO === "true");

function requireMic() {
    if (mic) return mic;
    try {
        mic = require("mic");
    } catch (error) {
        console.warn(`[voice] mic module unavailable: ${error?.message || error}`);
        mic = null;
    }
    return mic;
}

function requireSpeaker() {
    if (Speaker) return Speaker;
    try {
        Speaker = require("speaker");
    } catch (error) {
        console.warn(`[voice] speaker module unavailable: ${error?.message || error}`);
        Speaker = null;
    }
    return Speaker;
}

function canUseLocalAudio() {
    if (process.env.ENABLE_LOCAL_AUDIO === "true") return true;
    if (process.env.DISABLE_LOCAL_AUDIO === "true") return false;
    return fs.existsSync("/dev/snd") || fs.existsSync("/dev/dsp");
}

function canUseArecord() {
    if (process.platform !== "linux") return false;
    const result = spawnSync("command", ["-v", "arecord"], { stdio: "ignore" });
    return result.status === 0;
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const RAW_FILE = process.env.VAULT_FILE || "./vault.json";
const RAW_VAULTS_DIR = process.env.VAULTS_DIR || "./vaults";
const SAFE_DATA_ROOT = path.resolve(__dirname);
const CANONICAL_SAFE_DATA_ROOT = fs.realpathSync(SAFE_DATA_ROOT);
const RESOLVED_FILE = path.resolve(CANONICAL_SAFE_DATA_ROOT, RAW_FILE);
const fileCandidateRelative = path.relative(CANONICAL_SAFE_DATA_ROOT, RESOLVED_FILE);
if (fileCandidateRelative.startsWith("..") || path.isAbsolute(fileCandidateRelative)) {
    throw new Error("Invalid VAULT_FILE path: must stay within application directory");
}
const FILE = RESOLVED_FILE;
const RAW_SUPPORT_FILE = process.env.SUPPORT_TICKETS_FILE || "./support-tickets.json";
const RESOLVED_SUPPORT_FILE = path.resolve(CANONICAL_SAFE_DATA_ROOT, RAW_SUPPORT_FILE);
const supportCandidateRelative = path.relative(CANONICAL_SAFE_DATA_ROOT, RESOLVED_SUPPORT_FILE);
if (supportCandidateRelative.startsWith("..") || path.isAbsolute(supportCandidateRelative)) {
    throw new Error("Invalid SUPPORT_TICKETS_FILE path: must stay within application directory");
}
const SUPPORT_PARENT_DIR = path.dirname(RESOLVED_SUPPORT_FILE);
const CANONICAL_SUPPORT_PARENT_DIR = fs.existsSync(SUPPORT_PARENT_DIR)
    ? fs.realpathSync(SUPPORT_PARENT_DIR)
    : SUPPORT_PARENT_DIR;
const SUPPORT_FILE = path.join(CANONICAL_SUPPORT_PARENT_DIR, path.basename(RESOLVED_SUPPORT_FILE));
const supportRelativePath = path.relative(CANONICAL_SAFE_DATA_ROOT, SUPPORT_FILE);
if (supportRelativePath.startsWith("..") || path.isAbsolute(supportRelativePath)) {
    throw new Error("Invalid SUPPORT_TICKETS_FILE path: must stay within application directory");
}
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const GITHUB_REPOSITORY = (process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO || "").trim();
const GITHUB_BRANCH = (process.env.GITHUB_BRANCH || "main").trim();
const GITHUB_SUPPORT_TICKETS_PATH = (process.env.GITHUB_SUPPORT_TICKETS_PATH || "support-tickets.json").trim();
const GITHUB_ENABLED = Boolean(GITHUB_TOKEN && GITHUB_REPOSITORY);
const DISCORD_SHARD_COUNT = Math.max(1, Number.parseInt(process.env.DISCORD_SHARD_COUNT || "24", 10));
const DISCORD_SHARD_SIZE = Math.max(1, Number.parseInt(process.env.DISCORD_SHARD_SIZE || "16", 10));
const DISCORD_DEFAULT_SHARD_ID = Math.min(Math.max(1, Number.parseInt(process.env.DISCORD_DEFAULT_SHARD_ID || "1", 10)), DISCORD_SHARD_COUNT);
const discordClients = new Map();
const discordVoiceConnections = new Map();
const voiceAudioSessions = new Map();
const discordShards = new Map();
const oneYear = 365 * 24 * 60 * 60 * 1000;
const browserVoiceSockets = new Map(); // Map(sessionKey => Set(ws))
const adminSessions = new Map();

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => {
    res.status(200).json({
        ok: true,
        status: "ok",
        service: "bytelabs",
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// 🔒 Rate limiting middleware
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 requests per 15 minutes
    message: { error: "Too many requests, please try again later" },
    standardHeaders: true,
    legacyHeaders: false
});

const moderateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // 30 requests per 15 minutes
    message: { error: "Too many requests, please try again later" },
    standardHeaders: true,
    legacyHeaders: false
});

const generalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: { error: "Too many requests, please try again later" },
    standardHeaders: true,
    legacyHeaders: false
});

app.use(express.static("public", {
    maxAge: oneYear,
    immutable: true,
    setHeaders: (res, path) => {
        const pathname = path.toLowerCase();

        if (pathname.endsWith("/sw.js") || pathname.endsWith("\\sw.js")) {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
            return;
        }

        if (pathname === "/" || pathname.endsWith(".html")) {
            res.setHeader("Cache-Control", "no-cache");
            return;
        }

        if (/\.(css|js|png|jpe?g|gif|svg|webp|ico|json|webmanifest)$/.test(pathname)) {
            res.setHeader("Cache-Control", `public, max-age=${oneYear / 1000}, immutable`);
        }
    }
}));

// Determine vault file path for a given username. If no username provided,
// fall back to the single-file `FILE` for backwards compatibility.
const RESOLVED_VAULTS_DIR = path.resolve(CANONICAL_SAFE_DATA_ROOT, RAW_VAULTS_DIR);

app.get("/shards", (req, res) => {
    res.json({ success: true, shards: listShardMetadata() });
});
const vaultsDirCandidateRelative = path.relative(CANONICAL_SAFE_DATA_ROOT, RESOLVED_VAULTS_DIR);
if (vaultsDirCandidateRelative.startsWith("..") || path.isAbsolute(vaultsDirCandidateRelative)) {
    throw new Error("Invalid VAULTS_DIR path: must stay within application directory");
}
try {
    if (!fs.existsSync(RESOLVED_VAULTS_DIR)) fs.mkdirSync(RESOLVED_VAULTS_DIR, { recursive: true });
} catch (e) {
    // ignore — directory creation best-effort
}

function shardFolderName(shardId) {
    return shardId === 0 ? "shard0" : `shard${shardId}`;
}

function vaultFileForUsername(username, shardId) {
    if (!username) return FILE;
    // only allow safe username characters to avoid traversal
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
        throw new Error("Invalid vault username");
    }
    const shardDir = shardId === undefined || shardId === null ? "default" : shardFolderName(Number(shardId));
    const candidate = path.resolve(RESOLVED_VAULTS_DIR, shardDir, username, "vault.json");
    const rel = path.relative(CANONICAL_SAFE_DATA_ROOT, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error("Invalid vault username path");
    }
    return candidate;
}

function getShardHost(shardId) {
    if (!Number.isInteger(shardId)) return "https://byte-labs-bots.onrender.com";
    if (shardId === 0) return "https://byte-labs-bots.onrender.com";
    return `https://byte-labs-bots-shard${shardId}.onrender.com`;
}

function listShardMetadata() {
    const shards = [];
    for (let shardId = 1; shardId <= DISCORD_SHARD_COUNT; shardId += 1) {
        shards.push({
            id: shardId,
            name: shardFolderName(shardId),
            host: getShardHost(shardId)
        });
    }
    return shards;
}

function resolveShardIdFromRequest(req) {
    const raw = (req.body && (req.body.shardId ?? req.body.shard ?? req.body.shard_id)) ?? (req.query && (req.query.shardId ?? req.query.shard ?? req.query.shard_id));
    if (raw === undefined || raw === null || raw === "") return DISCORD_DEFAULT_SHARD_ID;
    const normalized = Number(raw);
    if (!Number.isInteger(normalized)) return DISCORD_DEFAULT_SHARD_ID;
    const shardId = normalized;
    if (shardId < 1 || shardId > DISCORD_SHARD_COUNT) return DISCORD_DEFAULT_SHARD_ID;
    return shardId;
}

function findExistingVaultUsername(username, excludeShardId) {
    if (!username) return null;
    for (let shardId = 1; shardId <= DISCORD_SHARD_COUNT; shardId += 1) {
        if (shardId === excludeShardId) continue;
        const target = vaultFileForUsername(username, shardId);
        if (fs.existsSync(target)) return shardId;
        if (GITHUB_ENABLED) {
            try {
                const remote = githubReadFile(target);
                if (remote !== null) {
                    return shardId;
                }
            } catch {
                // ignore
            }
        }
    }
    return null;
}

function githubRemotePathFor(targetPath) {
    const rel = path.relative(CANONICAL_SAFE_DATA_ROOT, targetPath);
    return rel.split(path.sep).join("/");
}

function githubApiRequest(method, pathName, body) {
    if (!GITHUB_ENABLED) return null;

    const args = [
        "-sS",
        "-L",
        "-X",
        method,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `Authorization: Bearer ${GITHUB_TOKEN}`,
        "-H",
        "X-GitHub-Api-Version: 2022-11-28"
    ];

    if (body) {
        args.push("-H", "Content-Type: application/json");
        args.push("--data-binary", JSON.stringify(body));
    }

    args.push(`https://api.github.com${pathName}`);
    const result = spawnSync("curl", args, { encoding: "utf8" });

    if (result.error) {
        throw result.error;
    }

    if (!result.stdout) {
        return null;
    }

    try {
        return JSON.parse(result.stdout);
    } catch {
        return result.stdout;
    }
}

function githubReadFile(targetPath) {
    if (!GITHUB_ENABLED) return null;

    const remotePath = githubRemotePathFor(targetPath);
    const data = githubApiRequest("GET", `/repos/${GITHUB_REPOSITORY}/contents/${encodeURIComponent(remotePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);

    if (!data || data.message === "Not Found") {
        return null;
    }

    if (typeof data === "string") {
        return data;
    }

    if (data.content) {
        return Buffer.from(data.content, "base64").toString("utf8");
    }

    return null;
}

function githubWriteFile(targetPath, contents) {
    if (!GITHUB_ENABLED) return false;

    const remotePath = githubRemotePathFor(targetPath);
    const existing = githubReadFile(targetPath);
    const payload = {
        message: existing === null ? `Create ${remotePath}` : `Update ${remotePath}`,
        content: Buffer.from(contents, "utf8").toString("base64"),
        branch: GITHUB_BRANCH
    };

    const data = githubApiRequest("PUT", `/repos/${GITHUB_REPOSITORY}/contents/${encodeURIComponent(remotePath)}`, payload);
    return Boolean(data && !data.message);
}

function load(username, shardId) {
    const target = vaultFileForUsername(username, shardId);
    if (GITHUB_ENABLED) {
        try {
            const remote = githubReadFile(target);
            if (remote !== null) {
                return JSON.parse(remote);
            }
        } catch {
            // fall back to local file if GitHub content cannot be read
        }
    }

    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, "utf8"));
}

function save(data, username, shardId) {
    const target = vaultFileForUsername(username, shardId);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (GITHUB_ENABLED) {
        const contents = JSON.stringify(data, null, 2);
        const wrote = githubWriteFile(target, contents);
        if (wrote) {
            fs.writeFileSync(target, contents);
            return;
        }
    }

    fs.writeFileSync(target, JSON.stringify(data, null, 2));
}

function loadSupportTickets() {
    if (GITHUB_ENABLED) {
        try {
            const remote = githubReadFile(path.resolve(CANONICAL_SAFE_DATA_ROOT, GITHUB_SUPPORT_TICKETS_PATH));
            if (remote !== null) {
                const parsed = JSON.parse(remote);
                return Array.isArray(parsed) ? parsed : [];
            }
        } catch {
            // fall back to local file if GitHub content cannot be read
        }
    }

    if (!fs.existsSync(SUPPORT_FILE)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(SUPPORT_FILE, "utf8"));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveSupportTickets(tickets) {
    const payload = JSON.stringify(tickets, null, 2);
    if (GITHUB_ENABLED) {
        const wrote = githubWriteFile(path.resolve(CANONICAL_SAFE_DATA_ROOT, GITHUB_SUPPORT_TICKETS_PATH), payload);
        if (wrote) {
            fs.writeFileSync(SUPPORT_FILE, payload);
            return;
        }
    }
    fs.writeFileSync(SUPPORT_FILE, payload);
}

function parseCookies(req) {
    const cookieHeader = req.headers.cookie || "";
    return cookieHeader.split(";").reduce((acc, pair) => {
        const [key, ...rest] = pair.split("=");
        if (!key) return acc;
        acc[key.trim()] = decodeURIComponent(rest.join("=")).trim();
        return acc;
    }, {});
}

function createAdminSession() {
    return crypto.randomBytes(24).toString("hex");
}

function requireAdmin(req, res, next) {
    const cookies = parseCookies(req);
    const sessionId = cookies.admin_session;

    if (!sessionId) {
        return res.redirect("/admin/login");
    }

    const session = adminSessions.get(sessionId);
    if (!session || Date.now() > session.expiresAt) {
        adminSessions.delete(sessionId);
        return res.redirect("/admin/login");
    }

    req.admin = session;
    next();
}

// 🔐 Generate live TOTP code
function getTOTP(secret) {
    try {
        return speakeasy.totp({
            secret,
            encoding: "base32",
            digits: 6,
            step: 30
        });
    } catch {
        return "------";
    }
}

function getShardId(index) {
    if (!Number.isInteger(index) || index < 0) return DISCORD_DEFAULT_SHARD_ID;
    if (DISCORD_SHARD_COUNT <= 1) return DISCORD_DEFAULT_SHARD_ID;
    return 1 + (Math.floor(index / DISCORD_SHARD_SIZE) % DISCORD_SHARD_COUNT);
}

function getDiscordClientKey(index) {
    const shardId = getShardId(index);
    return `discord:${shardId}:${index}`;
}

function getVoiceConnectionKey(index, guildId) {
    const shardId = getShardId(index);
    return `voice:${shardId}:${index}:${guildId}`;
}

function registerShardAccount(index) {
    const shardId = getShardId(index);
    if (!discordShards.has(shardId)) {
        discordShards.set(shardId, new Set());
    }
    discordShards.get(shardId).add(index);
}

function unregisterShardAccount(index) {
    const shardId = getShardId(index);
    const accounts = discordShards.get(shardId);
    if (!accounts) return;
    accounts.delete(index);
    if (accounts.size === 0) {
        discordShards.delete(shardId);
    }
}

async function disconnectDiscordClient(index) {
    const key = getDiscordClientKey(index);
    const connection = discordClients.get(key);

    if (connection?.client) {
        try {
            await connection.client.destroy();
        } catch {
            // ignore cleanup errors
        }
    }

    const shardId = getShardId(index);

    for (const voiceKey of [...voiceAudioSessions.keys()]) {
        if (voiceKey.startsWith(`voice:${shardId}:${index}:`)) {
            cleanupVoiceSession(voiceKey);
        }
    }

    for (const voiceKey of [...discordVoiceConnections.keys()]) {
        if (voiceKey.startsWith(`voice:${shardId}:${index}:`)) {
            const voiceConnection = discordVoiceConnections.get(voiceKey);
            try {
                voiceConnection?.destroy();
            } catch {
                // ignore cleanup errors
            }
            discordVoiceConnections.delete(voiceKey);
        }
    }

    discordClients.delete(key);
    unregisterShardAccount(index);
}

function createNullWritable() {
    return new Writable({
        write(chunk, encoding, callback) {
            callback();
        }
    });
}

function attachBrowserVoiceSession(sessionKey) {
    const wsSet = browserVoiceSockets.get(sessionKey);
    const session = voiceAudioSessions.get(sessionKey);
    if (!wsSet || !session) return;

    session.browserSockets = wsSet;
    session.browserInputActive = wsSet.size > 0;
}

function handleBrowserVoiceMessage(sessionKey, ws, data) {
    const session = voiceAudioSessions.get(sessionKey);
    if (!session) return;

    if (typeof data === "string") {
        let message;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }
        if (message?.type === "ping") {
            try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
        }
        return;
    }

    // binary data from browser (expected PCM S16LE stereo 48k)
    if (!session.voiceInput) {
        // no voice input available (maybe session not ready)
        return;
    }

    if (session.browserInputActive) {
        try {
            const buf = Buffer.from(data);
            session.voiceInput.write(buf);
            console.log(`[voice] wrote ${buf.length} bytes from browser to voiceInput for ${sessionKey}`);
        } catch (error) {
            console.warn(`[voice] failed to write browser audio data: ${error?.message || error}`);
        }
    }
}

function cleanupVoiceSession(sessionKey) {
    const session = voiceAudioSessions.get(sessionKey);
    if (!session) return;

    try {
        session.micInstance?.stop();
    } catch {
        // ignore microphone shutdown failures
    }

    try {
        session.player?.stop();
    } catch {
        // ignore stop errors
    }

    try {
        session.browserEncoder?.destroy();
    } catch {
        // ignore browser encoder cleanup failures
    }

    if (session.browserSockets) {
        for (const bws of session.browserSockets) {
            try { bws.close(); } catch {}
        }
    }

    // remove entry from browserVoiceSockets map
    browserVoiceSockets.delete(sessionKey);

    session.speakers?.forEach(speaker => {
        try {
            speaker.end();
        } catch {
            // ignore speaker errors
        }
    });

    session.subscriptions?.forEach(sub => {
        try {
            sub.destroy();
        } catch {
            // ignore subscription cleanup
        }
    });

    voiceAudioSessions.delete(sessionKey);
}

function startVoiceAudioSession(index, guildId, connection) {
    const sessionKey = getVoiceConnectionKey(index, guildId);
    if (voiceAudioSessions.has(sessionKey)) {
        return voiceAudioSessions.get(sessionKey);
    }

    const player = createAudioPlayer();
    connection.subscribe(player);
    const voiceInput = new PassThrough();
    const resource = createAudioResource(voiceInput, {
        inputType: StreamType.Raw,
        inlineVolume: false
    });
    player.play(resource);

    if (HEADLESS_ENV) {
        const safeSessionKey = String(sessionKey).replace(/[\r\n]/g, "");
        console.warn(`[voice] server running in headless mode; disabling local mic/speaker but accepting browser audio for ${safeSessionKey}`);
        const session = {
            connection,
            player,
            micInstance: null,
            micAvailable: false,
            // keep the voiceInput PassThrough so browser audio can be forwarded into the voice connection
            voiceInput,
            browserInputActive: false,
            browserSocket: null,
            subscriptions: new Map(),
            speakers: new Map(),
            headless: true
        };

        voiceAudioSessions.set(sessionKey, session);
        // attach any existing browser socket so incoming browser audio is accepted
        attachBrowserVoiceSession(sessionKey);
        return session;
    }

    let micInstance = null;
    let micAvailable = false;
    let micInputStream = null;
    const micModule = requireMic();
    const hasArecord = canUseArecord();
    const hasLocalAudio = canUseLocalAudio();
    let browserInputActive = false;

    if (micModule && hasArecord) {
        try {
            micInstance = micModule({
                rate: '48000',
                channels: '2',
                bitwidth: '16',
                encoding: 'signed-integer',
                endian: 'little',
                device: 'default',
                debug: false
            });

            micInputStream = micInstance.getAudioStream();
            micInputStream.on('error', err => {
                micAvailable = false;
                console.warn(`[voice] microphone stream error: ${err?.message || err}`);
            });

            micInputStream.on('data', chunk => {
                if (!browserInputActive) {
                    voiceInput.write(chunk);
                }
            });

            micInstance.start();
            micAvailable = true;
        } catch (error) {
            micAvailable = false;
            micInstance = null;
            micInputStream = null;
            console.warn(`[voice] microphone unavailable: ${error?.message || error}`);
        }
    } else if (micModule && !hasArecord) {
        console.warn("[voice] microphone disabled: 'arecord' is not installed or not available on PATH");
    } else {
        console.warn("[voice] microphone support disabled: 'mic' module not available");
    }

    const enableLocalSpeaker = hasLocalAudio && requireSpeaker();
    if (!enableLocalSpeaker) {
        console.warn("[voice] local audio playback disabled because no local audio device is available");
    }

    const subscriptions = new Map();
    const speakers = new Map();

    const receiver = connection.receiver;
    receiver.speaking.on('start', userId => {
        if (userId === connection.joinConfig.selfDeaf) return;
        if (subscriptions.has(userId)) return;

        const audioStream = receiver.subscribe(userId, {
            mode: 'opus',
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 200
            }
        });

            const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2 });
            const session = voiceAudioSessions.get(sessionKey);
            let speakerInstance = null;
            let destination = createNullWritable();
            const SpeakerClass = requireSpeaker();

            decoder.on('data', chunk => {
                // broadcast PCM chunk to all connected browser sockets for this session
                if (session?.browserSockets && session.browserSockets.size > 0) {
                    for (const bws of session.browserSockets) {
                        try {
                            if (bws.readyState === 1) bws.send(chunk);
                        } catch (error) {
                            console.warn(`[voice] failed to send remote audio to browser: ${error?.message || error}`);
                        }
                    }
                    const safeSessionKey = String(sessionKey).replace(/[\r\n]/g, "");
                    console.log(`[voice] forwarded ${chunk.length || chunk.byteLength} bytes of remote audio to ${session.browserSockets.size} browser(s) for ${safeSessionKey}`);
                }
            });

        if (enableLocalSpeaker && SpeakerClass) {
            try {
                speakerInstance = new SpeakerClass({ channels: 2, bitDepth: 16, sampleRate: 48000 });
                destination = speakerInstance;
            } catch (error) {
                console.warn(`[voice] speaker unavailable for user ${userId}: ${error?.message || error}`);
            }
        } else {
            console.warn("[voice] local audio playback disabled for this environment");
        }

        audioStream.pipe(decoder).pipe(destination);
        subscriptions.set(userId, audioStream);
        speakers.set(userId, speakerInstance);

        audioStream.on('end', () => {
            try {
                speakers.get(userId)?.end();
            } catch {
                // ignore speaker shutdown errors
            }
            subscriptions.delete(userId);
            speakers.delete(userId);
        });

        audioStream.on('error', () => {
            try {
                speakers.get(userId)?.end();
            } catch {
                // ignore speaker shutdown errors
            }
            subscriptions.delete(userId);
            speakers.delete(userId);
        });
    });

    const session = {
        connection,
        player,
        micInstance,
        micAvailable,
        voiceInput,
        browserInputActive,
        browserSockets: new Set(),
        subscriptions,
        speakers
    };

    voiceAudioSessions.set(sessionKey, session);
    attachBrowserVoiceSession(sessionKey);
    return session;
}

async function solveCaptcha(captcha, userAgent) {
    console.warn("Discord captcha challenge encountered:", {
        sitekey: captcha.captcha_sitekey,
        rqtoken: captcha.captcha_rqtoken,
        captcha_key: captcha.captcha_key,
    });

    throw new Error(
        "Discord returned a captcha challenge while joining an invite. " +
        "This app does not automatically solve captchas. Try a different invite or add external captcha support."
    );
}

async function connectDiscordClient(index, token) {
    await disconnectDiscordClient(index);

    const client = new Client({ checkUpdate: false, captchaSolver: solveCaptcha });

    client.on("ready", () => {
        console.log(`[discord] ${client.user?.username || "unknown"} is ready`);
    });

    client.on("messageCreate", message => {
        if (message.content === "ping") {
            message.reply("pong");
        }
    });

    await client.login(token);

    const key = getDiscordClientKey(index);
    const shardId = getShardId(index);
    discordClients.set(key, {
        client,
        username: client.user?.username || null,
        userId: client.user?.id || null,
        shardId
    });
    registerShardAccount(index);

    return {
        connected: true,
        username: client.user?.username || null,
        userId: client.user?.id || null,
        shardId
    };
}

// Apply general limiter to all Discord routes
app.use("/discord", generalLimiter);

app.post("/discord/shards", async (req, res) => {
    const shardList = Array.from(discordShards.entries()).map(([shardId, accounts]) => ({
        shardId: Number(shardId),
        accountCount: accounts.size,
        indices: Array.from(accounts).sort((a, b) => a - b)
    }));

    res.json({ success: true, shards: shardList, availableShards: listShardMetadata() });
});

app.post("/discord/accounts", async (req, res) => {
    const { master } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        const vault = JSON.parse(decrypt(file.vault, master));
        const accounts = vault
            .map((entry, index) => {
                const key = getDiscordClientKey(index);
                const active = discordClients.get(key);

                return {
                    index,
                    username: entry.username || "",
                    email: entry.email || "",
                    tokenPresent: Boolean((entry.token || "").trim()),
                    connected: Boolean(active),
                    connectedUsername: active?.username || null,
                    connectedUserId: active?.userId || null,
                    shardId: getShardId(index)
                };
            })
            .filter(entry => entry.tokenPresent);

        res.json({ accounts });
    } catch {
        res.json({ error: "Wrong master password" });
    }
});

app.post("/discord/connect", async (req, res) => {
    const { master, index } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    let vault;

    try {
        vault = JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    if (!vault[index]) {
        return res.json({ error: "Account not found" });
    }

    const token = typeof vault[index].token === "string" ? vault[index].token.trim() : "";

    if (!token) {
        return res.json({ error: "No Discord token stored for this account" });
    }

    try {
        const status = await connectDiscordClient(index, token);
        res.json({ success: true, ...status });
    } catch (error) {
        res.json({ error: error.message || "Unable to connect Discord account" });
    }
});

app.post("/discord/panel", async (req, res) => {
    const { master, index } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    let vault;

    try {
        vault = JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    if (!vault[index]) {
        return res.json({ error: "Account not found" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));

    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    res.json({
        success: true,
        username: connection.username || null,
        userId: connection.userId || null,
        panelUrl: "/discord-account-manager/panel?index=" + index
    });
});

app.post("/discord/server/join", async (req, res) => {
    const { master, index, invite } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        await connection.client.acceptInvite(invite);
        res.json({ success: true });
    } catch (error) {
        const msg = (error && error.message) ? String(error.message) : "";

        if (/captcha|challenge/i.test(msg)) {
            return res.json({
                error: 'captcha',
                message: 'Discord returned a captcha challenge while joining an invite. This app does not automatically solve captchas. Please open the invite in a browser to solve the captcha manually.',
                invite: invite
            });
        }

        res.json({ error: error.message || "Unable to join server" });
    }
});

app.post("/discord/server/create", async (req, res) => {
    const { master, index, serverName } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof serverName !== "string" || !serverName.trim()) {
        return res.json({ error: "Server name is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = await connection.client.guilds.create(serverName.trim());
        res.json({ success: true, guildId: guild.id, guildName: guild.name });
    } catch (error) {
        res.json({ error: error.message || "Unable to create server" });
    }
});

app.post("/discord/server/leave", async (req, res) => {
    const { master, index, guildId } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        await connection.client.guilds.fetch(guildId);
        const guild = connection.client.guilds.cache.get(guildId);
        if (!guild) {
            return res.json({ error: "Guild not found in cache" });
        }
        await guild.leave();
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message || "Unable to leave server" });
    }
});

app.post("/discord/dm/list", async (req, res) => {
    const { master, index } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const dmChannels = Array.from(connection.client.channels.cache.values())
            .filter(channel => channel.type === 'DM' && channel.recipient)
            .map(channel => ({
                id: channel.recipient.id,
                username: channel.recipient.username || 'Unknown',
                discriminator: channel.recipient.discriminator || '0000',
                avatar: channel.recipient.avatarURL ? channel.recipient.avatarURL() : null
            }));

        const uniq = Array.from(new Map(dmChannels.map(dm => [dm.id, dm])).values());
        res.json({ success: true, dms: uniq });
    } catch (error) {
        res.json({ error: error.message || "Unable to list direct messages" });
    }
});

app.post("/discord/dm/send", async (req, res) => {
    const { master, index, userId, content } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof userId !== "string" || !userId.trim()) {
        return res.json({ error: "User ID is required" });
    }

    if (typeof content !== "string" || !content.trim()) {
        return res.json({ error: "Message content is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const targetUser = await connection.client.users.fetch(userId.trim());
        await targetUser.send(content.trim());
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message || "Unable to send DM" });
    }
});

app.post("/discord/dm/messages", async (req, res) => {
    const { master, index, userId, limit = 20 } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof userId !== "string" || !userId.trim()) {
        return res.json({ error: "User ID is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const targetUser = await connection.client.users.fetch(userId.trim());
        const channel = await targetUser.createDM();
        const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const messages = await channel.messages.fetch({ limit: parsedLimit });

        const list = Array.from(messages.values())
            .slice()
            .reverse()
            .map(message => ({
                id: message.id,
                content: message.content || "",
                authorId: message.author?.id || null,
                authorUsername: message.author?.username || null,
                createdTimestamp: message.createdTimestamp || null
            }));

        res.json({ success: true, messages: list });
    } catch (error) {
        res.json({ error: error.message || "Unable to read DM history" });
    }
});

app.post("/discord/friend/requests", async (req, res) => {
    const { master, index } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        await connection.client.relationships.fetch();

        const incoming = await Promise.all(
            Array.from(connection.client.relationships.incomingCache.keys()).map(async (userId) => {
                let user = connection.client.users.cache.get(userId);
                if (!user) {
                    user = await connection.client.users.fetch(userId).catch(() => null);
                }
                return {
                    id: userId,
                    username: user?.username || 'Unknown',
                    discriminator: user?.discriminator || '0000',
                    avatar: user?.avatarURL?.() || null
                };
            })
        );

        const outgoing = await Promise.all(
            Array.from(connection.client.relationships.outgoingCache.keys()).map(async (userId) => {
                let user = connection.client.users.cache.get(userId);
                if (!user) {
                    user = await connection.client.users.fetch(userId).catch(() => null);
                }
                return {
                    id: userId,
                    username: user?.username || 'Unknown',
                    discriminator: user?.discriminator || '0000',
                    avatar: user?.avatarURL?.() || null
                };
            })
        );

        res.json({ success: true, incoming, outgoing });
    } catch (error) {
        res.json({ error: error.message || "Unable to fetch friend requests" });
    }
});

app.post("/discord/friend/add", async (req, res) => {
    const { master, index, userId } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof userId !== "string" || !userId.trim()) {
        return res.json({ error: "User ID is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const trimmed = userId.trim();
        if (/^\d{17,19}$/.test(trimmed)) {
            await connection.client.api.users['@me'].relationships[trimmed].put({
                data: {},
                DiscordContext: { location: 'Add Friend' }
            });
        } else {
            const hashIndex = trimmed.lastIndexOf('#');
            if (hashIndex > 0) {
                const username = trimmed.slice(0, hashIndex);
                const discriminator = trimmed.slice(hashIndex + 1);
                await connection.client.api.users['@me'].relationships.post({
                    versioned: true,
                    data: { username, discriminator },
                    DiscordContext: { location: 'Add Friend' }
                });
            } else {
                // Allow username without discriminator
                const username = trimmed;
                await connection.client.api.users['@me'].relationships.post({
                    versioned: true,
                    data: { username },
                    DiscordContext: { location: 'Add Friend' }
                });
            }
        }

        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message || "Unable to send friend request" });
    }
});

app.post("/discord/friend/accept", async (req, res) => {
    const { master, index, userId } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof userId !== "string" || !userId.trim()) {
        return res.json({ error: "User ID is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        // Accept a pending incoming friend request by user ID.
        await connection.client.api.users['@me'].relationships[userId.trim()].put({
            data: { confirm_stranger_request: true },
            DiscordContext: { location: 'Friends' }
        });
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message || "Unable to accept friend request" });
    }
});

app.post("/discord/friend/decline", async (req, res) => {
    const { master, index, userId } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof userId !== "string" || !userId.trim()) {
        return res.json({ error: "User ID is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        await connection.client.api.users['@me'].relationships[userId.trim()].delete({
            DiscordContext: { location: 'Friends' }
        });
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message || "Unable to decline/cancel friend request" });
    }
});

app.post("/discord/disconnect", async (req, res) => {
    const { master, index } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    await disconnectDiscordClient(index);
    res.json({ success: true });
});

app.post("/discord/guilds", async (req, res) => {
    const { master, index } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guilds = Array.from(connection.client.guilds.cache.values()).map(guild => ({
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL(),
            memberCount: guild.memberCount || 0
        }));

        res.json({ success: true, guilds });
    } catch (error) {
        res.json({ error: error.message || "Unable to fetch guilds" });
    }
});

app.post("/discord/guild/channels", async (req, res) => {
    const { master, index, guildId } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = connection.client.guilds.cache.get(guildId.trim());
        if (!guild) {
            return res.json({ error: "Guild not found" });
        }

        const channels = Array.from(guild.channels.cache.values())
            .filter(channel => channel.viewable)
            .map(channel => ({
                id: channel.id,
                name: channel.name || "unknown",
                type: channel.type || "GUILD_TEXT",
                position: channel.position || 0,
                parentId: channel.parentId || null
            }))
            .sort((a, b) => a.position - b.position);

        res.json({ success: true, channels });
    } catch (error) {
        res.json({ error: error.message || "Unable to fetch channels" });
    }
});

app.post("/discord/guild/members", async (req, res) => {
    const { master, index, guildId, limit = 50 } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = connection.client.guilds.cache.get(guildId.trim());
        if (!guild) {
            return res.json({ error: "Guild not found" });
        }

        const members = Array.from(guild.members.cache.values())
            .slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200))
            .map(member => ({
                id: member.id,
                username: member.user?.username || "unknown",
                nickname: member.nickname || null,
                status: member.presence?.status || "offline",
                avatar: member.user?.avatarURL() || null
            }))
            .sort((a, b) => {
                const statusOrder = { online: 0, idle: 1, dnd: 2, offline: 3 };
                return (statusOrder[a.status] || 3) - (statusOrder[b.status] || 3);
            });

        res.json({ success: true, members });
    } catch (error) {
        res.json({ error: error.message || "Unable to fetch members" });
    }
});

app.post("/discord/guild/channel/messages", async (req, res) => {
    const { master, index, guildId, channelId, limit = 50 } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    if (typeof channelId !== "string" || !channelId.trim()) {
        return res.json({ error: "Channel ID is required" });
    }

    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = connection.client.guilds.cache.get(guildId.trim());
        if (!guild) {
            return res.json({ error: "Guild not found" });
        }

        const channel = guild.channels.cache.get(channelId.trim());
        if (!channel) {
            return res.json({ error: "Channel not found" });
        }

        const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
        const messages = await channel.messages.fetch({ limit: parsedLimit });

        const list = Array.from(messages.values())
            .reverse()
            .map(message => ({
                id: message.id,
                content: message.content || "",
                authorId: message.author?.id || null,
                authorUsername: message.author?.username || null,
                authorAvatar: message.author?.avatarURL() || null,
                createdTimestamp: message.createdTimestamp || null,
                poll: message.poll
                    ? {
                          question: message.poll.question?.text || null,
                          answers: Array.from(message.poll.answers.values()).map(answer => ({
                              id: answer.id,
                              text: answer.text || null,
                              emoji: answer.emoji?.name || null,
                              voteCount: answer.voteCount || 0
                          })),
                          expiresTimestamp: message.poll.expiresTimestamp || null,
                          allowMultiselect: Boolean(message.poll.allowMultiselect),
                          layoutType: message.poll.layoutType || null,
                          resultsFinalized: Boolean(message.poll.resultsFinalized)
                      }
                    : null
            }));

        res.json({ success: true, messages: list });
    } catch (error) {
        res.json({ error: error.message || "Unable to fetch channel messages" });
    }
});

app.post("/discord/guild/channel/send", async (req, res) => {
    const { master, index, guildId, channelId, content } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    if (typeof channelId !== "string" || !channelId.trim()) {
        return res.json({ error: "Channel ID is required" });
    }

    if (typeof content !== "string" || !content.trim()) {
        return res.json({ error: "Message content is required" });
    }

    let file = load(req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = connection.client.guilds.cache.get(guildId.trim());
        if (!guild) {
            return res.json({ error: "Guild not found" });
        }

        const channel = guild.channels.cache.get(channelId.trim());
        if (!channel) {
            return res.json({ error: "Channel not found" });
        }

        await channel.send(content.trim());
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message || "Unable to send message to channel" });
    }
});

app.post("/discord/guild/channel/poll/send", async (req, res) => {
    const { master, index, guildId, channelId, question, answers, duration = 24, allowMultiselect = false } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    if (typeof channelId !== "string" || !channelId.trim()) {
        return res.json({ error: "Channel ID is required" });
    }

    if (typeof question !== "string" || !question.trim()) {
        return res.json({ error: "Poll question is required" });
    }

    if (!Array.isArray(answers) || answers.filter(answer => typeof answer === 'string' && answer.trim()).length < 2) {
        return res.json({ error: "At least two poll answers are required" });
    }

    const parsedDuration = Math.min(Math.max(Number(duration) || 24, 1), 168);

    let file = load(req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = connection.client.guilds.cache.get(guildId.trim());
        if (!guild) {
            return res.json({ error: "Guild not found" });
        }

        const channel = guild.channels.cache.get(channelId.trim());
        if (!channel) {
            return res.json({ error: "Channel not found" });
        }

        const pollAnswers = answers
            .filter(answer => typeof answer === 'string' && answer.trim())
            .map(answer => ({ text: answer.trim() }));

        const message = await channel.send({
            content: question.trim(),
            poll: {
                question: { text: question.trim() },
                answers: pollAnswers,
                duration: parsedDuration,
                allowMultiselect: Boolean(allowMultiselect)
            }
        });

        res.json({ success: true, messageId: message.id });
    } catch (error) {
        res.json({ error: error.message || "Unable to send poll to channel" });
    }
});

app.post("/discord/guild/channel/poll/vote", async (req, res) => {
    const { master, index, guildId, channelId, messageId, answerIds } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    if (typeof channelId !== "string" || !channelId.trim()) {
        return res.json({ error: "Channel ID is required" });
    }

    if (typeof messageId !== "string" || !messageId.trim()) {
        return res.json({ error: "Message ID is required" });
    }

    if (!Array.isArray(answerIds)) {
        return res.json({ error: "Answer IDs are required" });
    }

    let file = load(req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = connection.client.guilds.cache.get(guildId.trim());
        if (!guild) {
            return res.json({ error: "Guild not found" });
        }

        const channel = guild.channels.cache.get(channelId.trim());
        if (!channel) {
            return res.json({ error: "Channel not found" });
        }

        const message = await channel.messages.fetch(messageId.trim());
        if (!message) {
            return res.json({ error: "Poll message not found" });
        }

        await message.vote(...answerIds);
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message || "Unable to vote on poll" });
    }
});

app.post("/discord/guild/voicechannel/info", async (req, res) => {
    const { master, index, guildId, channelId } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    if (typeof channelId !== "string" || !channelId.trim()) {
        return res.json({ error: "Channel ID is required" });
    }

    let file = load(req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = connection.client.guilds.cache.get(guildId.trim());
        if (!guild) {
            return res.json({ error: "Guild not found" });
        }

        const channel = guild.channels.cache.get(channelId.trim());
        if (!channel || channel.type !== 'GUILD_VOICE') {
            return res.json({ error: "Voice channel not found" });
        }

        const members = Array.from(channel.members.values()).map(member => ({
            id: member.id,
            username: member.user?.username || "unknown",
            nickname: member.nickname || null,
            status: member.presence?.status || "offline",
            avatar: member.user?.avatarURL() || null,
            muted: member.voice?.mute || false,
            deafened: member.voice?.deaf || false,
            selfMuted: member.voice?.selfMute || false,
            selfDeafened: member.voice?.selfDeaf || false
        }));

        const voiceConnection = getVoiceConnection(guildId.trim());
        const connected = Boolean(voiceConnection && voiceConnection.joinConfig.channelId === channelId.trim());

        res.json({ 
            success: true, 
            channelName: channel.name,
            channelId: channel.id,
            bitrate: channel.bitrate || 0,
            userLimit: channel.userLimit || 0,
            connected,
            members: members
        });
    } catch (error) {
        res.json({ error: error.message || "Unable to fetch voice channel info" });
    }
});

app.post("/discord/guild/voicechannel/join", async (req, res) => {
    const { master, index, guildId, channelId } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    if (typeof channelId !== "string" || !channelId.trim()) {
        return res.json({ error: "Channel ID is required" });
    }

    let file = load(req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    try {
        const guild = connection.client.guilds.cache.get(guildId.trim());
        if (!guild) {
            return res.json({ error: "Guild not found" });
        }

        const channel = guild.channels.cache.get(channelId.trim());
        if (!channel || channel.type !== 'GUILD_VOICE') {
            return res.json({ error: "Voice channel not found" });
        }

        if (!guild.voiceAdapterCreator) {
            return res.json({ error: "Voice adapter unavailable for this guild" });
        }

        const voiceConnection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        discordVoiceConnections.set(getVoiceConnectionKey(index, guild.id), voiceConnection);
        voiceConnection.on(VoiceConnectionStatus.Ready, () => {
            try {
                startVoiceAudioSession(index, guild.id, voiceConnection);
            } catch (error) {
                console.warn(`[voice] failed to start audio session: ${error?.message || error}`);
            }
        });

        voiceConnection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
            cleanupVoiceSession(getVoiceConnectionKey(index, guild.id));
            discordVoiceConnections.delete(getVoiceConnectionKey(index, guild.id));
        });

        res.json({ success: true, connected: true, guildId: guild.id, channelId: channel.id });
    } catch (error) {
        res.json({ error: error.message || "Unable to join voice channel" });
    }
});

app.post("/discord/guild/voicechannel/leave", async (req, res) => {
    const { master, index, guildId } = req.body;
    const shardId = resolveShardIdFromRequest(req);

    if (typeof index !== "number" || index < 0) {
        return res.json({ error: "Invalid account index" });
    }

    if (typeof guildId !== "string" || !guildId.trim()) {
        return res.json({ error: "Guild ID is required" });
    }

    let file = load(req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    try {
        JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const connection = discordClients.get(getDiscordClientKey(index));
    if (!connection?.client) {
        return res.json({ error: "Account is not connected yet" });
    }

    const voiceKey = getVoiceConnectionKey(index, guildId.trim());
    const voiceConnection = discordVoiceConnections.get(voiceKey) || getVoiceConnection(guildId.trim());

    if (!voiceConnection) {
        return res.json({ error: "No active voice connection found" });
    }

    try {
        voiceConnection.destroy();
        discordVoiceConnections.delete(voiceKey);
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message || "Unable to leave voice channel" });
    }
});

// 🆕 CREATE VAULT
app.post("/create-vault", strictLimiter, (req, res) => {
    const { master, username } = req.body || {};
    const shardId = resolveShardIdFromRequest(req);

    if (typeof master !== "string" || !master.trim()) {
        return res.json({ error: "Master password is required" });
    }

    const vaultUsername = typeof username === "string" ? username.trim() : "";
    if (!vaultUsername) {
        return res.json({ error: "Vault username is required" });
    }

    try {
        const existing = load(vaultUsername, shardId);
        if (existing) {
            return res.json({ error: "Vault already exists for this username on this shard" });
        }

        const conflictingShard = findExistingVaultUsername(vaultUsername, shardId);
        if (conflictingShard !== null) {
            return res.json({
                error: `Vault username already exists on shard ${conflictingShard}. Please go to ${getShardHost(conflictingShard)} and use that shard instead.`,
                shardId: conflictingShard,
                host: getShardHost(conflictingShard)
            });
        }

        const empty = encrypt(JSON.stringify([]), master.trim());
        save({ vault: empty }, vaultUsername, shardId);
        return res.json({ success: true, shardId, host: getShardHost(shardId) });
    } catch (error) {
        return res.json({ error: error.message || "Unable to create vault" });
    }
});

// 📦 GET VAULT (auto-create if missing)
app.post("/get", moderateLimiter, (req, res) => {
    const { master } = req.body;
    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    const shardId = resolveShardIdFromRequest(req);

    let file = load(username, shardId);

    if (!file) {
        const empty = encrypt(JSON.stringify([]), master);
        const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
        save({ vault: empty }, username, shardId);
        return res.json([]);
    }

    try {
        const decrypted = decrypt(file.vault, master);
        const vault = JSON.parse(decrypted);

        // inject live auth code and include index
        const enriched = vault.map((entry, i) => ({
            ...entry,
            index: i,
            authCode: entry.authenticator
                ? getTOTP(entry.authenticator)
                : "------"
        }));

        res.json(enriched);

    } catch {
        res.json({ error: "Wrong master password" });
    }
});

// ➕ ADD ENTRY (user input only)
app.post("/add", strictLimiter, async (req, res) => {
    const { master, entry } = req.body;
    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    const shardId = resolveShardIdFromRequest(req);

    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    let vault;

    try {
        vault = JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    const token = typeof entry?.token === "string" ? entry.token.trim() : "";

    const safeEntry = {
        username: entry.username || "",
        email: entry.email || "",
        password: entry.password || "",
        token,
        authenticator: entry.authenticator || "",
        backupCodes: entry.backupCodes || []
    };

    vault.push(safeEntry);

    const encrypted = encrypt(JSON.stringify(vault), master);
    save({ vault: encrypted }, username, shardId);

    res.json(safeEntry);
});

// ✏️ Update existing entry by index
app.post("/update", strictLimiter, async (req, res) => {
    const { master, index, entry } = req.body;
    const username = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : undefined;
    const shardId = resolveShardIdFromRequest(req);

    let file = load(username, shardId);
    if (!file) return res.json({ error: "Vault missing" });

    let vault;

    try {
        vault = JSON.parse(decrypt(file.vault, master));
    } catch {
        return res.json({ error: "Wrong master password" });
    }

    if (typeof index !== 'number' || index < 0 || index >= vault.length) {
        return res.json({ error: 'Invalid index' });
    }

    const token = typeof entry?.token === "string" ? entry.token.trim() : "";

    const safeEntry = {
        username: entry.username || "",
        email: entry.email || "",
        password: entry.password || "",
        token,
        authenticator: entry.authenticator || "",
        backupCodes: entry.backupCodes || []
    };

    vault[index] = safeEntry;

    const encrypted = encrypt(JSON.stringify(vault), master);
    save({ vault: encrypted }, username, shardId);

    const enriched = {
        ...safeEntry,
        index,
        authCode: safeEntry.authenticator ? getTOTP(safeEntry.authenticator) : "------"
    };

    res.json(enriched);
});

// Support ticket endpoints
app.get("/support/tickets", (req, res) => {
    res.json(loadSupportTickets());
});

app.post("/admin/login", (req, res) => {
    const { username, password } = req.body || {};

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const sessionId = createAdminSession();
        adminSessions.set(sessionId, {
            username: ADMIN_USERNAME,
            expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
        });

        res.setHeader("Set-Cookie", `admin_session=${sessionId}; HttpOnly; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`);
        return res.json({ success: true });
    }

    res.status(401).json({ error: "Invalid admin credentials" });
});

app.post("/admin/logout", (req, res) => {
    const cookies = parseCookies(req);
    const sessionId = cookies.admin_session;
    if (sessionId) adminSessions.delete(sessionId);
    res.setHeader("Set-Cookie", "admin_session=; HttpOnly; Path=/; Max-Age=0");
    res.json({ success: true });
});

app.get("/admin/tickets", requireAdmin, (req, res) => {
    res.json(loadSupportTickets());
});

app.patch("/admin/tickets/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const { status, priority, notes } = req.body || {};

    if (!Number.isInteger(id)) {
        return res.json({ error: "Invalid ticket id" });
    }

    const tickets = loadSupportTickets();
    const ticket = tickets.find(item => item.id === id);

    if (!ticket) {
        return res.json({ error: "Ticket not found" });
    }

    if (status) ticket.status = status;
    if (priority) ticket.priority = priority;
    if (typeof notes === "string") ticket.notes = notes;

    saveSupportTickets(tickets);
    res.json(ticket);
});

app.delete("/admin/tickets/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
        return res.json({ error: "Invalid ticket id" });
    }

    const tickets = loadSupportTickets().filter(item => item.id !== id);
    saveSupportTickets(tickets);
    res.json({ success: true });
});

app.post("/support/tickets", (req, res) => {
    const { name, email, subject, priority, message } = req.body || {};

    if (!subject || !message) {
        return res.json({ error: "Subject and message are required" });
    }

    const tickets = loadSupportTickets();
    const ticket = {
        id: Date.now(),
        name: name || "Anonymous",
        email: email || "",
        subject: subject.trim(),
        priority: priority || "medium",
        message: message.trim(),
        status: "open",
        createdAt: new Date().toISOString()
    };

    tickets.unshift(ticket);
    saveSupportTickets(tickets);
    res.json(ticket);
});

app.patch("/support/tickets/:id", (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body || {};

    if (!Number.isInteger(id)) {
        return res.json({ error: "Invalid ticket id" });
    }

    const tickets = loadSupportTickets();
    const ticket = tickets.find(item => item.id === id);

    if (!ticket) {
        return res.json({ error: "Ticket not found" });
    }

    ticket.status = status || ticket.status || "open";
    saveSupportTickets(tickets);
    res.json(ticket);
});

// Serve panel without .html extension
app.get("/discord-account-manager/panel", (req, res) => {
    res.sendFile(__dirname + "/public/discord-account-manager/panel.html");
});

const adminPageLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});

app.get("/support", adminPageLimiter, (req, res) => {
    res.sendFile(__dirname + "/public/support/index.html");
});

app.get("/admin/login", adminPageLimiter, (req, res) => {
    res.sendFile(__dirname + "/public/admin/login.html");
});

app.get("/admin", requireAdmin, adminPageLimiter, (req, res) => {
    res.sendFile(__dirname + "/public/admin/index.html");
});

// 404 Handler - catch all unmatched routes
app.use((req, res) => {
    res.status(404).sendFile(__dirname + "/public/404.html");
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/voice" });

wss.on("connection", (ws, req) => {
    const params = new URLSearchParams(req.url.split("?")[1] || "");
    const index = params.get("index");
    const guildId = params.get("guildId");

    if (!index || !guildId) {
        ws.close(1008, "Missing index or guildId");
        return;
    }

    const sessionKey = getVoiceConnectionKey(Number(index), guildId);
    ws.binaryType = "arraybuffer";

    // add ws to set for this sessionKey
    let set = browserVoiceSockets.get(sessionKey);
    if (!set) {
        set = new Set();
        browserVoiceSockets.set(sessionKey, set);
    }
    set.add(ws);
    console.log(`[voice][ws] browser websocket connected for ${sessionKey} (total: ${set.size})`);
    attachBrowserVoiceSession(sessionKey);

    ws.on("message", data => handleBrowserVoiceMessage(sessionKey, ws, data));
    ws.on("close", () => {
        const set = browserVoiceSockets.get(sessionKey);
        if (set) {
            set.delete(ws);
            if (set.size === 0) browserVoiceSockets.delete(sessionKey);
            console.log(`[voice][ws] browser websocket disconnected for ${sessionKey} (remaining: ${set.size})`);
        }
        const session = voiceAudioSessions.get(sessionKey);
        if (session) {
            session.browserInputActive = session.browserSockets && session.browserSockets.size > 0;
            // remove ws from session.browserSockets if present
            try { session.browserSockets?.delete(ws); } catch {}
        }
    });
});


server.listen(PORT, () => {
    console.log(`🔐 Server running → http://localhost:${PORT}`);
});