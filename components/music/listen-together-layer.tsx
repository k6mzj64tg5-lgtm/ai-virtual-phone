// components/music/listen-together-layer.tsx — 「一起听」实时互动层
// 挂在音乐播放器之上（非阻塞）：右下角浮起角色点评气泡（弹幕），支持用户即时插话与角色回话
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MusicTrack } from "@/lib/music-storage";
import type { Character } from "@/lib/character-types";
import {
    generateListenComment,
    generateListenChatReply,
    appendUserListenComment,
    markListenHeard,
    BUBBLE_MAX_CHARS,
    type ListenTogetherMessage,
} from "@/lib/music-listen-together";
import { resolveUserIdentity } from "@/lib/settings-storage";

interface ListenTogetherLayerProps {
    track: MusicTrack;
    currentTime?: number;
    characterIds: string[];
    allCharacters: Character[];
    intervalMin?: number;
    intervalMax?: number;
    onSkipTrack?: () => void;
}

interface ActiveBubble extends ListenTogetherMessage {
    fadeout?: boolean;
}

const BUBBLE_TTL_MS = 7000;
const MAX_BUBBLES = 5;

export default function ListenTogetherLayer({
    track,
    currentTime = 0,
    characterIds,
    allCharacters,
    intervalMin = 15,
    intervalMax = 30,
    onSkipTrack,
}: ListenTogetherLayerProps) {
    const [bubbles, setBubbles] = useState<ActiveBubble[]>([]);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // 聊天插话相关状态
    const [chatInput, setChatInput] = useState("");
    const [isInputExpanded, setIsInputExpanded] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // 参与角色的完整对象
    const activeCharacters = useMemo(() => {
        const charMap = new Map(allCharacters.map((c) => [c.id, c]));
        return characterIds
            .map((id) => charMap.get(id))
            .filter((c): c is Character => Boolean(c));
    }, [allCharacters, characterIds]);

    // 当前用户名
    const currentUserName = useMemo(() => {
        const firstCharId = activeCharacters[0]?.id;
        const identity = resolveUserIdentity(firstCharId);
        return identity?.name || "我";
    }, [activeCharacters]);

    // 压入弹幕气泡
    const pushBubble = useCallback((msg: ListenTogetherMessage) => {
        setBubbles((prev) => {
            const next = [...prev, msg];
            if (next.length > MAX_BUBBLES) {
                return next.slice(next.length - MAX_BUBBLES);
            }
            return next;
        });

        setTimeout(() => {
            setBubbles((current) => current.filter((b) => b.id !== msg.id));
        }, BUBBLE_TTL_MS);
    }, []);

    // 记录听歌历史
    useEffect(() => {
        if (!track?.id || activeCharacters.length === 0) return;
        for (const char of activeCharacters) {
            markListenHeard(char.id, track.id);
        }
    }, [track?.id, activeCharacters]);

    // 自动轮询闲聊发言
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const trackRef = useRef(track);
    trackRef.current = track;

    const scheduleNextTick = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (activeCharacters.length === 0) return;

        const minMs = Math.max(5, intervalMin) * 1000;
        const maxMs = Math.max(minMs + 2000, intervalMax * 1000);
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

        timerRef.current = setTimeout(async () => {
            const currentT = trackRef.current;
            if (!currentT) return;

            const eligible = activeCharacters.filter((c) => c.persona || c.personality);
            if (eligible.length === 0) return;

            const speaker = eligible[Math.floor(Math.random() * eligible.length)];

            try {
                const comment = await generateListenComment({
                    track: currentT,
                    character: speaker,
                    allCharacters: activeCharacters,
                });

                if (comment) {
                    pushBubble({
                        id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        characterId: speaker.id,
                        characterName: speaker.name,
                        avatar: speaker.avatar,
                        text: comment,
                        timestamp: Date.now(),
                    });
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn("[ListenTogether] 自动短评生成异常:", message);
            } finally {
                scheduleNextTick();
            }
        }, delay);
    }, [activeCharacters, intervalMin, intervalMax, pushBubble]);

    useEffect(() => {
        scheduleNextTick();
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [scheduleNextTick]);

    // 发送用户聊天插话
    const handleSendChat = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        const text = chatInput.trim().slice(0, BUBBLE_MAX_CHARS);
        if (!text || isSubmitting || !track) return;

        setIsSubmitting(true);
        setChatInput("");
        setIsInputExpanded(false);

        try {
            // 1. 同步写入 IndexedDB 历史
            const userMsg = appendUserListenComment(track.id, currentUserName, text);

            // 2. 本地弹幕即刻上屏回显
            pushBubble(userMsg);

            // 3. 挑选一位有效角色回应
            const eligible = activeCharacters.filter((c) => c.persona || c.personality);
            if (eligible.length === 0) return;

            const responder = eligible[Math.floor(Math.random() * eligible.length)];

            // 稍作模拟思考延迟
            setTimeout(async () => {
                try {
                    const replyText = await generateListenChatReply({
                        track,
                        character: responder,
                        userMessage: text,
                        allCharacters: activeCharacters,
                        userLabel: currentUserName,
                    });

                    if (replyText) {
                        pushBubble({
                            id: `reply-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            characterId: responder.id,
                            characterName: responder.name,
                            avatar: responder.avatar,
                            text: replyText,
                            timestamp: Date.now(),
                        });
                    }
                } catch (err) {
                    console.error("[ListenTogether] 角色回复失败:", err);
                }
            }, 700);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "插话发送失败";
            setErrorMsg(msg);
            setTimeout(() => setErrorMsg(null), 3000);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="lt-layer" aria-label="一起听互动层">
            {/* 顶部常驻状态条：严格使用 --page-header-safe-top 避开播放器头部 */}
            <div className="lt-live-bar">
                <span className="lt-live-badge">一起听</span>
                <span className="lt-live-count">{activeCharacters.length} 人在听</span>
            </div>

            {/* 错误提示浮层 */}
            {errorMsg && <div className="lt-layer-error">{errorMsg}</div>}

            {/* 右下角弹幕气泡堆叠容器 */}
            <div className="lt-bubbles-container">
                {bubbles.map((b) => (
                    <div
                        key={b.id}
                        className={`lt-bubble ${b.isUser ? "lt-bubble-user" : ""}`}
                    >
                        {!b.isUser && b.avatar && (
                            <img
                                src={b.avatar}
                                alt={b.characterName}
                                className="lt-bubble-avatar"
                            />
                        )}
                        <div className="lt-bubble-content">
                            <span className="lt-bubble-name">{b.characterName}</span>
                            <span className="lt-bubble-text">{b.text}</span>
                        </div>
                    </div>
                ))}
            </div>

            {/* 底部聊天插话区：局部 pointer-events: auto */}
            <div className="lt-chat-section">
                {isInputExpanded ? (
                    <form className="lt-chat-form" onSubmit={handleSendChat}>
                        <input
                            ref={inputRef}
                            type="text"
                            className="lt-chat-input"
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            placeholder="和大家聊聊这首歌..."
                            maxLength={BUBBLE_MAX_CHARS}
                            autoFocus
                            disabled={isSubmitting}
                        />
                        <button
                            type="submit"
                            className="lt-chat-submit-btn"
                            disabled={!chatInput.trim() || isSubmitting}
                        >
                            发送
                        </button>
                        <button
                            type="button"
                            className="lt-chat-close-btn"
                            onClick={() => {
                                setIsInputExpanded(false);
                                setChatInput("");
                            }}
                        >
                            ✕
                        </button>
                    </form>
                ) : (
                    <button
                        type="button"
                        className="lt-chat-trigger-btn"
                        onClick={() => {
                            setIsInputExpanded(true);
                            setTimeout(() => inputRef.current?.focus(), 50);
                        }}
                    >
                        <span className="lt-chat-trigger-icon">💬</span>
                        <span className="lt-chat-trigger-text">插话聊一句...</span>
                    </button>
                )}
            </div>
        </div>
    );
}
