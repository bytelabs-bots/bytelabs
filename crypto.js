const crypto = require("crypto");

const ALGO = "aes-256-gcm";

function getKey(master) {
    return crypto.createHash("sha256").update(master).digest();
}

function encrypt(text, master) {
    const iv = crypto.randomBytes(12);
    const key = getKey(master);

    const cipher = crypto.createCipheriv(ALGO, key, iv);

    let enc = cipher.update(text, "utf8", "hex");
    enc += cipher.final("hex");

    const tag = cipher.getAuthTag();

    return {
        data: enc,
        iv: iv.toString("hex"),
        tag: tag.toString("hex")
    };
}

function decrypt(payload, master) {
    const key = getKey(master);

    const decipher = crypto.createDecipheriv(
        ALGO,
        key,
        Buffer.from(payload.iv, "hex")
    );

    decipher.setAuthTag(Buffer.from(payload.tag, "hex"));

    let dec = decipher.update(payload.data, "hex", "utf8");
    dec += decipher.final("utf8");

    return dec;
}

module.exports = { encrypt, decrypt };