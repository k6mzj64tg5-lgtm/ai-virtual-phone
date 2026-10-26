// lib/music-listen-together.ts — 「一起听」核心模块
// prompt 组装、LLM 调用（点评/切歌决策/聊天即时互动）、弹幕历史、情绪记忆、防复读、出口清洗、会话持久化
// 严守设计不变量：simpleLLMCall 独立调用通道，禁止引入通用预设，称呼零硬编码，80字出口清洗

import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
import { renderUserNameMacro } from "./user-macro";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { ApiConfig } from "./settings-types";
import type { Character } from "./character-types";
import type { MusicTrack } from "./music-storage";

// ── 存储键与常量 ──
const LISTEN_HISTORY_KEY = "music-listen-together-v1";
const LISTEN_MOOD_KEY = "music-listen-together-mood-v1";
const LISTEN_SESSION_KEY = "music-listen-together-session-v1";
const LISTEN_SELECTED_KEY = "music-listen-together-selected-v1";

const MAX_TRACKS_IN_HISTORY = 30;
const MAX_MESSAGES_PER_TRACK = 50;
const MAX_MOOD_ENTRIES = 300;
export const BUBBLE_MAX_CHARS = 80;

registerKvMigration(LISTEN_HISTORY_KEY);
registerKvMigration(LISTEN_MOOD_KEY);
registerKvMigration(LISTEN_SESSION_KEY);
registerKvMigration(LISTEN_SELECTED_KEY);

export interface ListenTogetherMessage {
    id: string;
    characterId: string;
    characterName: string;
    avatar?: string;
    text: string;
    timestamp: number;
    action?: "skip-proposal";
    isUser?: boolean;
}

export interface CharacterTrackMood {
    characterId: string;
    trackId: string;
    listens: number;
    lastComments: string[];
    skipWants: number;
    deniedSkips: number;
    updatedAt: number;
}

export interface ListenTogetherSession {
    active: boolean;
    characterIds: string[];
    intervalMin: number;
    intervalMax: number;
    lastUpdated?: number;
}

// ── 会话持久化 ──
export function loadListenSession(): ListenTogetherSession {
    if (typeof window === "undefined") {
        return { active: false, characterIds: [], intervalMin: 15, intervalMax: 30 };
    }
    try {
        const raw = kvGet(LISTEN_SESSION_KEY);
        if (!raw) return { active: false, characterIds: [], intervalMin: 15, intervalMax: 30 };
        return JSON.parse(raw);
    } catch {
        return { active: false, characterIds: [], intervalMin: 15, intervalMax: 30 };
    }
}

export function saveListenSession(session: ListenTogetherSession): void {
    if (typeof window === "undefined") return;
    kvSet(LISTEN_SESSION_KEY, JSON.stringify(session));
}

// ── 弹幕历史存取（同步操作） ──
type HistoryMap = Record<string, ListenTogetherMessage[]>;

function getHistoryMap(): HistoryMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(LISTEN_HISTORY_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

export function loadListenHistory(trackId: string): ListenTogetherMessage[] {
    const map = getHistoryMap();
    return map[trackId] || [];
}

export function appendListenHistory(trackId: string, msg: ListenTogetherMessage): void {
    if (typeof window === "undefined") return;
    const map = getHistoryMap();
    const list = map[trackId] || [];
    list.push(msg);
    if (list.length > MAX_MESSAGES_PER_TRACK) {
        list.splice(0, list.length - MAX_MESSAGES_PER_TRACK);
    }
    map[trackId] = list;

    // 清理超量歌曲
    const keys = Object.keys(map);
    if (keys.length > MAX_TRACKS_IN_HISTORY) {
        const drop = keys.slice(0, keys.length - MAX_TRACKS_IN_HISTORY);
        for (const k of drop) delete map[k];
    }
    kvSet(LISTEN_HISTORY_KEY, JSON.stringify(map));
}

export function appendUserListenComment(
    trackId: string,
    userName: string,
    text: string
): ListenTogetherMessage {
    const cleanText = text.trim().slice(0, BUBBLE_MAX_CHARS);
    const msg: ListenTogetherMessage = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        characterId: "user",
        characterName: userName,
        text: cleanText,
        timestamp: Date.now(),
        isUser: true,
    };
    appendListenHistory(trackId, msg);
    return msg;
}

// ── 情绪记忆存取 ──
type MoodMap = Record<string, CharacterTrackMood>;

function getMoodMap(): MoodMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(LISTEN_MOOD_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function makeMoodKey(characterId: string, trackId: string): string {
    return `${characterId}:${trackId}`;
}

export function markListenHeard(characterId: string, trackId: string): void {
    if (typeof window === "undefined") return;
    const map = getMoodMap();
    const key = makeMoodKey(characterId, trackId);
    const existing = map[key] || {
        characterId,
        trackId,
        listens: 0,
        lastComments: [],
        skipWants: 0,
        deniedSkips: 0,
        updatedAt: Date.now(),
    };
    existing.listens += 1;
    existing.updatedAt = Date.now();
    map[key] = existing;
    kvSet(LISTEN_MOOD_KEY, JSON.stringify(map));
}

export function recordListenComment(characterId: string, trackId: string, comment: string): void {
    if (typeof window === "undefined") return;
    const map = getMoodMap();
    const key = makeMoodKey(characterId, trackId);
    const existing = map[key] || {
        characterId,
        trackId,
        listens: 1,
        lastComments: [],
        skipWants: 0,
        deniedSkips: 0,
        updatedAt: Date.now(),
    };
    existing.lastComments.push(comment);
    if (existing.lastComments.length > 2) existing.lastComments.shift();
    existing.updatedAt = Date.now();
    map[key] = existing;
    kvSet(LISTEN_MOOD_KEY, JSON.stringify(map));
}

export function markSkipWanted(characterId: string, trackId: string): void {
    if (typeof window === "undefined") return;
    const map = getMoodMap();
    const key = makeMoodKey(characterId, trackId);
    if (!map[key]) return;
    map[key].skipWants += 1;
    map[key].updatedAt = Date.now();
    kvSet(LISTEN_MOOD_KEY, JSON.stringify(map));
}

export function markSkipDenied(characterIds: string[], trackId: string): void {
    if (typeof window === "undefined") return;
    const map = getMoodMap();
    for (const cid of characterIds) {
        const key = makeMoodKey(cid, trackId);
        if (map[key]) {
            map[key].deniedSkips += 1;
            map[key].updatedAt = Date.now();
        }
    }
    kvSet(LISTEN_MOOD_KEY, JSON.stringify(map));
}

export function buildMoodBlock(character: Character, trackId: string): string {
    const map = getMoodMap();
    const key = makeMoodKey(character.id, trackId);
    const mood = map[key];
    if (!mood) return "";

    const lines: string[] = [];
    if (mood.listens > 1) {
        lines.push(`你已经一起听过这首歌 ${mood.listens} 次了。`);
    }
    const lastComment = mood.lastComments[mood.lastComments.length - 1];
    if (lastComment) {
        lines.push(`你上次对它的感受是：「${lastComment}」`);
    }
    if (mood.deniedSkips > 0) {
        lines.push(`你这首歌提过 ${mood.skipWants} 次想切，被拒绝了 ${mood.deniedSkips} 次——这次除非真的忍不了，别再主动提。`);
    }
    if (lines.length === 0) return "";
    return `【你和这首歌的缘分】\n${lines.join("\n")}`;
}

// ── 出口清洗与防复读 ──
export function sanitizeListenText(raw: string | null | undefined): string {
    if (!raw) return "";
    let s = raw.trim();

    // 剥离代码块与标签
    s = s.replace(/```[\s\S]*?```/g, "").replace(/<[^>]+>/g, "");
    // 剥离中文圆括号、英文括号、全角方括号动作描写
    s = s.replace(/（[^）]*）/g, "").replace(/\([^\)]*\)/g, "").replace(/【[^】]*】/g, "");
    s = s.replace(/\*[^*]+\*/g, "");
    // 剥离首尾引号与开头的省略号
    s = s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "");
    s = s.replace(/^[.。…\s]+/, "");

    // 80 字截断到最近句读
    if (s.length > BUBBLE_MAX_CHARS) {
        const sub = s.slice(0, BUBBLE_MAX_CHARS);
        const match = sub.match(/.*[。！？!?~…]/);
        if (match && match[0].length >= 10) {
            s = match[0];
        } else {
            s = sub;
        }
    }
    return s.trim();
}

function normalizeForDuplicate(str: string): string {
    return str
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]/gu, "");
}

export function isListenDuplicate(candidate: string, historyTexts: string[]): boolean {
    const candNorm = normalizeForDuplicate(candidate);
    if (!candNorm) return true;

    for (const h of historyTexts) {
        const hNorm = normalizeForDuplicate(h);
        if (!hNorm) continue;
        // 包含关系检测
        if (candNorm.length >= 4 && (candNorm.includes(hNorm) || hNorm.includes(candNorm))) {
            return true;
        }
        // Bigram Jaccard 相似度
        const setA = new Set<string>();
        for (let i = 0; i < candNorm.length - 1; i++) setA.add(candNorm.slice(i, i + 2));
        const setB = new Set<string>();
        for (let i = 0; i < hNorm.length - 1; i++) setB.add(hNorm.slice(i, i + 2));
        if (setA.size === 0 || setB.size === 0) continue;

        let intersection = 0;
        for (const item of setA) {
            if (setB.has(item)) intersection++;
        }
        const union = setA.size + setB.size - intersection;
        if (union > 0 && intersection / union >= 0.3) {
            return true;
        }
    }
    return false;
}

export function trimPersona(persona: string, maxChars = 1200): string {
    if (!persona || persona.length <= maxChars) return persona || "";
    // 保留"说话风格"类段落
    const styleMatch = persona.match(/(?:说话风格|语气|口吻|语言习惯)[\s\S]{0,400}/);
    const styleSnippet = styleMatch ? styleMatch[0] : "";
    const cut = persona.slice(0, maxChars - (styleSnippet ? styleSnippet.length + 10 : 0));
    return styleSnippet ? `${cut}\n\n【关键语气】\n${styleSnippet}` : cut;
}

function resolveCharacterApiConfig(character: Character): ApiConfig | null {
    const bindingConfig = loadBindingConfig();
    const apiConfigs = loadApiConfigs();
    const resolved = resolveBinding(bindingConfig, character.id, "music");
    if (resolved.apiConfigId) {
        return apiConfigs.find(c => c.id === resolved.apiConfigId) || null;
    }
    return apiConfigs[0] || null;
}

// ── 生成自动点评 ──
export async function generateListenComment(params: {
    track: MusicTrack;
    character: Character;
    allCharacters: Character[];
    userLabel?: string;
}): Promise<string | null> {
    const { track, character, allCharacters, userLabel } = params;

    if (!character.persona && !character.personality) {
        throw new Error(`角色 [${character.name}] persona 与 personality 双空`);
    }

    const apiConfig = resolveCharacterApiConfig(character);
    if (!apiConfig) return null;

    const userIdent = resolveUserIdentity(character.id);
    const finalUser = userLabel || userIdent?.name || "你";

    const relations = formatCharacterRelationsForPrompt(character.id);
    const trimmedP = trimPersona(character.persona || "", 1200);
    const personaText = renderUserNameMacro(trimmedP, finalUser);
    const personalityText = renderUserNameMacro(character.personality || "", finalUser);
    const relationsText = renderUserNameMacro(relations || "", finalUser);

    const rawLyrics = (track.lyrics || "")
        .replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const lyricsExcerpt = rawLyrics.slice(0, 240);

    const moodBlock = buildMoodBlock(character, track.id);
    const history = loadListenHistory(track.id);
    const recentHistory = history.slice(-5);
    const characterRecent = history.filter(h => h.characterId === character.id).slice(-4).map(h => h.text);

    const promptParts: string[] = [];
    promptParts.push(`你是 ${character.name}。你正在和 ${finalUser}${allCharacters.length > 1 ? " 等人" : ""} 一起听音乐。`);
    if (relationsText) promptParts.push(`【人际关系】\n${relationsText}`);
    if (personaText) promptParts.push(`【人设与说话风格】\n${personaText}`);
    if (personalityText) promptParts.push(`【性格特征】\n${personalityText}`);
    promptParts.push(`【当前播放】\n歌名：《${track.title}》\n歌手：${track.artist || "未知"}\n${lyricsExcerpt ? `歌词节选：${lyricsExcerpt}` : "（无歌词）"}`);
    if (moodBlock) promptParts.push(moodBlock);
    if (recentHistory.length > 0) {
        promptParts.push(`【刚才大家的弹幕】\n` + recentHistory.map(h => `${h.characterName}：${h.text}`).join("\n"));
    }
    if (characterRecent.length > 0) {
        promptParts.push(`【禁止复读】不要重复你刚才说过的内容：\n` + characterRecent.map(t => `- ${t}`).join("\n"));
    }
    promptParts.push(`【任务】\n请随口对正在听的音乐发表 1 句简短自然的短评或弹幕感悟。\n\n【严格格式要求】\n1. 绝对严禁任何动作、神态、表情或心理描写的括号（包括圆括号、方括号等）。\n2. 不要输出引号，不要带角色名前缀。\n3. 限制在 1~2 句话内，总字数不超过 80 字，在句读处自然收尾。\n4. 严禁使用任何客服腔，称呼保持人设一致。`);

    const systemPrompt = promptParts.join("\n\n");
    let res = await simpleLLMCall(apiConfig, [{ role: "system", content: systemPrompt }, { role: "user", content: "随口发一句弹幕吧。" }]);
    let sanitized = sanitizeListenText(res.content);

    if (isListenDuplicate(sanitized, characterRecent)) {
        res = await simpleLLMCall(apiConfig, [{ role: "system", content: `${systemPrompt}\n\n【注意】刚才生成的短评与之前重复，请换个视角重新回复。` }, { role: "user", content: "随口发一句弹幕吧。" }]);
        sanitized = sanitizeListenText(res.content);
        if (isListenDuplicate(sanitized, characterRecent)) return null;
    }

    if (!sanitized) return null;
    recordListenComment(character.id, track.id, sanitized);
    return sanitized;
}

// ── 切歌决策 ──
export async function decideListenSkip(params: {
    track: MusicTrack;
    character: Character;
    playedSeconds: number;
}): Promise<{ wantSkip: boolean; reason: string }> {
    const { track, character, playedSeconds } = params;
    const apiConfig = resolveCharacterApiConfig(character);
    if (!apiConfig) return { wantSkip: false, reason: "" };

    const prompt = `你是 ${character.name}。当前这首歌《${track.title}》已经播了 ${playedSeconds} 秒。请决定是否想要切掉这首歌。如果你觉得不合心境或想换换氛围可以提议切歌。输出 JSON: {"wantSkip": true|false, "reason": "15字以内简短理由"}`;
    const res = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }]);
    try {
        const text = res.content?.replace(/```json|```/g, "").trim() || "";
        const data = JSON.parse(text);
        return { wantSkip: Boolean(data.wantSkip), reason: sanitizeListenText(data.reason) };
    } catch {
        return { wantSkip: false, reason: "" };
    }
}

// ── 一起听：边听边聊即时回应 ──
export async function generateListenChatReply(params: {
    track: MusicTrack;
    character: Character;
    userMessage: string;
    allCharacters: Character[];
    userLabel?: string;
}): Promise<string | null> {
    const { track, character, userMessage, allCharacters, userLabel } = params;

    if (!character.persona && !character.personality) {
        throw new Error(`[ListenTogether] 角色 [${character.name}] persona 与 personality 双空`);
    }

    const apiConfig = resolveCharacterApiConfig(character);
    if (!apiConfig) {
        throw new Error(`[ListenTogether] 角色 [${character.name}] 未绑定可用的 API 配置`);
    }

    const userIdent = resolveUserIdentity(character.id);
    const finalUser = userLabel || userIdent?.name || "你";
    const cleanInput = userMessage.trim().slice(0, BUBBLE_MAX_CHARS);

    const relations = formatCharacterRelationsForPrompt(character.id);
    const trimmedP = trimPersona(character.persona || "", 1200);
    const personaText = renderUserNameMacro(trimmedP, finalUser);
    const personalityText = renderUserNameMacro(character.personality || "", finalUser);
    const relationsText = renderUserNameMacro(relations || "", finalUser);

    const rawLyrics = (track.lyrics || "")
        .replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const lyricsExcerpt = rawLyrics.slice(0, 240);

    const moodBlock = buildMoodBlock(character, track.id);
    const history = loadListenHistory(track.id);
    const recentHistory = history.slice(-5);
    const characterRecent = history.filter(h => h.characterId === character.id).slice(-4).map(h => h.text);

    const promptParts: string[] = [];
    promptParts.push(`你是 ${character.name}。你正在和 ${finalUser}${allCharacters.length > 1 ? " 等人" : ""} 一起听音乐。`);
    if (relationsText) promptParts.push(`【人际关系】\n${relationsText}`);
    if (personaText) promptParts.push(`【人设与说话风格】\n${personaText}`);
    if (personalityText) promptParts.push(`【性格特征】\n${personalityText}`);
    promptParts.push(`【当前播放】\n歌名：《${track.title}》\n歌手：${track.artist || "未知"}\n${lyricsExcerpt ? `歌词节选：${lyricsExcerpt}` : "（无歌词或纯音乐）"}`);
    if (moodBlock) promptParts.push(moodBlock);
    if (recentHistory.length > 0) {
        promptParts.push(`【刚才大家的弹幕】\n` + recentHistory.map(h => `${h.characterName}：${h.text}`).join("\n"));
    }
    if (characterRecent.length > 0) {
        promptParts.push(`【禁止复读】不要重复你刚才说过的内容：\n` + characterRecent.map(t => `- ${t}`).join("\n"));
    }
    promptParts.push(`【任务】\n${finalUser} 刚才在听这首歌时对大家说了：\n"${cleanInput}"\n\n请根据你的人设性格、与 ${finalUser} 的关系，结合此时的听歌氛围，简短回复 1 句话。\n\n【严格格式要求】\n1. 绝对严禁动作、神态、表情或心理描写的括号（包括圆括号、方括号、星号等任何舞台动作）。\n2. 不要输出引号，不要带角色名前缀。\n3. 限制在 1~2 句话内，总字数不超过 80 字，在句读处自然收束。\n4. 严禁使用客服腔，严禁出现生硬的“主人”等非设定称呼。`);

    const systemPrompt = promptParts.join("\n\n");
    let res = await simpleLLMCall(apiConfig, [{ role: "system", content: systemPrompt }, { role: "user", content: cleanInput }]);
    let sanitized = sanitizeListenText(res.content);

    if (isListenDuplicate(sanitized, characterRecent)) {
        res = await simpleLLMCall(apiConfig, [{ role: "system", content: `${systemPrompt}\n\n【注意】刚才生成的回复与你之前的内容重复，请换个视角重新回复 1 句。` }, { role: "user", content: cleanInput }]);
        sanitized = sanitizeListenText(res.content);
        if (isListenDuplicate(sanitized, characterRecent)) return null;
    }

    if (!sanitized) return null;

    const replyMsg: ListenTogetherMessage = {
        id: `reply-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        characterId: character.id,
        characterName: character.name,
        avatar: character.avatar,
        text: sanitized,
        timestamp: Date.now(),
    };
    appendListenHistory(track.id, replyMsg);
    return sanitized;
}
