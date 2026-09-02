import { createHash } from "node:crypto";

/*
 * A-Bogus 的数据布局参考了 xunlu-core 的实现：
 * https://github.com/shixiansi/xunlu-core/blob/8580901e3f985a86cd068eb38d2f31a8e309c181/src/plugins/douyin/utils/a-bogus.cjs
 *
 * MIT License
 * Copyright (c) 2026 时先思
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const RESULT_ALPHABETS = {
  s3: "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
  s4: "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe",
};

export const DEFAULT_DOUYIN_WINDOW_ENV =
  "1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32";

function rc4Encrypt(plaintext, key) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;

  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key.charCodeAt(i % key.length)) % 256;
    [state[i], state[j]] = [state[j], state[i]];
  }

  let i = 0;
  j = 0;
  let result = "";
  for (let index = 0; index < plaintext.length; index += 1) {
    i = (i + 1) % 256;
    j = (j + state[i]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
    const keyIndex = (state[i] + state[j]) % 256;
    result += String.fromCharCode(
      state[keyIndex] ^ plaintext.charCodeAt(index)
    );
  }
  return result;
}

function sm3(input) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return [...createHash("sm3").update(bytes).digest()];
}

function getLongInt(round, input) {
  const offset = round * 3;
  return (
    (input.charCodeAt(offset) << 16) |
    (input.charCodeAt(offset + 1) << 8) |
    input.charCodeAt(offset + 2)
  );
}

function encodeResult(input, alphabetName) {
  const alphabet = RESULT_ALPHABETS[alphabetName];
  if (!alphabet) {
    throw new Error(`未知的 A-Bogus 编码表: ${alphabetName}`);
  }

  const masks = [16515072, 258048, 4032, 63];
  const shifts = [18, 12, 6, 0];
  let result = "";
  let round = 0;
  let longInt = getLongInt(round, input);

  for (let index = 0; index < (input.length / 3) * 4; index += 1) {
    const nextRound = Math.floor(index / 4);
    if (nextRound !== round) {
      round = nextRound;
      longInt = getLongInt(round, input);
    }
    const key = index % 4;
    result += alphabet.charAt((longInt & masks[key]) >> shifts[key]);
  }
  return result;
}

function mixRandom(randomValue, options) {
  return [
    (randomValue & 255 & 170) | (options[0] & 85),
    (randomValue & 255 & 85) | (options[0] & 170),
    ((randomValue >> 8) & 255 & 170) | (options[1] & 85),
    ((randomValue >> 8) & 255 & 85) | (options[1] & 170),
  ];
}

function generateRandomPrefix(random) {
  const bytes = [
    ...mixRandom(random() * 10000, [3, 45]),
    ...mixRandom(random() * 10000, [1, 0]),
    ...mixRandom(random() * 10000, [1, 5]),
  ];
  return String.fromCharCode(...bytes);
}

function buildFingerprintPayload(searchParams, userAgent, windowEnv, now) {
  const suffix = "cus";
  const startTime = now();
  const queryHash = sm3(sm3(searchParams + suffix));
  const suffixHash = sm3(sm3(suffix));
  const uaKey = String.fromCharCode(0.00390625, 1, 14);
  const uaHash = sm3(encodeResult(rc4Encrypt(userAgent, uaKey), "s3"));
  const endTime = now();

  const values = {
    8: 3,
    10: endTime,
    16: startTime,
    18: 44,
    19: [1, 0, 1, 5],
  };
  const args = [0, 1, 14];
  const pageId = 6241;
  const aid = 6383;

  values[20] = (values[16] >> 24) & 255;
  values[21] = (values[16] >> 16) & 255;
  values[22] = (values[16] >> 8) & 255;
  values[23] = values[16] & 255;
  values[24] = (values[16] / 256 ** 4) >> 0;
  values[25] = (values[16] / 256 ** 5) >> 0;
  values[26] = (args[0] >> 24) & 255;
  values[27] = (args[0] >> 16) & 255;
  values[28] = (args[0] >> 8) & 255;
  values[29] = args[0] & 255;
  values[30] = (args[1] / 256) & 255;
  values[31] = (args[1] % 256) & 255;
  values[32] = (args[1] >> 24) & 255;
  values[33] = (args[1] >> 16) & 255;
  values[34] = (args[2] >> 24) & 255;
  values[35] = (args[2] >> 16) & 255;
  values[36] = (args[2] >> 8) & 255;
  values[37] = args[2] & 255;
  values[38] = queryHash[21];
  values[39] = queryHash[22];
  values[40] = suffixHash[21];
  values[41] = suffixHash[22];
  values[42] = uaHash[23];
  values[43] = uaHash[24];
  values[44] = (values[10] >> 24) & 255;
  values[45] = (values[10] >> 16) & 255;
  values[46] = (values[10] >> 8) & 255;
  values[47] = values[10] & 255;
  values[48] = values[8];
  values[49] = (values[10] / 256 ** 4) >> 0;
  values[50] = (values[10] / 256 ** 5) >> 0;
  values[52] = (pageId >> 24) & 255;
  values[53] = (pageId >> 16) & 255;
  values[54] = (pageId >> 8) & 255;
  values[55] = pageId & 255;
  values[57] = aid & 255;
  values[58] = (aid >> 8) & 255;
  values[59] = (aid >> 16) & 255;
  values[60] = (aid >> 24) & 255;

  const windowBytes = [...windowEnv].map((character) => character.charCodeAt(0));
  values[65] = windowBytes.length & 255;
  values[66] = (windowBytes.length >> 8) & 255;
  values[70] = 0;
  values[71] = 0;

  const checksumFields = [
    18, 20, 26, 30, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32,
    36, 23, 29, 33, 37, 44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55,
    57, 58, 59, 60, 65, 66, 70, 71,
  ];
  const checksum = checksumFields.reduce(
    (value, field) => value ^ (values[field] || 0),
    0
  );

  const payloadFields = [
    18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57,
    39, 41, 43, 22, 28, 32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48,
    49, 50, 24, 25, 65, 66, 70, 71,
  ];
  const payload = payloadFields.map((field) => values[field] || 0);
  payload.push(...windowBytes, checksum);

  return rc4Encrypt(String.fromCharCode(...payload), String.fromCharCode(121));
}

export function generateABogus(
  searchParams,
  userAgent,
  {
    windowEnv = DEFAULT_DOUYIN_WINDOW_ENV,
    now = Date.now,
    random = Math.random,
  } = {}
) {
  const prefix = generateRandomPrefix(random);
  const payload = buildFingerprintPayload(
    String(searchParams || ""),
    String(userAgent || ""),
    String(windowEnv || DEFAULT_DOUYIN_WINDOW_ENV),
    now
  );
  return `${encodeResult(prefix + payload, "s4")}=`;
}
